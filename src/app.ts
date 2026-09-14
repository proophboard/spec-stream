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
import { Router } from "./routing/router.js";
import { Scheduler, type SchedulerTask } from "./scheduler/scheduler.js";
import { runCommand } from "./runner/command.js";
import { Backoff, renewAtMs } from "./util/backoff.js";
import type { Logger } from "./logging/logger.js";

export interface AppOptions {
  config: SpecStreamConfig;
  apiKey: string;
  logger: Logger;
  dryRun?: boolean;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  createSupabase?: (url: string, anonKey: string) => SupabaseLike;
}

export class App {
  private readonly config: SpecStreamConfig;
  private readonly apiKey: string;
  private readonly log: Logger;
  private readonly dryRun: boolean;
  private readonly router: Router;
  private readonly scheduler: Scheduler;
  private readonly fetchImpl: typeof fetch;
  private readonly createSupabase: (url: string, anonKey: string) => SupabaseLike;

  private realtime?: RealtimeClient;
  private token?: RealtimeToken;
  private renewTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private stats = { received: 0, run: 0, failed: 0, lastEventAt: 0 };

  constructor(opts: AppOptions) {
    this.config = opts.config;
    this.apiKey = opts.apiKey;
    this.log = opts.logger;
    this.dryRun = opts.dryRun ?? false;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.createSupabase =
      opts.createSupabase ??
      ((url, anonKey) => createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } }) as unknown as SupabaseLike);
    this.router = Router.fromConfig(this.config);
    this.scheduler = new Scheduler({
      maxConcurrent: this.config.maxConcurrent,
      runner: (task) => this.executeTask(task),
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
    this.stats.received++;
    this.stats.lastEventAt = Date.now();
    this.log.info("event.received", {
      eventType: event.type,
      elementName: event.elementName,
      elementType: event.elementType,
    });

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
    const result = await runCommand(task, {
      config: this.config,
      processEnv: process.env,
    });
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

  /** Start streaming. Throws on fatal startup errors (e.g. invalid key). */
  async start(): Promise<void> {
    this.token = await this.obtainToken();
    this.log.info("auth.token", {
      workspaceId: this.token.workspaceId,
      expiresAt: Math.floor(this.token.expiresAtMs / 1000),
    });

    this.realtime = new RealtimeClient({
      supabaseUrl: this.token.supabaseUrl,
      supabaseAnonKey: this.token.supabaseAnonKey,
      workspaceId: this.token.workspaceId,
      accessToken: this.token.accessToken,
      createClient: this.createSupabase,
      onEvent: (e) => this.onEvent(e),
      onStatus: (status, err) =>
        this.log.info("conn.state", { status, error: err?.message }),
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
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
