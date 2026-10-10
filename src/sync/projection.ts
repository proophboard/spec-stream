/**
 * Projection runtime: owns the in-memory {@link ModelState} and keeps the local file tree
 * in sync with the prooph board changelog.
 *
 * Lifecycle:
 *   1. `seed()` — build the initial model from the REST API (or rebuild on demand) and
 *      write the full tree once.
 *   2. `handle(event)` — apply each incoming changelog event to the model and schedule a
 *      **debounced** write pass so a burst of events collapses into a single disk sync.
 *   3. After each successful write pass, the sync cursor (`sync-state.json`) is advanced to
 *      the last applied event. On restart, missed events are replayed from this cursor;
 *      because `applyEvent` + diff-based `writeTree` are idempotent, re-applying a few
 *      already-reflected events is harmless.
 *
 * The projection applies **all** events, including spec-stream's own API-key user's writes,
 * so the mirror self-heals after an agent writes back via MCP. (Self-event filtering is a
 * command-rule concern, not a projection concern.)
 *
 * No command execution here — this is purely the read-replica materializer.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import type { ChangelogEvent } from "../realtime/events.js";
import type { Logger } from "../logging/logger.js";
import { type ModelState, emptyModel } from "./model.js";
import { applyEvent } from "./reducer.js";
import { render } from "./render.js";
import { writeTree, type WriteResult } from "./writer.js";
import { seedModel } from "./seed.js";
import type { RestClient } from "./restClient.js";
import { buildManifestFromTree, saveManifest, syncManifestPath } from "../sync-back/manifest.js";

export interface SyncState {
  workspaceId: string;
  cursor: { lastEventId?: string; lastCreatedAt?: string };
  schemaVersion: number;
  syncedAt: string;
}

const SCHEMA_VERSION = 1;
const DEFAULT_DEBOUNCE_MS = 250;

export interface Timers {
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (h: ReturnType<typeof setTimeout>) => void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
};

export interface ProjectionOptions {
  /** Absolute model directory (localSync.dir resolved against configDir). */
  dir: string;
  workspaceId: string;
  workspaceName: string;
  client: RestClient;
  logger: Logger;
  /** Rebuild from a fresh fetch on start, ignoring any existing tree/cursor. */
  rebuildOnStart?: boolean;
  /** Commit each write pass to a git repo in `dir`. */
  git?: boolean;
  /** Debounce window for coalescing writes (ms). */
  debounceMs?: number;
  timers?: Timers;
  /** Injectable committer for testing git integration without spawning git. */
  commit?: (dir: string, message: string) => void;
}

export class Projection {
  private state: ModelState;
  private readonly dir: string;
  private readonly statePath: string;
  private readonly log: Logger;
  private readonly client: RestClient;
  private readonly timers: Timers;
  private readonly debounceMs: number;
  private readonly git: boolean;
  private readonly commit?: (dir: string, message: string) => void;

  private writeTimer?: ReturnType<typeof setTimeout>;
  private pendingCursor: { lastEventId?: string; lastCreatedAt?: string } = {};
  private appliedSinceWrite = 0;
  private seeded = false;

  constructor(private readonly opts: ProjectionOptions) {
    this.dir = opts.dir;
    this.statePath = join(opts.dir, "sync-state.json");
    this.log = opts.logger;
    this.client = opts.client;
    this.timers = opts.timers ?? realTimers;
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.git = opts.git ?? false;
    this.commit = opts.commit;
    this.state = emptyModel(opts.workspaceId, opts.workspaceName);
  }

  /** Read the persisted cursor, if any (used by the app to replay missed events). */
  readSyncState(): SyncState | undefined {
    try {
      if (!existsSync(this.statePath)) return undefined;
      const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as SyncState;
      if (parsed.schemaVersion !== SCHEMA_VERSION) return undefined; // force rebuild
      if (parsed.workspaceId !== this.opts.workspaceId) return undefined; // different workspace
      return parsed;
    } catch {
      return undefined;
    }
  }

  /**
   * The ISO timestamp the app should use as the initial reconnect-catch-up watermark on a
   * cold start: the persisted cursor's `lastCreatedAt`, if a valid state file exists for
   * this workspace. Returns undefined when there's no usable cursor (first run, schema
   * bump, or `rebuildOnStart`), in which case the watermark is established by the first
   * live event instead.
   */
  startupWatermark(): string | undefined {
    if (this.opts.rebuildOnStart) return undefined;
    return this.readSyncState()?.cursor.lastCreatedAt;
  }

