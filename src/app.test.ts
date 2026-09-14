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

function tokenFetch(): typeof fetch {
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
