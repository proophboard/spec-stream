/**
 * Application orchestrator: wires config → auth → realtime → router → scheduler → runner,
 * with logging and token renewal. Owns the running lifecycle (start/stop) but not the
 * process/PID concerns (that's the CLI layer).
 */

import { createClient } from "@supabase/supabase-js";
import type { SpecStreamConfig } from "./config/schema.js";
import { exchangeToken, TokenExchangeError, type RealtimeToken } from "./auth/tokenExchange.js";
import { RealtimeClient, type SupabaseLike } from "./realtime/client.js";
import type { ChangelogEvent } from "./realtime/events.js";
import { normalizeRow, type ChangelogEventRow } from "./realtime/events.js";
import { Router, type SelfIdentity } from "./routing/router.js";
import { Scheduler, type SchedulerTask } from "./scheduler/scheduler.js";
import { runCommand } from "./runner/command.js";
import { Backoff, renewAtMs } from "./util/backoff.js";
import type { Logger } from "./logging/logger.js";
import { Projection } from "./sync/projection.js";
import { RestClient, RestError } from "./sync/restClient.js";
import { RateLimiter, type RateLimiterOptions } from "./util/rateLimiter.js";
import { isAbsolute, resolve as resolvePath } from "node:path";

export interface AppOptions {
  config: SpecStreamConfig;
  apiKey: string;
  logger: Logger;
  dryRun?: boolean;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  createSupabase?: (url: string, anonKey: string) => SupabaseLike;
  /**
   * Sink for a completed command's own stdout/stderr, shown in the foreground so users
   * see what their command printed. Defaults to writing to process.stdout/stderr.
   * Pass `null` to suppress (e.g. background/daemon mode). Injectable for tests.
   */
  writeOutput?: ((stream: "stdout" | "stderr", text: string) => void) | null;
  /**
   * Rate-limiter for outbound REST calls. Injectable for tests (pass `{ minIntervalMs: 0 }`
   * to disable throttling). Defaults to 600 ms between requests.
   */
  rateLimiter?: RateLimiter | RateLimiterOptions;
}

export class App {
  private readonly config: SpecStreamConfig;
  private readonly apiKey: string;
  private readonly log: Logger;
  private readonly dryRun: boolean;
  private router: Router;
  private self: SelfIdentity = {};
  private readonly scheduler: Scheduler;
  private readonly fetchImpl: typeof fetch;
  private readonly createSupabase: (url: string, anonKey: string) => SupabaseLike;
  private readonly writeOutput: ((stream: "stdout" | "stderr", text: string) => void) | null;
  private readonly rateLimiter: RateLimiter | RateLimiterOptions | undefined;

  private realtime?: RealtimeClient;
  private token?: RealtimeToken;
  private projection?: Projection;
  private rest?: RestClient;
  private renewTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private stats = { received: 0, run: 0, failed: 0, lastEventAt: 0 };
  /** ISO timestamp of the last event we processed (for reconnect catch-up). */
  private lastEventCreatedAt?: string;
  /** Recent event ids, to dedupe the boundary overlap when replaying the gap. */
  private recentEventIds = new Set<string>();
  /** True once we've had our first successful subscribe (so later ones are reconnects). */
  private hasSubscribed = false;
  /** Guards against overlapping catch-up runs. */
  private catchingUp = false;
  /** Timestamp (Date.now()) until which catch-up is rate-limited and must not be retried. */
  private catchupRateLimitedUntil = 0;

