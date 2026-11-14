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
import { ReorderBuffer } from "./reorderBuffer.js";
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
  /**
   * Reorder-buffer window in ms. Pass `0` in tests to flush events synchronously.
   * Defaults to 80 ms in production.
   */
  reorderWindowMs?: number;
  /**
   * Minimum interval between successive catchUp() calls in ms.
   * Guards against reconnect storms where every SUBSCRIBED event would otherwise
   * trigger a new catch-up REST call. Defaults to 30 000 ms (30 s).
   * Pass `0` in tests to disable the cooldown.
   */
  catchUpCooldownMs?: number;
  /**
   * Force rebuild the local model from REST API, ignoring any existing local state.
   * Defaults to false (use local model if available).
   */
  rebuild?: boolean;
  /**
   * Injectable backoff for seed/re-seed retries on non-rate-limit failures.
   * Defaults to 5 s base, doubling to a 5 min cap. (429 retries always use the
   * server's `Retry-After` instead.)
   */
  seedRetryBackoff?: Backoff;
  /**
   * Injectable backoff for catch-up retries on non-rate-limit failures.
   * Defaults to 5 s base, doubling to a 5 min cap.
   */
  catchupRetryBackoff?: Backoff;
}

export class App {
  private readonly config: SpecStreamConfig;
  private readonly apiKey: string;
  private readonly log: Logger;
  private readonly dryRun: boolean;
  private readonly rebuild: boolean;
  private router: Router;
  private self: SelfIdentity = {};
  private readonly scheduler: Scheduler;
  private readonly fetchImpl: typeof fetch;
  private readonly createSupabase: (url: string, anonKey: string) => SupabaseLike;
  private readonly writeOutput: ((stream: "stdout" | "stderr", text: string) => void) | null;
  private readonly rateLimiter: RateLimiter | RateLimiterOptions | undefined;
  private readonly reorderWindowMs: number | undefined;
  private readonly catchUpCooldownMs: number;

  private realtime?: RealtimeClient;
  private token?: RealtimeToken;
  private projection?: Projection;
  private rest?: RestClient;
  private renewTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private stats = { received: 0, run: 0, failed: 0, lastEventAt: 0 };
  private reorderBuffer?: ReorderBuffer;
  /** ISO timestamp of the last event we processed (for reconnect catch-up). */
  private lastEventCreatedAt?: string;
  /** ID of the last event we processed (to exclude it from catch-up replay). */
  private lastEventId?: string;
  /** Recent event ids, to dedupe the boundary overlap when replaying the gap. */
  private recentEventIds = new Set<string>();
  /** True once we've had our first successful subscribe (so later ones are reconnects). */
  private hasSubscribed = false;
  /** Guards against overlapping catch-up runs. */
  private catchingUp = false;
  /** Timestamp (Date.now()) of the last catch-up attempt, for the cooldown guard. */
  private lastCatchUpAt = 0;
  /** Timestamp (Date.now()) until which catch-up is rate-limited and must not be retried. */
  private catchupRateLimitedUntil = 0;
  /** Guards against overlapping seed/re-seed runs. */
  private seeding = false;
  /** Pending one-shot timer that retries a failed seed/re-seed. */
  private seedRetryTimer?: ReturnType<typeof setTimeout>;
  /** Pending one-shot timer that retries a failed catch-up. */
  private catchupRetryTimer?: ReturnType<typeof setTimeout>;
  /** Consecutive catch-up failures; escalates to a full re-seed past the bound. */
  private consecutiveCatchupFailures = 0;
  /**
   * ISO timestamp of when the mirror first became behind/absent, or undefined when the
   * mirror is current. Set on any seed or catch-up failure, cleared on recovery.
   */
  private mirrorBehindSince?: string;

  private readonly seedRetryBackoff: Backoff;
  private readonly catchupRetryBackoff: Backoff;

