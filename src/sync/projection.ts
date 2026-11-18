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
import { applyEvent, type DirtySet, emptyDirtySet, mergeDirty } from "./reducer.js";
import { render, renderPartial } from "./render.js";
import { writeTree, type WriteResult, readIfExists } from "./writer.js";
import { seedModel, freshSeedProgress, type SeedProgress } from "./seed.js";
import { loadFromDisk } from "./loader.js";
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

  /** Absolute path to the sync-back lock file (.spec-stream/sync-back-lock). */
  private readonly syncBackLockFile: string;

  private writeTimer?: ReturnType<typeof setTimeout>;
  private pendingCursor: { lastEventId?: string; lastCreatedAt?: string } = {};
  private appliedSinceWrite = 0;
  /** Accumulated dirty set across the current debounce window. Reset after each write. */
  private pendingDirty: DirtySet = emptyDirtySet();
  private seeded = false;
  private unseededWarned = false;
  /** True while `seedFromRest` awaits the REST fetch — handle() buffers in the meantime. */
  private seedFetchInFlight = false;
  /** Live events buffered while a seed fetch was in flight (see {@link seedFromRest}). */
  private eventsDuringSeed: ChangelogEvent[] = [];
  /**
   * Checkpoint of the in-flight REST seed. Set when a seed attempt fails
   * mid-fetch so the next `seed()` call resumes at the failed chapter instead
   * of re-downloading the whole snapshot — the data is at most seconds old.
   * Cleared once a seed completes.
   */
  private seedProgress?: SeedProgress;

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
    // The lock file lives in the .spec-stream/ state directory, one level above the
    // model directory (e.g. <project>/.spec-stream/sync-back-lock).
    this.syncBackLockFile = join(dirname(opts.dir), "sync-back-lock");
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
   * Check if a valid local model exists (sync-state.json present and valid).
   */
  hasValidLocalModel(): boolean {
    const state = this.readSyncState();
    if (!state) return false;
    // Also verify the model files exist (at least workspace.json)
    const workspacePath = join(this.dir, "workspace.json");
    return existsSync(workspacePath);
  }

  /**
   * Seed the model from the REST API or from disk, and write the full tree once.
   * Returns the write result for logging.
   *
   * Behavior:
   * - If rebuildOnStart is true: always fetch from REST
   * - If sync-state.json exists and is valid: load from disk (skip REST)
   * - Otherwise: fetch from REST (first run)
   *
   * REST returns current authoritative state, so a cold-start seed is itself a complete
   * catch-up (no changelog gap can be missed). The persisted cursor is carried forward as
   * the startup watermark (see {@link startupWatermark}) so the first reconnect's `since`
   * is well-defined even before any live event arrives.
   */
  async seed(rebuild: boolean = this.opts.rebuildOnStart ?? false): Promise<WriteResult> {
    // If rebuild is requested, always fetch from REST
    if (rebuild) {
      this.log.info("sync.seed_start", {
        dir: this.dir,
        rebuild: true,
        resumedFromCursor: false,
        note: "Rebuilding model from REST API",
      });
      await this.seedFromRest(() => {
        this.pendingCursor = {};
      });
    } else {
      // Check if we have a valid local model
      const prior = this.startupWatermark();
      const restorePriorCursor = () => {
        if (prior !== undefined) {
          this.pendingCursor = {
            lastEventId: this.readSyncState()?.cursor.lastEventId,
            lastCreatedAt: prior,
          };
        }
      };

      if (this.hasValidLocalModel()) {
        // Load from disk instead of REST
        const loaded = loadFromDisk(this.dir, this.opts.workspaceId, this.opts.workspaceName);
        if (loaded) {
          this.state = loaded;
          // Preserve the prior cursor
          restorePriorCursor();
          this.log.info("sync.seed_start", {
            dir: this.dir,
            rebuild: false,
            resumedFromCursor: prior !== undefined,
            chapters: this.state.chapters.size,
            slices: this.state.slices.size,
            elements: this.state.elements.size,
            milestones: this.state.milestones.size,
            note: "Loaded existing model from disk, resuming from cursor",
          });
        } else {
          // Fallback: fetch from REST if disk load fails
          this.log.info("sync.seed_start", {
            dir: this.dir,
            rebuild: false,
            resumedFromCursor: prior !== undefined,
            note: "Disk load failed, fetching from REST API",
          });
          await this.seedFromRest(restorePriorCursor);
        }
      } else {
        // No local model - fetch from REST (first run)
        this.log.info("sync.seed_start", {
          dir: this.dir,
          rebuild: false,
          resumedFromCursor: false,
          note: "First run, fetching from REST API",
        });
        await this.seedFromRest(restorePriorCursor);
      }
    }

    // The model is now authoritative: mark seeded BEFORE the initial write so a
    // failed fetch can never reach this point (state stays `emptyModel`,
    // `seeded` stays false, and every write path below refuses to run).
    this.seeded = true;
    this.unseededWarned = false;
    const result = this.flushWrite(true);
    this.log.info("sync.seed_done", {
      chapters: this.state.chapters.size,
      slices: this.state.slices.size,
      elements: this.state.elements.size,
      milestones: this.state.milestones.size,
      ...result,
      note: result.created + result.updated + result.deleted > 0
        ? `Tree updated: +${result.created} ~${result.updated} -${result.deleted} files`
        : "No changes, tree unchanged",
    });
    return result;
  }

  /**
   * Fetch a fresh model via REST and swap it into `this.state`. Live events that
   * arrive while the fetch is in flight are buffered and replayed onto the NEW
   * state — without this, they would be applied to the about-to-be-replaced state
   * and silently discarded (while the cursor could still claim they were seen,
   * and the reconnect dedupe set would drop them on replay).
   *
   * `restoreCursor` runs after a successful fetch and before the buffered events
   * are replayed, so replayed events still advance the cursor past the restored
   * value. On fetch failure the buffered events are applied to the pre-seed state
   * through the normal path — they are live events, not seed data.
   */
  private async seedFromRest(restoreCursor: () => void): Promise<void> {
    this.seedFetchInFlight = true;
    let newState: ModelState;
    try {
      newState = await seedModel(
        this.client,
        this.opts.workspaceId,
        this.opts.workspaceName,
        (this.seedProgress ??= freshSeedProgress()),
      );
    } catch (err) {
      this.seedFetchInFlight = false;
      const buffered = this.eventsDuringSeed;
      this.eventsDuringSeed = [];
      for (const event of buffered) this.handle(event);
      throw err;
    }
    this.seedFetchInFlight = false;
    this.seedProgress = undefined;
    restoreCursor();
    const buffered = this.eventsDuringSeed;
    this.eventsDuringSeed = [];
    for (const event of buffered) {
      const dirty = emptyDirtySet();
      applyEvent(newState, event, dirty);
      mergeDirty(this.pendingDirty, dirty);
      this.appliedSinceWrite++;
      this.pendingCursor = { lastEventId: event.id, lastCreatedAt: event.createdAt };
    }
    this.state = newState;
  }

  /** Apply an event and schedule a debounced write pass. */
  handle(event: ChangelogEvent): void {
    // A REST seed is in flight: the event must be replayed onto the new state
    // once it lands, not applied to the state that is about to be replaced.
    if (this.seedFetchInFlight) {
      this.eventsDuringSeed.push(event);
      return;
    }
    const eventDirty = emptyDirtySet();
    applyEvent(this.state, event, eventDirty);
    mergeDirty(this.pendingDirty, eventDirty);
    this.appliedSinceWrite++;
    // Track the furthest cursor we've applied; persisted only after a successful write.
    this.pendingCursor = { lastEventId: event.id, lastCreatedAt: event.createdAt };
    this.scheduleWrite();
  }

  private scheduleWrite(): void {
    if (this.writeTimer) return; // a flush is already pending
    // If sync-back is currently running, do not write — the files it has already written
    // would be overwritten with stale content from our in-memory model. Instead, poll
    // until the lock is gone, then let the normal debounce fire. By the time the lock
    // clears, the board will have echoed sync-back's changes as changelog events and our
    // handle() calls will have applied them to the in-memory model, so the next write
    // will produce the correct tree.
    if (existsSync(this.syncBackLockFile)) {
      this.log.debug("sync.write_deferred", { reason: "sync-back lock held" });
      this.writeTimer = this.timers.setTimeout(() => {
        this.writeTimer = undefined;
        this.scheduleWrite(); // re-check; either flush or defer again
      }, this.debounceMs);
      return;
    }
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
   *
   * Uses `renderPartial` when called from `handle()` (incremental event-driven write) so
   * only files belonging to entities touched by the applied events are written. This
   * protects locally-modified files for unrelated entities from being overwritten.
   *
   * Uses a full `render` only during `seed()` (initial build or explicit rebuild), where
   * the entire tree must be consistent from scratch.
   */
  private flushWrite(full = false): WriteResult {
    // A model that has never been seeded must not write: with `emptyModel` in
    // memory, `renderPartial`'s unconditional workspace.json/uuid-index.json
    // would trigger a manifest rebuild that clobbers `sync-manifest.json` to
    // `entities: {}` and empties `uuid-index.json` — while `sync-state.json`
    // would advance a cursor the model never earned. A stale mirror is strictly
    // better than a confidently empty index (see sync-back create-storm).
    if (!this.seeded) {
      const detail = { reason: "model never seeded — writes disabled until a seed succeeds" };
      if (!this.unseededWarned) {
        this.unseededWarned = true;
        this.log.warn("sync.write_skipped", detail);
      } else {
        this.log.debug("sync.write_skipped", detail);
      }
      return {
        created: 0, updated: 0, deleted: 0, unchanged: 0,
        byType: {
          chapters: 0, slices: 0, lanes: 0, elements: 0,
          milestones: 0, scenarios: 0, htmlSnippets: 0,
          contentFiles: 0, manifests: 0, stateFiles: 0, other: 0,
        },
        changedFiles: [], filesAdded: [], filesModified: [], filesDeleted: [],
      };
    }
    const applied = this.appliedSinceWrite;

    // Capture and reset the dirty set before rendering so any events that arrive
    // concurrently during the (synchronous) render/write are queued into a fresh set.
    const dirty = this.pendingDirty;
    this.pendingDirty = emptyDirtySet();
    this.appliedSinceWrite = 0;

    let tree: import("./render.js").DesiredTree;
    let dirsToDelete: Set<string> | undefined;
    if (full) {
      tree = render(this.state);
    } else {
      const partial = renderPartial(this.state, dirty);
      tree = partial.tree;
      dirsToDelete = partial.dirsToDelete;
    }
    const result = writeTree(this.dir, tree, { partial: !full, dirsToDelete });

    // A full write mirrors the tree exactly: every file under `dir` that the model
    // does not render is deleted — including foreign files a user may have placed
    // there. Surface those deletions loudly instead of hiding them inside the
    // `deleted` counter (issue proophboard/spec-stream#6). `.git` directories are
    // never touched (see writer.ts).
    if (full && result.filesDeleted.length > 0) {
      const MAX_LISTED = 20;
      this.log.warn("sync.prune", {
        dir: this.dir,
        count: result.filesDeleted.length,
        files: result.filesDeleted.slice(0, MAX_LISTED),
        ...(result.filesDeleted.length > MAX_LISTED
          ? { truncated: result.filesDeleted.length - MAX_LISTED }
          : {}),
        note: "deleted files that are not part of the board model — the localSync dir is exclusively managed",
      });
    }

    // Check if we need to update the sync state (cursor)
    const needsStateUpdate = this.needsStateUpdate();

    // Write sync-manifest.json so sync-back can determine create-vs-update without git.
    // For partial writes we still need to update the manifest entries for touched entities.
    // The simplest correct approach: always rebuild the manifest from the full render after
    // any change, so it stays consistent. The manifest is small and the full render is
    // cheap compared to disk I/O.
    const needsManifestUpdate = result.created + result.updated + result.deleted > 0;
    if (needsManifestUpdate) {
      try {
        const fullTree = full ? tree : render(this.state);
        const manifest = buildManifestFromTree(fullTree);
        const manifestPath = syncManifestPath(this.dir);
        const existingManifest = readIfExists(manifestPath);
        const newManifest = JSON.stringify(manifest, null, 2) + "\n";
        if (existingManifest !== newManifest) {
          saveManifest(manifestPath, manifest);
        }
      } catch (err) {
        this.log.warn("sync.manifest_write_failed", { message: (err as Error).message });
      }
    }

    // Only advance the cursor and write sync-state.json if there were changes
    // OR if this is the initial seed (no prior state exists).
    if (needsStateUpdate || !this.hasValidLocalModel()) {
      // Check if sync-state content actually changed before writing
      const syncStatePath = this.statePath;
      const existingState = readIfExists(syncStatePath);
      const newState: SyncState = {
        workspaceId: this.opts.workspaceId,
        cursor: this.pendingCursor,
        schemaVersion: SCHEMA_VERSION,
        syncedAt: new Date().toISOString(),
      };
      const newStateStr = JSON.stringify(newState, null, 2) + "\n";
      if (existingState !== newStateStr) {
        this.persistCursor();
        result.byType.stateFiles++;
      }
    }

    // Log meaningful writes (not just manifest/state rewrites on unchanged trees)
    const meaningfulChange = result.changedFiles.some(
      f => !f.endsWith("/sync-state.json") && !f.endsWith("sync-manifest.json")
    );

    if (meaningfulChange || result.created + result.updated + result.deleted > 0) {
      this.log.info("sync.write", {
        appliedEvents: applied,
        created: result.created,
        updated: result.updated,
        deleted: result.deleted,
        unchanged: result.unchanged,
        byType: result.byType,
        changedFiles: result.changedFiles,
        filesAdded: result.filesAdded,
        filesModified: result.filesModified,
        filesDeleted: result.filesDeleted,
      });
      if (this.git) this.gitCommit(result);
    } else {
      this.log.debug("sync.write_noop", { appliedEvents: applied });
    }
    return result;
  }

  /** Check if the sync state needs to be updated based on the pending cursor. */
  private needsStateUpdate(): boolean {
    const existing = this.readSyncState();
    if (!existing) return true; // No existing state, need to write

    const pending = this.pendingCursor;
    if (!pending.lastEventId && !pending.lastCreatedAt) return false; // Nothing new

    // Update if we have a newer event
    if (pending.lastEventId && existing.cursor.lastEventId !== pending.lastEventId) {
      return true;
    }
    if (pending.lastCreatedAt && existing.cursor.lastCreatedAt !== pending.lastCreatedAt) {
      return true;
    }
    return false;
  }

  private persistCursor(): void {
    // Never persist a cursor the model didn't earn — an unseeded projection has
    // applied events to `emptyModel` only, so writing the cursor would claim
    // sync progress the on-disk mirror doesn't have.
    if (!this.seeded) {
      this.log.debug("sync.cursor_skipped", { reason: "model never seeded" });
      return;
    }
    const state: SyncState = {
      workspaceId: this.opts.workspaceId,
      cursor: this.pendingCursor,
      schemaVersion: SCHEMA_VERSION,
      syncedAt: new Date().toISOString(),
    };
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(this.statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
  }

  /** Force an immediate cursor-only write to sync-state.json. */
  flushCursor(): void {
    if (this.pendingCursor.lastEventId || this.pendingCursor.lastCreatedAt) {
      const existing = this.readSyncState();
      if (!existing || existing.cursor.lastEventId !== this.pendingCursor.lastEventId || existing.cursor.lastCreatedAt !== this.pendingCursor.lastCreatedAt) {
        this.persistCursor();
      }
    }
  }

  /** Update the pending cursor (for use after catch-up). */
  updateCursor(eventId: string | undefined, createdAt: string | undefined): void {
    this.pendingCursor = { lastEventId: eventId, lastCreatedAt: createdAt };
  }

  private gitCommit(result: WriteResult): void {
    const msgParts: string[] = [`spec-stream sync: +${result.created} ~${result.updated} -${result.deleted}`];

    // Add breakdown by type if there were changes
    const byType = result.byType;
    const typeChanges: string[] = [];

    if (byType.chapters > 0) typeChanges.push(`chapters:${byType.chapters}`);
    if (byType.slices > 0) typeChanges.push(`slices:${byType.slices}`);
    if (byType.lanes > 0) typeChanges.push(`lanes:${byType.lanes}`);
    if (byType.elements > 0) typeChanges.push(`elements:${byType.elements}`);
    if (byType.milestones > 0) typeChanges.push(`milestones:${byType.milestones}`);
    if (byType.scenarios > 0) typeChanges.push(`scenarios:${byType.scenarios}`);
    if (byType.htmlSnippets > 0) typeChanges.push(`snippets:${byType.htmlSnippets}`);
    if (byType.contentFiles > 0) typeChanges.push(`content:${byType.contentFiles}`);

    if (typeChanges.length > 0) {
      msgParts.push(typeChanges.join(" "));
    }

    const message = msgParts.join(" ");
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
      seeded: this.seeded,
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
