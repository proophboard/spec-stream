import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { App } from "./app.js";
import { validateConfig } from "./config/schema.js";
import { Logger, type LogRecord } from "./logging/logger.js";
import type { SupabaseLike, ChannelLike } from "./realtime/client.js";
import type { ChangelogEventRow } from "./realtime/events.js";
import { Backoff } from "./util/backoff.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function silentLogger() {
  const records: LogRecord[] = [];
  const logger = new Logger({ level: "trace", sinks: [{ write: (r) => records.push(r) }] });
  return { logger, records };
}

function mockSupabaseFactory() {
  let channel: MockChannel | undefined;
  class MockChannel implements ChannelLike {
    rowCb?: (p: { new: ChangelogEventRow }) => void;
    statusCb?: (s: string) => void;
    on(_t: "postgres_changes", _f: unknown, cb: (p: { new: ChangelogEventRow }) => void) {
      this.rowCb = cb;
      return this;
    }
    subscribe(cb: (s: string) => void) {
      this.statusCb = cb;
      // Simulate immediate subscription.
      setTimeout(() => cb("SUBSCRIBED"), 0);
      return this;
    }
  }
  const factory = (_url: string, _key: string): SupabaseLike => ({
    realtime: { setAuth: () => {} },
    channel: () => {
      channel = new MockChannel();
      return channel;
    },
    removeChannel: () => {},
  });
  return {
    factory,
    emitRow: (row: ChangelogEventRow) => channel?.rowCb?.({ new: row }),
  };
}

function tokenFetch(userId = "self-user"): typeof fetch {
  return (async () =>
    ({
      status: 200,
      ok: true,
      json: async () => ({
        supabase_url: "https://x.supabase.co",
        supabase_anon_key: "anon",
        workspace_id: "ws-1",
        access_token: "eyJ.a.b",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user_id: userId,
        email: "api@machine",
      }),
    }) as unknown as Response) as unknown as typeof fetch;
}