  /**
   * Seed the model from the REST API and write the full tree once. Always safe to call —
   * the tree is a replica. Returns the write result for logging.
   *
   * REST returns current authoritative state, so a cold-start seed is itself a complete
   * catch-up (no changelog gap can be missed). The persisted cursor is carried forward as
   * the startup watermark (see {@link startupWatermark}) so the first reconnect's `since`
   * is well-defined even before any live event arrives.
   */
  async seed(): Promise<WriteResult> {
    const prior = this.startupWatermark();
    this.log.info("sync.seed_start", {
      dir: this.dir,
      rebuild: this.opts.rebuildOnStart ?? false,
      resumedFromCursor: prior !== undefined,
    });
    this.state = await seedModel(this.client, this.opts.workspaceId, this.opts.workspaceName);
    // Preserve the prior cursor so the post-seed write doesn't reset the watermark to empty.
    if (prior !== undefined) {
      const existing = this.readSyncState();
      this.pendingCursor = {
        lastEventId: existing?.cursor.lastEventId,
        lastCreatedAt: prior,
      };
    }
    const result = this.flushWrite();
    this.seeded = true;
    this.log.info("sync.seed_done", {
      chapters: this.state.chapters.size,
      slices: this.state.slices.size,
      elements: this.state.elements.size,
      milestones: this.state.milestones.size,
      ...result,
    });
    return result;
  }

  /** Apply an event and schedule a debounced write pass. */
  handle(event: ChangelogEvent): void {
    applyEvent(this.state, event);
    this.appliedSinceWrite++;
    // Track the furthest cursor we've applied; persisted only after a successful write.
    this.pendingCursor = { lastEventId: event.id, lastCreatedAt: event.createdAt };
    this.scheduleWrite();
  }

  private scheduleWrite(): void {
    if (this.writeTimer) return; // a flush is already pending
    this.writeTimer = this.timers.setTimeout(() => {
      this.writeTimer = undefined;
      try {
        this.flushWrite();
      } catch (err) {
        // A write failure must not stop the stream; the next event retries.
        this.log.error("sync.write_failed", { message: (err as Error).message });
      }
    }, this.debounceMs);
  }

  /**
   * Render the current state and write it to disk, then advance + persist the cursor and
   * optionally commit. Synchronous so a crash can't interleave a half-written tree with a
   * cursor advance.
   */
  private flushWrite(): WriteResult {
    const applied = this.appliedSinceWrite;
    const tree = render(this.state);
    const result = writeTree(this.dir, tree);
    this.appliedSinceWrite = 0;

    // Advance the cursor only after a successful write pass.
    this.persistCursor();

    // Write sync-manifest.json so sync-back can determine create-vs-update without git.
    // Failures are non-fatal — the model write already succeeded.
    try {
      const manifest = buildManifestFromTree(tree);
      saveManifest(syncManifestPath(this.dir), manifest);
    } catch (err) {
      this.log.warn("sync.manifest_write_failed", { message: (err as Error).message });
    }

    if (result.created + result.updated + result.deleted > 0) {
      this.log.info("sync.write", { appliedEvents: applied, ...result });
      if (this.git) this.gitCommit(result);
    } else {
      this.log.debug("sync.write_noop", { appliedEvents: applied });
    }
    return result;
  }

  private persistCursor(): void {
    const state: SyncState = {
      workspaceId: this.opts.workspaceId,
      cursor: this.pendingCursor,
      schemaVersion: SCHEMA_VERSION,
      syncedAt: new Date().toISOString(),
    };
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(this.statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
  }

  private gitCommit(result: WriteResult): void {
    const message = `spec-stream sync: +${result.created} ~${result.updated} -${result.deleted}`;
    try {
      (this.commit ?? defaultCommit)(this.dir, message);
    } catch (err) {
      this.log.warn("sync.git_failed", { message: (err as Error).message });
    }
  }

  /** Flush any pending debounced write immediately (used on graceful stop). */
  flushNow(): void {
    if (this.writeTimer) {
      this.timers.clearTimeout(this.writeTimer);
      this.writeTimer = undefined;
    }
    if (this.appliedSinceWrite > 0) this.flushWrite();
  }

  /** For tests/status. */
  get isSeeded(): boolean {
    return this.seeded;
  }
  snapshot() {
    return {
      chapters: this.state.chapters.size,
      slices: this.state.slices.size,
      elements: this.state.elements.size,
      milestones: this.state.milestones.size,
      pendingWrites: this.appliedSinceWrite,
    };
  }
}

/** Default git committer: stage all and commit, ignoring "nothing to commit". */
function defaultCommit(dir: string, message: string): void {
  const run = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir, stdio: "ignore" });
  } catch {
    run(["init"]);
  }
  run(["add", "-A"]);
  try {
    run(["commit", "-m", message]);
  } catch {
    // nothing to commit — ignore
  }
}