  constructor(opts: AppOptions) {
    this.config = opts.config;
    this.apiKey = opts.apiKey;
    this.log = opts.logger;
    this.dryRun = opts.dryRun ?? false;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.createSupabase =
      opts.createSupabase ??
      ((url, anonKey) => createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } }) as unknown as SupabaseLike);
    this.writeOutput =
      opts.writeOutput === undefined
        ? (stream, text) => {
            (stream === "stdout" ? process.stdout : process.stderr).write(text);
          }
        : opts.writeOutput;
    this.rateLimiter = opts.rateLimiter;
    this.router = Router.fromConfig(this.config);
    this.scheduler = new Scheduler({
      maxConcurrent: this.config.maxConcurrent,
      runner: (task) => this.executeTask(task),
      onFiltered: (rule, event) =>
        this.log.info("rule.filtered", {
          ruleId: rule.id,
          eventType: event.type,
          reason: "when",
        }),
    });
  }

  /** Exchange the API key for a token, honoring the retry policy for transient errors. */
  private async obtainToken(): Promise<RealtimeToken> {
    const backoff = new Backoff();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await exchangeToken({
          endpoint: this.config.endpoint,
          apiKey: this.apiKey,
          fetchImpl: this.fetchImpl,
        });
      } catch (err) {
        if (err instanceof TokenExchangeError && !err.retryable) {
          throw err; // fatal (e.g. 401)
        }
        if (this.stopped) throw err;
        const delay = backoff.nextDelay();
        this.log.warn("auth.retry", {
          kind: err instanceof TokenExchangeError ? err.kind : "unknown",
          delayMs: delay,
        });
        await sleep(delay);
      }
    }
  }

  private scheduleRenewal(): void {
    if (!this.token) return;
    const at = renewAtMs(this.token.obtainedAtMs, this.token.expiresAtMs);
    const delay = Math.max(0, at - Date.now());
    this.renewTimer = setTimeout(() => void this.renew(), delay);
  }

  private async renew(): Promise<void> {
    if (this.stopped) return;
    try {
      this.token = await this.obtainToken();
      await this.realtime?.updateToken(this.token.accessToken);
      this.log.debug("auth.renewed", { expiresAt: Math.floor(this.token.expiresAtMs / 1000) });
      this.scheduleRenewal();
    } catch (err) {
      this.log.error("auth.renew_failed", { message: (err as Error).message });
      // Non-retryable (revoked) — keep the process up but report; realtime will drop.
    }
  }

  private onEvent(event: ChangelogEvent): void {
    // Dedupe: the reconnect catch-up query overlaps the live boundary by design, so an
    // event may arrive both via replay and realtime. Process each id at most once.
    if (this.recentEventIds.has(event.id)) {
      this.log.debug("event.duplicate", { eventType: event.type, id: event.id });
      return;
    }
    this.rememberEventId(event.id);

    this.stats.received++;
    this.stats.lastEventAt = Date.now();
    // Track the newest event timestamp as the catch-up watermark.
    if (!this.lastEventCreatedAt || event.createdAt > this.lastEventCreatedAt) {
      this.lastEventCreatedAt = event.createdAt;
    }
    this.log.info("event.received", {
      eventType: event.type,
      elementName: event.elementName,
      elementType: event.elementType,
    });

    // Local sync projection applies ALL events (including our own user's writes) so the
    // mirror self-heals after an agent writes back via MCP. This is independent of the
    // command-rule self-event filtering below.
    if (this.projection) {
      try {
        this.projection.handle(event);
      } catch (err) {
        this.log.error("sync.handle_failed", { message: (err as Error).message });
      }
    }

    const matches = this.router.match(event);
    if (matches.length === 0) {
      this.log.debug("event.no_match", { eventType: event.type });
      return;
    }
    for (const { rule, event: ev } of matches) {
      this.log.debug("rule.matched", { ruleId: rule.id, eventType: ev.type });
      this.scheduler.submit(rule, ev);
    }
  }

  /** Bounded LRU-ish set of recently seen event ids for reconnect dedupe. */
  private rememberEventId(id: string): void {
    this.recentEventIds.add(id);
    if (this.recentEventIds.size > 2000) {
      // Drop the oldest ~500 (insertion order is preserved by Set).
      const it = this.recentEventIds.values();
      for (let i = 0; i < 500; i++) {
        const next = it.next();
        if (next.done) break;
        this.recentEventIds.delete(next.value);
      }
    }
  }

  /**
   * Replay changelog events missed during a disconnect. Fetches events created on/after
   * the last processed timestamp and feeds them through {@link onEvent} (which dedupes the
   * boundary overlap and applies to the projection + router). Best-effort: failures are
   * logged and the live stream still resumes. Runs on each successful RE-subscribe.
   *
   * On 429 Too Many Requests: respects the `Retry-After` header (or falls back to 60 s)
   * and refuses to re-attempt until that window passes. The live realtime connection is
   * NOT closed — only the catch-up poll is suppressed until the rate limit clears.
   */
  private async catchUp(): Promise<void> {
    if (!this.rest || this.catchingUp || this.stopped) return;
    const since = this.lastEventCreatedAt;
    if (!since) return; // nothing processed yet; seed already covers initial state

    // Respect a previous rate-limit window — don't hammer the API.
    const now = Date.now();
    if (now < this.catchupRateLimitedUntil) {
      const remainingMs = this.catchupRateLimitedUntil - now;
      this.log.warn("conn.catchup_rate_limited", {
        since,
        retryInMs: remainingMs,
        message: "Skipping catch-up: still within Retry-After window.",
      });
      return;
    }

    this.catchingUp = true;
    try {
      const rows = await this.rest.fetchChangelogSince(since);
      let replayed = 0;
      for (const raw of rows) {
        const row: ChangelogEventRow = {
          id: raw.id,
          workspace_id: raw.workspace_id ?? this.token?.workspaceId ?? "",
          chapter_id: raw.chapter_id,
          element_id: raw.element_id,
          slice_id: raw.slice_id,
          user_id: raw.user_id,
          event_type: raw.event_type,
          event_data: raw.event_data,
          created_at: raw.created_at,
        };
        let event: ChangelogEvent;
        try {
          event = normalizeRow(row);
        } catch {
          continue; // skip malformed rows
        }
        if (this.recentEventIds.has(event.id)) continue; // already processed live
        this.onEvent(event);
        replayed++;
      }
      this.log.info("conn.catchup", { since, fetched: rows.length, replayed });
    } catch (err) {
      if (err instanceof RestError && err.kind === "rate_limited") {
        // Prooph board rate limit: 120 req/min or 1000 req/hr.
        // Honor the Retry-After header; default to 60 s if absent.
        const DEFAULT_RETRY_AFTER_MS = 60_000;
        const retryAfterMs = err.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
        this.catchupRateLimitedUntil = Date.now() + retryAfterMs;
        this.log.warn("conn.catchup_failed", {
          since,
          message: err.message,
          retryAfterMs,
          retryAt: new Date(this.catchupRateLimitedUntil).toISOString(),
        });
        // Do NOT close or reconnect — the live stream stays up. Catch-up will
        // be re-attempted on the next SUBSCRIBED event after the window passes.
      } else {
        this.log.warn("conn.catchup_failed", { since, message: (err as Error).message });
      }
    } finally {
      this.catchingUp = false;
    }
  }

  /** React to realtime connection-state transitions, triggering catch-up on re-subscribe. */
  private onRealtimeStatus(status: string, err?: Error): void {
    this.log.info("conn.state", { status, error: err?.message });
    if (status !== "SUBSCRIBED") return;
    if (!this.hasSubscribed) {
      // First subscribe after startup — seed already established initial state.
      this.hasSubscribed = true;
      return;
    }
    // A re-subscribe after a drop: replay the gap.
    void this.catchUp();
  }

  private async executeTask(task: SchedulerTask): Promise<void> {
    const { rule } = task;
    if (this.dryRun) {
      this.log.info("command.dry_run", {
        ruleId: rule.id,
        concurrencyKey: task.concurrencyKey,
        batchSize: task.events.length,
      });
      return;
    }
    this.log.info("command.start", {
      ruleId: rule.id,
      concurrencyKey: task.concurrencyKey,
      batchSize: task.events.length,
    });
    // Live-stream the command's output to the terminal, line-prefixed for attribution.
    const streamer = this.writeOutput ? this.makeOutputStreamer(rule.id) : undefined;
    const result = await runCommand(task, {
      config: this.config,
      processEnv: process.env,
      self: this.self,
      onOutput: streamer?.onChunk,
    });
    streamer?.flush();
    this.stats.run++;
    if (!result.ok) this.stats.failed++;
    this.log[result.ok ? "info" : "error"]("command.done", {
      ruleId: rule.id,
      ok: result.ok,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      error: result.error,
    });
  }

  /**
   * Build a stateful line-prefixer for one command run. Output arrives in arbitrary
   * chunks (not aligned to newlines), so we buffer partial lines per stream and emit a
   * `  [<ruleId>:out|err] <line>` for each complete line, flushing any remainder at the end.
   */
  private makeOutputStreamer(ruleId: string): {
    onChunk: (stream: "stdout" | "stderr", chunk: string) => void;
    flush: () => void;
  } {
    const write = this.writeOutput;
    const buffers: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
    const tag = (stream: "stdout" | "stderr") => (stream === "stdout" ? "out" : "err");
    const emitLine = (stream: "stdout" | "stderr", line: string): void => {
      write?.(stream, `  [${ruleId}:${tag(stream)}] ${line}\n`);
    };
    const onChunk = (stream: "stdout" | "stderr", chunk: string): void => {
      let buf = buffers[stream] + chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        emitLine(stream, buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
      buffers[stream] = buf;
    };
    const flush = (): void => {
      for (const stream of ["stdout", "stderr"] as const) {
        const rem = buffers[stream];
        if (rem.length > 0) emitLine(stream, rem);
        buffers[stream] = "";
      }
    };
    return { onChunk, flush };
  }

  /** Start streaming. Throws on fatal startup errors (e.g. invalid key). */
  async start(): Promise<void> {
    this.token = await this.obtainToken();
    this.self = { userId: this.token.userId, email: this.token.email };
    // Rebuild the router with our own identity so it can filter out our own writes.
    this.router = Router.fromConfig(this.config, this.self);
    this.log.info("auth.token", {
      workspaceId: this.token.workspaceId,
      selfUserId: this.self.userId,
      selfIdentified: this.self.userId !== undefined,
      expiresAt: Math.floor(this.token.expiresAtMs / 1000),
    });
    if (this.self.userId === undefined) {
      this.log.warn("auth.no_self_identity", {
        note: "token endpoint did not return user_id; own-write filtering is disabled",
      });
    }

    // Shared REST client (same pb_ key) for projection seeding and reconnect catch-up.
    this.rest = new RestClient({
      endpoint: this.config.endpoint,
      apiKey: this.apiKey,
      fetchImpl: this.fetchImpl,
      rateLimiter: this.rateLimiter,
    });

    // Seed the local-sync projection (read replica) before live events start flowing, so
    // the initial tree reflects current board state and incremental events build on it.
    if (this.config.localSync.enabled) {
      const dir = isAbsolute(this.config.localSync.dir)
        ? this.config.localSync.dir
        : resolvePath(this.config.configDir, this.config.localSync.dir);
      this.projection = new Projection({
        dir,
        workspaceId: this.token.workspaceId,
        workspaceName: this.token.workspaceId,
        client: this.rest,
        logger: this.log,
        rebuildOnStart: this.config.localSync.rebuildOnStart,
        git: this.config.localSync.git,
      });
      try {
        await this.projection.seed();
        // Carry the persisted cursor into the in-memory catch-up watermark so a reconnect
        // that happens before any live event still replays from the last synced position.
        const resumed = this.projection.startupWatermark();
        if (resumed) {
          this.lastEventCreatedAt = resumed;
          this.log.info("sync.resumed", { since: resumed });
        }
      } catch (err) {
        // Seeding failure is non-fatal: log and continue. Live events will still apply,
        // and a later rebuild can reconcile.
        this.log.error("sync.seed_failed", { message: (err as Error).message });
      }
    }

    this.realtime = new RealtimeClient({
      supabaseUrl: this.token.supabaseUrl,
      supabaseAnonKey: this.token.supabaseAnonKey,
      workspaceId: this.token.workspaceId,
      accessToken: this.token.accessToken,
      createClient: this.createSupabase,
      onEvent: (e) => this.onEvent(e),
      onStatus: (status, err) => this.onRealtimeStatus(status, err),
      onReconnectScheduled: (delayMs, attempt) =>
        this.log.warn("conn.reconnect", { delayMs, attempt }),
    });
    await this.realtime.connect();
    this.scheduleRenewal();
    this.log.info("started", { workspaceId: this.token.workspaceId, dryRun: this.dryRun });
  }

  /** Graceful stop: stop realtime, cancel pending, wait for running up to drainTimeout. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.renewTimer) clearTimeout(this.renewTimer);
    await this.realtime?.disconnect();
    // Persist any pending debounced projection write before shutting down.
    try {
      this.projection?.flushNow();
    } catch (err) {
      this.log.error("sync.flush_failed", { message: (err as Error).message });
    }
    this.scheduler.cancelPending();

    const deadline = Date.now() + this.config.drainTimeout;
    while (this.scheduler.stats().running > 0 && Date.now() < deadline) {
      await sleep(100);
    }
    this.log.info("stopped", {
      received: this.stats.received,
      run: this.stats.run,
      failed: this.stats.failed,
      stillRunning: this.scheduler.stats().running,
    });
  }

  snapshot() {
    return {
      connected: this.realtime?.isConnected ?? false,
      workspaceId: this.token?.workspaceId,
      ...this.stats,
      scheduler: this.scheduler.stats(),
      localSync: this.projection?.snapshot(),
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