function row(overrides: Partial<ChangelogEventRow> = {}): ChangelogEventRow {
  return {
    id: "r1",
    workspace_id: "ws-1",
    chapter_id: "ch1",
    element_id: "el1",
    slice_id: "sl1",
    user_id: "u1",
    event_type: "element-description-changed",
    event_data: { type: "element-description-changed", elementName: "Place Order" },
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => vi.useRealTimers());
afterEach(() => vi.restoreAllMocks());

describe("App integration (mocked fetch + supabase)", () => {
  it("connects, receives an event, matches a rule, and runs (dry-run)", async () => {
    const cfg = validateConfig({
      endpoint: "https://flow.prooph-board.com/api",
      rules: [{ id: "spec", on: "element-description-changed", run: "echo hi" }],
    });
    const { logger, records } = silentLogger();
    const supa = mockSupabaseFactory();

    const app = new App({
      config: cfg,
      apiKey: "pb_test",
      logger,
      dryRun: true,
      fetchImpl: tokenFetch(),
      createSupabase: supa.factory,
      reorderWindowMs: 0,
    });

    await app.start();
    // allow the SUBSCRIBED setTimeout(0) to fire
    await new Promise((r) => setTimeout(r, 5));

    supa.emitRow(row());
    await new Promise((r) => setTimeout(r, 5));

    const kinds = records.map((r) => r.kind);
    expect(kinds).toContain("auth.token");
    expect(kinds).toContain("started");
    expect(kinds).toContain("event.received");
    expect(kinds).toContain("rule.matched");
    expect(kinds).toContain("command.dry_run");

    const snap = app.snapshot();
    expect(snap.received).toBe(1);
    expect(snap.workspaceId).toBe("ws-1");

    await app.stop();
  });

  it("ignores events that match no rule", async () => {
    const cfg = validateConfig({
      endpoint: "https://x.com/api",
      rules: [{ id: "spec", on: "slice-added", run: "echo hi" }],
    });
    const { logger, records } = silentLogger();
    const supa = mockSupabaseFactory();
    const app = new App({
      config: cfg,
      apiKey: "pb_test",
      logger,
      dryRun: true,
      fetchImpl: tokenFetch(),
      createSupabase: supa.factory,
      reorderWindowMs: 0,
    });
    await app.start();
    await new Promise((r) => setTimeout(r, 5));
    supa.emitRow(row()); // element-description-changed, not slice-added
    await new Promise((r) => setTimeout(r, 5));
    expect(records.map((r) => r.kind)).toContain("event.no_match");
    expect(records.map((r) => r.kind)).not.toContain("command.dry_run");
    await app.stop();
  });

  it("filters out the API-key user's own events by default", async () => {
    const cfg = validateConfig({
      endpoint: "https://x.com/api",
      rules: [{ id: "spec", on: "element-description-changed", run: "echo hi" }],
    });
    const { logger, records } = silentLogger();
    const supa = mockSupabaseFactory();
    const app = new App({
      config: cfg,
      apiKey: "pb_test",
      logger,
      dryRun: true,
      fetchImpl: tokenFetch("self-user"),
      createSupabase: supa.factory,
      reorderWindowMs: 0,
    });
    await app.start();
    await new Promise((r) => setTimeout(r, 5));

    // Event from our own user id -> filtered (no match, no run)
    supa.emitRow(row({ id: "r-own", user_id: "self-user" }));
    await new Promise((r) => setTimeout(r, 5));
    expect(records.map((r) => r.kind)).not.toContain("command.dry_run");
    expect(app.snapshot().received).toBe(1); // received but not acted upon

    // Event from another user -> runs
    supa.emitRow(row({ id: "r-other", user_id: "someone-else" }));
    await new Promise((r) => setTimeout(r, 5));
    expect(records.map((r) => r.kind)).toContain("command.dry_run");

    await app.stop();
  });

  it("surfaces a command's stdout via writeOutput in the foreground", async () => {
    const cfg = validateConfig({
      endpoint: "https://x.com/api",
      rules: [{ id: "example", on: "element-description-changed", run: "echo hello-from-cmd" }],
    });
    const { logger, records } = silentLogger();
    const supa = mockSupabaseFactory();
    const outputs: Array<{ stream: string; text: string }> = [];
    const app = new App({
      config: cfg,
      apiKey: "pb_test",
      logger,
      fetchImpl: tokenFetch(),
      createSupabase: supa.factory,
      reorderWindowMs: 0,
      writeOutput: (stream, text) => outputs.push({ stream, text }),
    });

    await app.start();
    await new Promise((r) => setTimeout(r, 5));
    supa.emitRow(row({ user_id: "someone-else" }));
    // Give the spawned echo time to run and close.
    await new Promise((r) => setTimeout(r, 200));

    expect(records.map((r) => r.kind)).toContain("command.done");
    const stdout = outputs.filter((o) => o.stream === "stdout").map((o) => o.text).join("");
    expect(stdout).toContain("hello-from-cmd");
    expect(stdout).toContain("[example:out]");

    await app.stop();
  });

  it("suppresses command output when writeOutput is null", async () => {
    const cfg = validateConfig({
      endpoint: "https://x.com/api",
      rules: [{ id: "example", on: "element-description-changed", run: "echo quiet" }],
    });
    const { logger } = silentLogger();
    const supa = mockSupabaseFactory();
    const app = new App({
      config: cfg,
      apiKey: "pb_test",
      logger,
      fetchImpl: tokenFetch(),
      createSupabase: supa.factory,
      reorderWindowMs: 0,
      writeOutput: null,
    });

    await app.start();
    await new Promise((r) => setTimeout(r, 5));
    supa.emitRow(row({ user_id: "someone-else" }));
    await new Promise((r) => setTimeout(r, 200));
    // No assertion target for output; just ensure it ran without throwing.
    expect(app.snapshot().run).toBe(1);
    await app.stop();
  });

  it("live-streams multi-line command output, prefixed per line", async () => {
    const cfg = validateConfig({
      endpoint: "https://x.com/api",
      rules: [{ id: "example", on: "element-description-changed", run: "printf 'one\\ntwo\\n'" }],
    });
    const { logger } = silentLogger();
    const supa = mockSupabaseFactory();
    const lines: string[] = [];
    const app = new App({
      config: cfg,
      apiKey: "pb_test",
      logger,
      fetchImpl: tokenFetch(),
      createSupabase: supa.factory,
      reorderWindowMs: 0,
      writeOutput: (_stream, text) => lines.push(text),
    });

    await app.start();
    await new Promise((r) => setTimeout(r, 5));
    supa.emitRow(row({ user_id: "someone-else" }));
    await new Promise((r) => setTimeout(r, 200));

    const joined = lines.join("");
    expect(joined).toContain("[example:out] one\n");
    expect(joined).toContain("[example:out] two\n");
    await app.stop();
  });

  it("debounce + when: a status flipped and quickly reverted does not run", async () => {
    vi.useFakeTimers();
    try {
      const cfg = validateConfig({
        endpoint: "https://flow.prooph-board.com/api",
        rules: [
          {
            id: "build-planned-slice",
            on: "slice-status-changed",
            when: { data: { "newValue.status": ["planned"] } },
            run: "echo build",
            concurrency: { key: "slice", mode: "debounce", wait: 4000 },
          },
        ],
      });
      const { logger, records } = silentLogger();
      const supa = mockSupabaseFactory();
      const app = new App({
        config: cfg,
        apiKey: "pb_test",
        logger,
        dryRun: true,
        fetchImpl: tokenFetch(),
        createSupabase: supa.factory,
        reorderWindowMs: 0,
        writeOutput: null,
      });
      await app.start();
      await vi.advanceTimersByTimeAsync(0); // flush the SUBSCRIBED setTimeout(0)

      const statusRow = (status: string, id: string) =>
        row({
          id,
          user_id: "someone-else",
          event_type: "slice-status-changed",
          event_data: { type: "slice-status-changed", newValue: { status } },
        });

      supa.emitRow(statusRow("planned", "r1")); // t=0
      vi.advanceTimersByTime(3000); // t=3s — still inside the 4s window
      supa.emitRow(statusRow("draft", "r2")); // revert — must reset the timer
      vi.advanceTimersByTime(5000); // t=8s — past both possible fire times

      expect(app.snapshot().received).toBe(2);
      // The revert (latest event: status=draft) must suppress the command entirely.
      expect(records.map((r) => r.kind)).not.toContain("command.dry_run");
      await app.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws a fatal error on an unauthorized key at startup", async () => {
    const cfg = validateConfig({
      endpoint: "https://x.com/api",
      rules: [{ id: "r", on: "*", run: "x" }],
    });
    const { logger } = silentLogger();
    const unauthorizedFetch = (async () =>
      ({ status: 401, ok: false, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
    const supa = mockSupabaseFactory();
    const app = new App({
      config: cfg,
      apiKey: "pb_bad",
      logger,
      fetchImpl: unauthorizedFetch,
      createSupabase: supa.factory,
      reorderWindowMs: 0,
    });
    await expect(app.start()).rejects.toMatchObject({ kind: "unauthorized" });
  });
});

describe("App reconnect catch-up", () => {
  /** Supabase mock that lets the test drive status transitions and row delivery. */
  function reconnectSupabase() {
    let channel: MockChannel | undefined;
    class MockChannel implements ChannelLike {
      rowCb?: (p: { new: ChangelogEventRow }) => void;
      statusCb?: (s: string) => void;
      on(_t: "postgres_changes", _f: unknown, cb: (p: { new: ChangelogEventRow }) => void) {
        this.rowCb = cb;
        return this;
      }
      subscribe(cb: (s: string) => void) {
        this.statusCb = cb;
        setTimeout(() => cb("SUBSCRIBED"), 0);
        return this;
      }
    }
    const factory = (): SupabaseLike => ({
      realtime: { setAuth: () => {} },
      channel: () => {
        channel = new MockChannel();
        return channel;
      },
      removeChannel: () => {},
    });
    return {
      factory,
      emitRow: (r: ChangelogEventRow) => channel?.rowCb?.({ new: r }),
      emitStatus: (s: string) => channel?.statusCb?.(s),
    };
  }

  /** Fetch mock: serves the token endpoint and a canned /changelog or /catchup page. */
  function routingFetch(changelogRows: unknown[]): { impl: typeof fetch; changelogCalls: string[] } {
    const changelogCalls: string[] = [];
    const impl = (async (url: string) => {
      if (url.includes("/changelog") || url.includes("/catchup")) {
        changelogCalls.push(url);
        return { status: 200, ok: true, headers: { get: () => null }, json: async () => changelogRows } as unknown as Response;
      }
      // token endpoint
      return {
        status: 200,
        ok: true,
        headers: { get: () => null },
        json: async () => ({
          supabase_url: "https://x.supabase.co",
          supabase_anon_key: "anon",
          workspace_id: "ws-1",
          access_token: "t",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user_id: "self-user",
          email: "api@machine",
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return { impl, changelogCalls };
  }

  function row(id: string, extra: Partial<ChangelogEventRow> = {}): ChangelogEventRow {
    return {
      id,
      workspace_id: "ws-1",
      chapter_id: "ch1",
      element_id: "el1",
      slice_id: "sl1",
      user_id: "someone-else",
      event_type: "element-description-changed",
      event_data: { type: "element-description-changed", elementName: "X" },
      created_at: "2026-10-03T12:00:00Z",
      ...extra,
    };
  }

  it("replays missed events on re-subscribe and dedupes the boundary", async () => {
    const cfg = validateConfig({
      endpoint: "https://flow.prooph-board.com/api",
      rules: [{ id: "spec", on: "element-description-changed", run: "echo hi" }],
    });
    const { logger, records } = silentLogger();
    // The gap fetch returns the already-seen live event (dedupe) + one missed event.
    const { impl, changelogCalls } = routingFetch([
      row("live-1"), // boundary overlap — already processed live
      row("missed-1"), // genuinely missed during the gap
    ]);
    const supa = reconnectSupabase();
    const app = new App({ config: cfg, apiKey: "pb_x", logger, dryRun: true, fetchImpl: impl, createSupabase: supa.factory, rateLimiter: { minIntervalMs: 0 }, reorderWindowMs: 0 });

    await app.start();
    await new Promise((r) => setTimeout(r, 5)); // initial SUBSCRIBED

    // One live event establishes the catch-up watermark.
    supa.emitRow(row("live-1"));
    await new Promise((r) => setTimeout(r, 5));
    const runsAfterLive = records.filter((r) => r.kind === "command.dry_run").length;
    expect(runsAfterLive).toBe(1);

    // Simulate a drop + re-subscribe → triggers catch-up.
    supa.emitStatus("CLOSED");
    supa.emitStatus("SUBSCRIBED");
    await new Promise((r) => setTimeout(r, 10));

    expect(changelogCalls.length).toBe(1);
    expect(changelogCalls[0]).toContain("since=2026-10-03T12%3A00%3A00Z");
    // Only the missed event should have produced a new run; live-1 was deduped.
    const totalRuns = records.filter((r) => r.kind === "command.dry_run").length;
    expect(totalRuns).toBe(2);
    const catchup = records.find((r) => r.kind === "conn.catchup");
    expect(catchup).toMatchObject({ fetched: 2, replayed: 1 });

    await app.stop();
  });

  it("does not catch up on the first subscribe", async () => {
    const cfg = validateConfig({
      endpoint: "https://flow.prooph-board.com/api",
      rules: [{ id: "spec", on: "*", run: "x" }],
    });
    const { logger, records } = silentLogger();
    const { impl, changelogCalls } = routingFetch([]);
    const supa = reconnectSupabase();
    const app = new App({ config: cfg, apiKey: "pb_x", logger, dryRun: true, fetchImpl: impl, createSupabase: supa.factory, rateLimiter: { minIntervalMs: 0 }, reorderWindowMs: 0 });
    await app.start();
    await new Promise((r) => setTimeout(r, 5));
    expect(changelogCalls.length).toBe(0);
    expect(records.find((r) => r.kind === "conn.catchup")).toBeUndefined();
    await app.stop();
  });

  it("does not skip catch-up rows whose timestamp is between the cursor and a concurrently-received live event", async () => {
    // Regression: if a live event arrives and advances this.lastEventCreatedAt *while* the
    // REST fetch is in-flight, the old code compared event.createdAt against the updated
    // (live) watermark and incorrectly skipped events that were legitimately in the gap.
    //
    // Timeline:
    //   cursor = T1 (06:10:00)   ← persisted cursor before disconnect
    //   live event T3 (06:34:39) ← arrives via realtime right after SUBSCRIBED fires
    //   REST fetch returns T2 (06:34:28) ← in the gap between T1 and T3, must be replayed
    //
    // The bug: the skip guard used `this.lastEventCreatedAt` (now T3) instead of the
    // snapshotted `since` (T1), so T2 < T3 was incorrectly classified as "before cursor".
    const T1 = "2026-10-19T06:10:00.000000+00:00"; // cursor
    const T2 = "2026-10-19T06:34:28.000000+00:00"; // missed event — must be replayed
    const T3 = "2026-10-19T06:34:39.000000+00:00"; // live event received during fetch

    const cfg = validateConfig({
      endpoint: "https://flow.prooph-board.com/api",
      rules: [{ id: "spec", on: "element-description-changed", run: "echo hi" }],
    });
    const { logger, records } = silentLogger();

    // The changelog fetch is delayed so we can inject the live T3 event first.
    let resolveChangelogFetch!: (rows: unknown[]) => void;
    const changelogFetchGate = new Promise<unknown[]>((res) => { resolveChangelogFetch = res; });

    const impl = (async (url: string) => {
      if (url.includes("/changelog") || url.includes("/catchup")) {
        const rows = await changelogFetchGate;
        return { status: 200, ok: true, headers: { get: () => null }, json: async () => rows } as unknown as Response;
      }
      return {
        status: 200, ok: true, headers: { get: () => null },
        json: async () => ({
          supabase_url: "https://x.supabase.co", supabase_anon_key: "anon", workspace_id: "ws-1",
          access_token: "t", expires_at: Math.floor(Date.now() / 1000) + 3600,
          user_id: "self-user", email: "api@machine",
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const supa = reconnectSupabase();
    const app = new App({
      config: cfg, apiKey: "pb_x", logger, dryRun: true,
      fetchImpl: impl, createSupabase: supa.factory,
      rateLimiter: { minIntervalMs: 0 }, reorderWindowMs: 0,
    });

    await app.start();
    await new Promise((r) => setTimeout(r, 5)); // initial SUBSCRIBED

    // Establish the watermark at T1 by delivering a live event at T1.
    supa.emitRow(row("cursor-event", { created_at: T1 }));
    await new Promise((r) => setTimeout(r, 5));

    // Trigger a reconnect: SUBSCRIBED fires, catchUp() starts the async REST fetch
    // (which is now blocked on changelogFetchGate), and then the live T3 event arrives
    // via realtime and advances this.lastEventCreatedAt to T3 — before the REST rows
    // are processed.
    supa.emitStatus("CLOSED");
    supa.emitStatus("SUBSCRIBED");

    // Live T3 event fires while the REST fetch is still in flight.
    supa.emitRow(row("live-t3", { created_at: T3 }));
    await new Promise((r) => setTimeout(r, 5)); // let onEvent(T3) run

    // Now unblock the REST fetch with the T2 row (the missed event in the gap).
    resolveChangelogFetch([row("missed-t2", { created_at: T2 })]);
    await new Promise((r) => setTimeout(r, 20));

    const catchupLog = records.find((r) => r.kind === "conn.catchup");
    expect(catchupLog).toBeDefined();
    // T2 must have been replayed — it is between cursor T1 and live T3.
    expect(catchupLog).toMatchObject({ fetched: 1, replayed: 1 });

    // The "missed-t2" event must not appear as skip_before_cursor.
    const skipped = records.filter((r) => r.kind === "event.skip_before_cursor");
    expect(skipped.map((r) => r.eventId ?? (r as Record<string, unknown>)["eventId"])).not.toContain("missed-t2");

    await app.stop();
  });

  it("resumes the catch-up watermark from a persisted cursor on cold start", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "spec-stream-app-cursor-"));
    try {
      // Pre-write a sync-state.json as if a previous run had synced up to a known cursor.
      writeFileSync(
        join(tmp, "sync-state.json"),
        JSON.stringify({
          workspaceId: "ws-1",
          cursor: { lastEventId: "prev-9", lastCreatedAt: "2026-10-02T09:00:00Z" },
          schemaVersion: 1,
          syncedAt: "2026-10-02T09:00:00Z",
        }),
      );
      // Also create workspace.json so hasValidLocalModel() returns true and we load from disk
      writeFileSync(
        join(tmp, "workspace.json"),
        JSON.stringify({ id: "ws-1", name: "Test Workspace" }),
      );
      const cfg = validateConfig({
        endpoint: "https://flow.prooph-board.com/api",
        rules: [{ id: "spec", on: "*", run: "x" }],
        localSync: { enabled: true, dir: tmp },
      });
      const { logger, records } = silentLogger();
      // Seed fetch returns empty chapters/milestones; changelog fetch is the catch-up.
      const changelogCalls: string[] = [];
      const impl = (async (url: string) => {
        if (url.includes("/chapters") && !url.includes("/chapters/")) return json([]);
        if (url.includes("/milestones")) return json([]);
        if (url.includes("/snippets")) return json([]);
        if (url.includes("/changelog") || url.includes("/catchup")) {
          changelogCalls.push(url);
          return json([]);
        }
        return json({
          supabase_url: "https://x.supabase.co", supabase_anon_key: "anon", workspace_id: "ws-1",
          access_token: "t", expires_at: Math.floor(Date.now() / 1000) + 3600, user_id: "self-user", email: "a@b",
        });
      }) as unknown as typeof fetch;
      function json(body: unknown): Response {
        return { status: 200, ok: true, headers: { get: () => null }, json: async () => body } as unknown as Response;
      }
      const supa = reconnectSupabase();
      const app = new App({ config: cfg, apiKey: "pb_x", logger, dryRun: true, fetchImpl: impl, createSupabase: supa.factory, rateLimiter: { minIntervalMs: 0 }, reorderWindowMs: 0, catchUpCooldownMs: 0 });

      await app.start();
      await new Promise((r) => setTimeout(r, 5));
      expect(records.find((r) => r.kind === "sync.resumed")).toMatchObject({ since: "2026-10-02T09:00:00Z" });

      // Reconnect before any live event — catch-up must use the resumed cursor as `since`.
      supa.emitStatus("CLOSED");
      supa.emitStatus("SUBSCRIBED");
      await new Promise((r) => setTimeout(r, 10));
      // First subscribe with cursor triggers catch-up, and re-subscribe triggers another catch-up
      expect(changelogCalls.length).toBe(2);
      expect(changelogCalls[0]).toContain("since=2026-10-02T09%3A00%3A00Z");
      expect(changelogCalls[1]).toContain("since=2026-10-02T09%3A00%3A00Z");

      await app.stop();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("App rate-limited mirror recovery", () => {
  /** Supabase mock identical to the reconnect suite, with a drivable status callback. */
  function supaMock() {
    let channel: MockChannel | undefined;
    class MockChannel implements ChannelLike {
      rowCb?: (p: { new: ChangelogEventRow }) => void;
      statusCb?: (s: string) => void;
      on(_t: "postgres_changes", _f: unknown, cb: (p: { new: ChangelogEventRow }) => void) {
        this.rowCb = cb;
        return this;
      }
      subscribe(cb: (s: string) => void) {
        this.statusCb = cb;
        setTimeout(() => cb("SUBSCRIBED"), 0);
        return this;
      }
    }
    const factory = (): SupabaseLike => ({
      realtime: { setAuth: () => {} },
      channel: () => {
        channel = new MockChannel();
        return channel;
      },
      removeChannel: () => {},
    });
    return {
      factory,
      emitRow: (r: ChangelogEventRow) => channel?.rowCb?.({ new: r }),
      emitStatus: (s: string) => channel?.statusCb?.(s),
    };
  }

  const TOKEN_BODY = {
    supabase_url: "https://x.supabase.co",
    supabase_anon_key: "anon",
    workspace_id: "ws-1",
    access_token: "t",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user_id: "self-user",
    email: "api@machine",
  };

  function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
    const status = init.status ?? 200;
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (k: string) => init.headers?.[k.toLowerCase()] ?? null },
      json: async () => body,
    } as unknown as Response;
  }

  function changelogRow(id: string, createdAt = "2026-10-03T12:00:00Z"): ChangelogEventRow {
    return {
      id,
      workspace_id: "ws-1",
      chapter_id: "ch1",
      element_id: "el1",
      slice_id: "sl1",
      user_id: "someone-else",
      event_type: "element-description-changed",
      event_data: { type: "element-description-changed", elementName: "X" },
      created_at: createdAt,
    };
  }

  it("retries a failed seed after the 429 Retry-After window instead of staying silently unseeded", async () => {
    vi.useFakeTimers();
    const tmp = mkdtempSync(join(tmpdir(), "spec-stream-seed429-"));
    try {
      let chaptersCalls = 0;
      const impl = (async (url: string) => {
        if (url.includes("/realtime-token")) return json(TOKEN_BODY);
        if (url.includes("/chapters") && !url.includes("/chapters/")) {
          chaptersCalls++;
          if (chaptersCalls === 1) {
            return json({ error: "Rate limit exceeded." }, { status: 429, headers: { "retry-after": "2" } });
          }
          return json([]);
        }
        if (url.includes("/milestones")) return json([]);
        if (url.includes("/snippets")) return json([]);
        if (url.includes("/scenarios")) return json([]);
        if (url.includes("/catchup") || url.includes("/changelog")) return json([]);
        return json({}, { status: 404 });
      }) as unknown as typeof fetch;

      const cfg = validateConfig({
        endpoint: "https://flow.prooph-board.com/api",
        rules: [{ id: "spec", on: "*", run: "x" }],
        localSync: { enabled: true, dir: tmp },
      });
      const { logger, records } = silentLogger();
      const supa = supaMock();
      const app = new App({
        config: cfg,
        apiKey: "pb_x",
        logger,
        dryRun: true,
        fetchImpl: impl,
        createSupabase: supa.factory,
        rateLimiter: { minIntervalMs: 0 },
        reorderWindowMs: 0,
        catchUpCooldownMs: 0,
      });

      await app.start();
      await vi.advanceTimersByTimeAsync(1);

      // The first seed was rate-limited; the daemon must surface the degraded mirror
      // and schedule a retry rather than sitting silently unseeded.
      expect(records.find((r) => r.kind === "sync.seed_failed")).toBeDefined();
      expect(records.find((r) => r.kind === "sync.mirror_behind")).toBeDefined();
      expect(records.find((r) => r.kind === "sync.seed_retry")).toBeDefined();
      expect(chaptersCalls).toBe(1);
      const degraded = app.snapshot().localSync as { seeded?: boolean; behindSince?: string } | undefined;
      expect(degraded?.seeded).toBe(false);
      expect(degraded?.behindSince).toBeDefined();

      // After the Retry-After window the seed is retried and succeeds.
      await vi.advanceTimersByTimeAsync(2100);
      expect(chaptersCalls).toBeGreaterThanOrEqual(2);
      expect(records.find((r) => r.kind === "sync.seed_done")).toBeDefined();
      expect(records.find((r) => r.kind === "sync.mirror_current")).toBeDefined();
      const recovered = app.snapshot().localSync as { seeded?: boolean; behindSince?: string } | undefined;
      expect(recovered?.seeded).toBe(true);
      expect(recovered?.behindSince).toBeUndefined();

      await app.stop();
    } finally {
      vi.useRealTimers();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("leaves no zombie seed requests draining during the retry backoff", async () => {
    // Reproduces the live-log symptom: the parallel Promise.all seed queued every
    // scenario request in the rate limiter; when one failed, the queued leftovers
    // kept firing inside the retry backoff window, burning more quota.
    vi.useFakeTimers();
    const tmp = mkdtempSync(join(tmpdir(), "spec-stream-zombie-"));
    try {
      const CHAPTER_COUNT = 8;
      const calls: { url: string; t: number }[] = [];
      let scenarioCalls = 0;
      const impl = (async (url: string) => {
        calls.push({ url, t: Date.now() });
        if (url.includes("/realtime-token")) return json(TOKEN_BODY);
        if (url.includes("/scenarios")) {
          scenarioCalls++;
          if (scenarioCalls === 3) {
            return json({ error: "Rate limit exceeded." }, { status: 401 });
          }
          return json([]);
        }
        if (url.endsWith("/chapters")) {
          return json(
            Array.from({ length: CHAPTER_COUNT }, (_, i) => ({
              id: `c${i + 1}`, name: `Ch ${i + 1}`, index: i,
              context: "Ctx", mode: "event-modeling",
            })),
          );
        }
        if (url.includes("/chapters/")) {
          return json({
            id: url.split("/chapters/")[1], name: "Ch", index: 0,
            context: "Ctx", mode: "event-modeling",
            lanes: [], slices: [], elements: [],
          });
        }
        if (url.includes("/milestones")) return json([]);
        if (url.includes("/snippets")) return json([]);
        return json({}, { status: 404 });
      }) as unknown as typeof fetch;

      const cfg = validateConfig({
        endpoint: "https://flow.prooph-board.com/api",
        rules: [{ id: "spec", on: "*", run: "x" }],
        localSync: { enabled: true, dir: tmp },
      });
      const { logger, records } = silentLogger();
      const supa = supaMock();
      const app = new App({
        config: cfg,
        apiKey: "pb_x",
        logger,
        dryRun: true,
        fetchImpl: impl,
        createSupabase: supa.factory,
        // A non-zero interval makes limiter queuing observable under fake timers.
        rateLimiter: { minIntervalMs: 100 },
        reorderWindowMs: 0,
        catchUpCooldownMs: 0,
        seedRetryBackoff: new Backoff({ baseMs: 60_000, maxMs: 60_000, jitterMs: 0, random: () => 0 }),
      });

      const startP = app.start();
      // Let the seed run through its (throttled) requests until it fails.
      await vi.advanceTimersByTimeAsync(5_000);
      await startP;

      const failed = records.find((r) => r.kind === "sync.seed_failed");
      expect(failed).toBeDefined();
      const seedRetry = records.find((r) => r.kind === "sync.seed_retry");
      expect(seedRetry).toBeDefined();
      const failMs = Date.parse(failed!.ts);
      const retryAtMs = Date.parse(seedRetry!.retryAt as string);

      // Advance until just before the scheduled retry, then count requests that
      // fired *after* the seed had already failed — those are zombie drains from
      // the limiter queue burning quota inside the backoff window.
      await vi.advanceTimersByTimeAsync(retryAtMs - Date.now() - 1_000);
      const zombies = calls.filter((c) => c.t > failMs && c.t < retryAtMs);
      expect(zombies.map((z) => z.url)).toEqual([]);

      await app.stop();
    } finally {
      vi.useRealTimers();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("retries a rate-limited catch-up after Retry-After instead of waiting for the next reconnect", async () => {
    vi.useFakeTimers();
    try {
      const catchupCalls: string[] = [];
      let catchupAttempts = 0;
      const impl = (async (url: string) => {
        if (url.includes("/realtime-token")) return json(TOKEN_BODY);
        if (url.includes("/catchup") || url.includes("/changelog")) {
          catchupCalls.push(url);
          catchupAttempts++;
          if (catchupAttempts === 1) {
            return json({ error: "Rate limit exceeded." }, { status: 429, headers: { "retry-after": "2" } });
          }
          return json([changelogRow("missed-1")]);
        }
        return json({}, { status: 404 });
      }) as unknown as typeof fetch;

      const cfg = validateConfig({
        endpoint: "https://flow.prooph-board.com/api",
        rules: [{ id: "spec", on: "*", run: "x" }],
      });
      const { logger, records } = silentLogger();
      const supa = supaMock();
      const app = new App({
        config: cfg,
        apiKey: "pb_x",
        logger,
        dryRun: true,
        fetchImpl: impl,
        createSupabase: supa.factory,
        rateLimiter: { minIntervalMs: 0 },
        reorderWindowMs: 0,
        catchUpCooldownMs: 0,
      });

      await app.start();
      await vi.advanceTimersByTimeAsync(1); // first SUBSCRIBED

      // Establish the watermark, then simulate a re-subscribe that triggers catch-up.
      supa.emitRow(changelogRow("live-1", "2026-10-03T11:59:00Z"));
      await vi.advanceTimersByTimeAsync(1); // flush reorder buffer → watermark set
      supa.emitStatus("SUBSCRIBED");
      await vi.advanceTimersByTimeAsync(10);

      // The catch-up 429'd: lag must be surfaced and a retry scheduled for the
      // Retry-After window — the live socket stays SUBSCRIBED and would otherwise
      // never trigger another catch-up.
      expect(catchupCalls.length).toBe(1);
      expect(records.find((r) => r.kind === "conn.catchup_failed")).toBeDefined();
      expect(records.find((r) => r.kind === "sync.mirror_behind")).toBeDefined();
      expect(records.find((r) => r.kind === "conn.catchup_retry")).toBeDefined();

      await vi.advanceTimersByTimeAsync(2100);
      expect(catchupCalls.length).toBe(2);
      const catchup = records.find((r) => r.kind === "conn.catchup");
      expect(catchup).toMatchObject({ fetched: 1, replayed: 1 });
      expect(records.find((r) => r.kind === "sync.mirror_current")).toBeDefined();

      await app.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to a full re-seed after catch-up fails a bounded number of times", async () => {
    vi.useFakeTimers();
    const tmp = mkdtempSync(join(tmpdir(), "spec-stream-reseed-"));
    try {
      let catchupAttempts = 0;
      let chaptersCalls = 0;
      const impl = (async (url: string) => {
        if (url.includes("/realtime-token")) return json(TOKEN_BODY);
        if (url.includes("/catchup") || url.includes("/changelog")) {
          catchupAttempts++;
          return json({ error: "Rate limit exceeded." }, { status: 429, headers: { "retry-after": "1" } });
        }
        if (url.includes("/chapters") && !url.includes("/chapters/")) {
          chaptersCalls++;
          return json([]);
        }
        if (url.includes("/milestones")) return json([]);
        if (url.includes("/snippets")) return json([]);
        if (url.includes("/scenarios")) return json([]);
        return json({}, { status: 404 });
      }) as unknown as typeof fetch;

      const cfg = validateConfig({
        endpoint: "https://flow.prooph-board.com/api",
        rules: [{ id: "spec", on: "*", run: "x" }],
        localSync: { enabled: true, dir: tmp },
      });
      const { logger, records } = silentLogger();
      const supa = supaMock();
      const app = new App({
        config: cfg,
        apiKey: "pb_x",
        logger,
        dryRun: true,
        fetchImpl: impl,
        createSupabase: supa.factory,
        rateLimiter: { minIntervalMs: 0 },
        reorderWindowMs: 0,
        catchUpCooldownMs: 0,
      });

      await app.start();
      await vi.advanceTimersByTimeAsync(1);
      expect(chaptersCalls).toBe(1); // initial seed

      supa.emitRow(changelogRow("live-1", "2026-10-03T11:59:00Z"));
      await vi.advanceTimersByTimeAsync(1); // flush reorder buffer → watermark set
      supa.emitStatus("SUBSCRIBED");
      await vi.advanceTimersByTimeAsync(10);
      expect(catchupAttempts).toBe(1); // fail #1

      // Each retry is ~1 s out (retry-after: 1). After the bounded number of
      // consecutive failures the daemon must escalate to a full re-seed.
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(1100);
      }
      expect(records.find((r) => r.kind === "conn.catchup_reseed")).toBeDefined();
      expect(chaptersCalls).toBeGreaterThanOrEqual(2); // re-seed ran
      await vi.advanceTimersByTimeAsync(10);
      expect(records.find((r) => r.kind === "sync.mirror_current")).toBeDefined();
      // The 5th failure escalated; no further catch-up retries are pending.
      expect(catchupAttempts).toBeLessThanOrEqual(5);

      await app.stop();
    } finally {
      vi.useRealTimers();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