  /** Fallback wait when a 429 carries no usable Retry-After header. */
  private static readonly DEFAULT_RATE_LIMIT_RETRY_MS = 60_000;
  /** Upper bound for honoring Retry-After — don't sleep for hours on a bad header. */
  private static readonly MAX_RETRY_AFTER_MS = 30 * 60_000;
  /** Consecutive catch-up failures that escalate to a full REST re-seed. */
  private static readonly MAX_CATCHUP_FAILURES_BEFORE_RESEED = 5;

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
    this.reorderWindowMs = opts.reorderWindowMs;
    this.catchUpCooldownMs = opts.catchUpCooldownMs ?? 30_000;
    this.rebuild = opts.rebuild ?? false;
    this.seedRetryBackoff = opts.seedRetryBackoff ?? new Backoff({ baseMs: 5_000, maxMs: 5 * 60_000 });
    this.catchupRetryBackoff = opts.catchupRetryBackoff ?? new Backoff({ baseMs: 5_000, maxMs: 5 * 60_000 });
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
          logger: this.log,
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
      this.rest?.setAccessToken(this.token.accessToken);
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
    // Track the newest event timestamp and ID as the catch-up watermark.
    if (!this.lastEventCreatedAt || event.createdAt > this.lastEventCreatedAt) {
      this.lastEventCreatedAt = event.createdAt;
      this.lastEventId = event.id;
    } else if (event.createdAt === this.lastEventCreatedAt && event.id !== this.lastEventId) {
      // Same timestamp but different event - keep the newer one (by ID)
      this.lastEventId = event.id;
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
   * Mark the local mirror as behind/absent. Logged once per degradation episode as a
   * loud warning — a daemon that reports `started`/`SUBSCRIBED` while its mirror is
   * stale is silent data corruption for anyone reading `.spec-stream/model/`.
   */
  private markMirrorBehind(reason: string): void {
    if (this.mirrorBehindSince === undefined) {
      this.mirrorBehindSince = new Date().toISOString();
      this.log.warn("sync.mirror_behind", {
        reason,
        since: this.mirrorBehindSince,
        message:
          "Local model mirror is absent or behind the board; entries under " +
          "localSync.dir may be stale until sync.mirror_current is logged.",
      });
    }
  }

  /** Mark the mirror current again and log the recovery. */
  private markMirrorCurrent(via: string): void {
    if (this.mirrorBehindSince === undefined) return;
    // A successful catch-up cannot make an unseeded mirror "current" — it replays
    // into the in-memory model only; the pending seed retry must finish first.
    if (this.projection && !this.projection.isSeeded) return;
    this.log.info("sync.mirror_current", { via, wasBehindSince: this.mirrorBehindSince });
    this.mirrorBehindSince = undefined;
  }

  /**
   * Delay before retrying a failed REST sync: honor `Retry-After` on 429 (falling back
   * to 60 s when absent), exponential backoff for any other failure. The backoff counter
   * also advances on 429 so logs show escalating attempts.
   */
  private syncRetryDelayMs(err: unknown, backoff: Backoff): number {
    if (err instanceof RestError && err.kind === "rate_limited") {
      backoff.nextDelay(); // advance the attempt counter for observability
      const retryAfterMs = err.retryAfterMs ?? App.DEFAULT_RATE_LIMIT_RETRY_MS;
      return Math.min(retryAfterMs, App.MAX_RETRY_AFTER_MS);
    }
    return backoff.nextDelay();
  }

  /**
   * Run `projection.seed()` (initial seed or full rebuild) and keep the daemon alive on
   * failure — but never silently: every failure is surfaced via `sync.mirror_behind`
   * and a retry is scheduled. On success the persisted cursor is carried into the
   * in-memory catch-up watermark and the mirror is marked current.
   */
  private async seedProjection(rebuild: boolean): Promise<void> {
    if (!this.projection || this.stopped || this.seeding) return;
    this.seeding = true;
    try {
      await this.projection.seed(rebuild);
      this.seedRetryBackoff.reset();
      this.consecutiveCatchupFailures = 0;
      // Carry the persisted cursor into the in-memory catch-up watermark so a reconnect
      // that happens before any live event still replays from the last synced position.
      const state = this.projection.readSyncState();
      if (state && state.cursor.lastCreatedAt) {
        this.lastEventCreatedAt = state.cursor.lastCreatedAt;
        this.lastEventId = state.cursor.lastEventId;
        this.log.info("sync.resumed", { since: state.cursor.lastCreatedAt, eventId: this.lastEventId });
      }
      this.markMirrorCurrent(rebuild ? "reseed" : "seed");
    } catch (err) {
      // Seeding failure is non-fatal for the stream: live events still apply, but the
      // mirror must not be left silently absent — surface the lag and schedule a retry.
      this.log.error("sync.seed_failed", { message: (err as Error).message });
      this.markMirrorBehind(rebuild ? "reseed_failed" : "seed_failed");
      if (err instanceof RestError && !err.retryable) {
        // A genuinely rejected API key cannot be retried into success — hammering
        // the endpoint would only burn quota and spam logs. The mirror stays
        // behind (surfaced above) until a restart with a valid key.
        this.log.error("sync.seed_fatal", {
          kind: err.kind,
          message: "Seed failed non-retryably — check the API key/config; no retry scheduled.",
        });
        return;
      }
      this.scheduleSeedRetry(err, rebuild);
    } finally {
      this.seeding = false;
    }
  }

  /** Schedule a one-shot seed retry. At most one pending retry at a time. */
  private scheduleSeedRetry(err: unknown, rebuild: boolean): void {
    if (this.stopped || this.seedRetryTimer) return;
    const delayMs = this.syncRetryDelayMs(err, this.seedRetryBackoff);
    this.log.warn("sync.seed_retry", {
      attempt: this.seedRetryBackoff.attempts,
      delayMs,
      retryAt: new Date(Date.now() + delayMs).toISOString(),
      reason: err instanceof RestError && err.kind === "rate_limited" ? "rate_limited" : "error",
    });
    this.seedRetryTimer = setTimeout(() => {
      this.seedRetryTimer = undefined;
      void this.seedProjection(rebuild);
    }, delayMs);
  }

  /**
   * Schedule a one-shot catch-up retry after a failure. Without this, a failed
   * catch-up would only ever be re-attempted on the next SUBSCRIBED event — but a
   * 429 on the REST API does not drop the realtime socket, so the mirror would stay
   * behind indefinitely while the connection reports healthy.
   */
  private scheduleCatchupRetry(err: unknown): void {
    if (this.stopped || this.catchupRetryTimer) return;
    const delayMs = this.syncRetryDelayMs(err, this.catchupRetryBackoff);
    this.log.warn("conn.catchup_retry", {
      attempt: this.catchupRetryBackoff.attempts,
      delayMs,
      retryAt: new Date(Date.now() + delayMs).toISOString(),
      reason: err instanceof RestError && err.kind === "rate_limited" ? "rate_limited" : "error",
    });
    this.catchupRetryTimer = setTimeout(() => {
      this.catchupRetryTimer = undefined;
      // Bypass the cooldown guard: this invocation IS the scheduled retry — a
      // SUBSCRIBED-triggered attempt may have run within the cooldown window.
      this.lastCatchUpAt = 0;
      void this.catchUp();
    }, delayMs);
  }

  private cancelCatchupRetry(): void {
    if (this.catchupRetryTimer) {
      clearTimeout(this.catchupRetryTimer);
      this.catchupRetryTimer = undefined;
    }
  }

  /**
   * Replay changelog events missed during a disconnect. Fetches events created on/after
   * the last processed timestamp and feeds them through {@link onEvent} (which dedupes the
   * boundary overlap and applies to the projection + router). Best-effort: failures are
   * logged and the live stream still resumes. Runs on each successful RE-subscribe.
   *
   * On 429 Too Many Requests: respects the `Retry-After` header (or falls back to 60 s)
   * and refuses to re-attempt until that window passes — then a timer-driven retry runs
   * the catch-up (the live socket is NOT closed, so waiting for the next SUBSCRIBED
   * could leave the mirror behind indefinitely). After
   * {@link App.MAX_CATCHUP_FAILURES_BEFORE_RESEED} consecutive failures the daemon
   * falls back to a full REST re-seed rather than staying permanently behind.
   *
   * **Cooldown guard:** at most one catch-up per `catchUpCooldownMs` (default 30 s).
   * Reconnect storms (many SUBSCRIBED events in quick succession) are collapsed into a
   * single REST call, dramatically reducing Supabase usage when connections are unstable.
   * Events that arrive during the cooldown window are not lost — the realtime channel
   * delivers them live the moment the socket reconnects, and the next catch-up (once the
   * cooldown expires) will fill any remaining gap.
   */
  private async catchUp(): Promise<void> {
    if (!this.rest || this.catchingUp || this.stopped) return;
    // Snapshot the watermark NOW, before any await, so concurrent live events that advance
    // this.lastEventCreatedAt / this.lastEventId during the async REST fetch cannot cause
    // us to skip rows that are legitimately inside the catch-up window.
    const since = this.lastEventCreatedAt;
    const cursorEventId = this.lastEventId;
    if (!since) return; // nothing processed yet; seed already covers initial state

    // ── Cooldown guard ──────────────────────────────────────────────────────
    // Prevent catch-up storms: a rapid sequence of SUBSCRIBED events (e.g. after a
    // network blip) must not fan out into one REST call per event.
    const now = Date.now();
    if (this.catchUpCooldownMs > 0 && now - this.lastCatchUpAt < this.catchUpCooldownMs) {
      const remainingMs = this.catchUpCooldownMs - (now - this.lastCatchUpAt);
      this.log.debug("conn.catchup_skipped", {
        reason: "cooldown",
        remainingMs,
        cooldownMs: this.catchUpCooldownMs,
      });
      return;
    }

    // Respect a previous rate-limit window — don't hammer the API.
    if (now < this.catchupRateLimitedUntil) {
      const remainingMs = this.catchupRateLimitedUntil - now;
      this.log.warn("conn.catchup_rate_limited", {
        since,
        retryInMs: remainingMs,
        message: "Skipping catch-up: still within Retry-After window.",
      });
      return;
    }

    // Record the attempt time BEFORE the async work so that a second SUBSCRIBED
    // event arriving while the fetch is in-flight also hits the cooldown guard.
    this.lastCatchUpAt = now;

    this.catchingUp = true;
    try {
      const rows = await this.rest.fetchChangelogSince(since);
      let replayed = 0;
      let latestEventId = cursorEventId;
      let latestCreatedAt = since;
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
        // Skip the exact event that sat at the cursor position — we already processed it.
        // Use the snapshot (`cursorEventId`), not the live field, because concurrent live
        // events may have advanced `this.lastEventId` past this catch-up window.
        if (event.id === cursorEventId) {
          this.log.debug("event.boundary_skip", { eventId: event.id, createdAt: event.createdAt });
          continue;
        }
        // Skip events strictly before the cursor timestamp.  Use the snapshot (`since`) here
        // for the same reason: a live event received while the REST fetch was in-flight could
        // have moved `this.lastEventCreatedAt` forward, which would incorrectly reject events
        // that belong to this catch-up window.
        if (event.createdAt < since) {
          this.log.debug("event.skip_before_cursor", { eventId: event.id, createdAt: event.createdAt, cursor: since });
          continue;
        }
        this.onEvent(event);
        replayed++;
        // Track the latest event for the next catch-up watermark
        if (!latestCreatedAt || event.createdAt > latestCreatedAt) {
          latestCreatedAt = event.createdAt;
        }
        latestEventId = event.id;
      }
      // Update watermark to the latest processed event
      this.lastEventId = latestEventId;
      this.lastEventCreatedAt = latestCreatedAt;
      this.log.info("conn.catchup", { since, fetched: rows.length, replayed });
      this.consecutiveCatchupFailures = 0;
      this.catchupRetryBackoff.reset();
      this.cancelCatchupRetry();
      this.markMirrorCurrent("catchup");
    } catch (err) {
      this.consecutiveCatchupFailures++;
      this.markMirrorBehind("catchup_failed");
      if (err instanceof RestError && err.kind === "rate_limited") {
        // Prooph board rate limit: 120 req/min or 1000 req/hr.
        // Honor the Retry-After header; default to 60 s if absent.
        const retryAfterMs = Math.min(
          err.retryAfterMs ?? App.DEFAULT_RATE_LIMIT_RETRY_MS,
          App.MAX_RETRY_AFTER_MS,
        );
        this.catchupRateLimitedUntil = Date.now() + retryAfterMs;
        this.log.warn("conn.catchup_failed", {
          since,
          message: err.message,
          retryAfterMs,
          retryAt: new Date(this.catchupRateLimitedUntil).toISOString(),
        });
        // Do NOT close or reconnect — the live stream stays up. The retry is
        // scheduled for when the window expires (not left to the next SUBSCRIBED,
        // which may never come while the socket stays healthy).
      } else {
        this.log.warn("conn.catchup_failed", { since, message: (err as Error).message });
      }
      if (this.consecutiveCatchupFailures >= App.MAX_CATCHUP_FAILURES_BEFORE_RESEED) {
        // Floor: incremental catch-up can't keep up — fall back to the idempotent
        // full REST re-seed (whose own retries honor Retry-After until it succeeds).
        this.log.warn("conn.catchup_reseed", {
          failures: this.consecutiveCatchupFailures,
          message: "Catch-up keeps failing — falling back to a full model re-seed.",
        });
        this.consecutiveCatchupFailures = 0;
        void this.seedProjection(true);
      } else {
        this.scheduleCatchupRetry(err);
      }
    } finally {
      this.catchingUp = false;
      // Persist the updated cursor after catch-up, so it's immediately available
      // on restart (no need to wait for the debounced write).
      if (this.projection && (this.lastEventId || this.lastEventCreatedAt)) {
        try {
          this.projection.updateCursor(this.lastEventId, this.lastEventCreatedAt);
          this.projection.flushCursor();
        } catch (err) {
          this.log.warn("sync.flush_cursor_failed", { message: (err as Error).message });
        }
      }
    }
  }

