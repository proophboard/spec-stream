import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { App } from "./app.js";
import { validateConfig } from "./config/schema.js";
import { Logger, type LogRecord } from "./logging/logger.js";
import type { SupabaseLike, ChannelLike } from "./realtime/client.js";
import type { ChangelogEventRow } from "./realtime/events.js";
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

  /** Fetch mock: serves the token endpoint and a canned /changelog page. */
  function routingFetch(changelogRows: unknown[]): { impl: typeof fetch; changelogCalls: string[] } {
    const changelogCalls: string[] = [];
    const impl = (async (url: string) => {
      if (url.includes("/changelog")) {
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
    const app = new App({ config: cfg, apiKey: "pb_x", logger, dryRun: true, fetchImpl: impl, createSupabase: supa.factory, rateLimiter: { minIntervalMs: 0 } });

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
    const app = new App({ config: cfg, apiKey: "pb_x", logger, dryRun: true, fetchImpl: impl, createSupabase: supa.factory, rateLimiter: { minIntervalMs: 0 } });
    await app.start();
    await new Promise((r) => setTimeout(r, 5));
    expect(changelogCalls.length).toBe(0);
    expect(records.find((r) => r.kind === "conn.catchup")).toBeUndefined();
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
        if (url.includes("/changelog")) {
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
      const app = new App({ config: cfg, apiKey: "pb_x", logger, dryRun: true, fetchImpl: impl, createSupabase: supa.factory, rateLimiter: { minIntervalMs: 0 } });

      await app.start();
      await new Promise((r) => setTimeout(r, 5));
      expect(records.find((r) => r.kind === "sync.resumed")).toMatchObject({ since: "2026-10-02T09:00:00Z" });

      // Reconnect before any live event — catch-up must use the resumed cursor as `since`.
      supa.emitStatus("CLOSED");
      supa.emitStatus("SUBSCRIBED");
      await new Promise((r) => setTimeout(r, 10));
      expect(changelogCalls.length).toBe(1);
      expect(changelogCalls[0]).toContain("since=2026-10-02T09%3A00%3A00Z");

      await app.stop();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
