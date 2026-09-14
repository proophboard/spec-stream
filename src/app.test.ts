import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { App } from "./app.js";
import { validateConfig } from "./config/schema.js";
import { Logger, type LogRecord } from "./logging/logger.js";
import type { SupabaseLike, ChannelLike } from "./realtime/client.js";
import type { ChangelogEventRow } from "./realtime/events.js";

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
    supa.emitRow(row({ user_id: "self-user" }));
    await new Promise((r) => setTimeout(r, 5));
    expect(records.map((r) => r.kind)).not.toContain("command.dry_run");
    expect(app.snapshot().received).toBe(1); // received but not acted upon

    // Event from another user -> runs
    supa.emitRow(row({ user_id: "someone-else" }));
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