  /** React to realtime connection-state transitions, triggering catch-up on re-subscribe. */
  private onRealtimeStatus(status: string, err?: Error): void {
    this.log.info("conn.state", { status, error: err?.message });
    if (status !== "SUBSCRIBED") return;
    if (!this.hasSubscribed) {
      // First subscribe after startup: if we loaded from a persisted cursor, catch up now
      // (the local model was resumed from disk, but we may have missed events since then).
      this.hasSubscribed = true;
      if (this.lastEventCreatedAt) {
        void this.catchUp();
      }
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
    // Pass the realtime access token so fetchChangelogSince uses the lightweight /catchup
    // endpoint (JWT auth, zero extra Supabase calls) instead of /changelog (pb_ key auth).
    this.rest = new RestClient({
      endpoint: this.config.endpoint,
      apiKey: this.apiKey,
      fetchImpl: this.fetchImpl,
      rateLimiter: this.rateLimiter,
      logger: this.log,
      accessToken: this.token.accessToken,
      workspaceId: this.token.workspaceId,
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
      // Seeding failure is non-fatal for the stream but never silent: seedProjection
      // surfaces `sync.mirror_behind` and retries until the mirror exists.
      await this.seedProjection(this.rebuild);
    }

    // Buffer incoming realtime events for a short window so that events emitted within
    // the same DB transaction (e.g. element-added + element-config-synced) are sorted
    // by createdAt before the projection and router see them. Without this, the sync
    // event can arrive before element-added and silently no-op in the reducer.
    this.reorderBuffer = new ReorderBuffer({ onEvent: (e) => this.onEvent(e), windowMs: this.reorderWindowMs });

    this.realtime = new RealtimeClient({
      supabaseUrl: this.token.supabaseUrl,
      supabaseAnonKey: this.token.supabaseAnonKey,
      workspaceId: this.token.workspaceId,
      accessToken: this.token.accessToken,
      createClient: this.createSupabase,
      onEvent: (e) => this.reorderBuffer!.push(e),
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
    if (this.seedRetryTimer) clearTimeout(this.seedRetryTimer);
    this.cancelCatchupRetry();
    await this.realtime?.disconnect();
    // Flush any events still sitting in the reorder buffer before shutting down.
    this.reorderBuffer?.flush();
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
      localSync: this.projection
        ? { ...this.projection.snapshot(), behindSince: this.mirrorBehindSince }
        : undefined,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
