import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RealtimeClient, type SupabaseLike, type ChannelLike } from "./client.js";
import type { ChangelogEventRow } from "./events.js";
import { Backoff } from "../util/backoff.js";

/** A controllable mock supabase client + channel. */
function mockSupabase() {
  const state = {
    setAuthCalls: [] as string[],
    channels: [] as MockChannel[],
    removed: [] as MockChannel[],
    onFilter: undefined as unknown,
  };

  class MockChannel implements ChannelLike {
    rowCb?: (payload: { new: ChangelogEventRow }) => void;
    statusCb?: (status: string, err?: Error) => void;
    on(_type: "postgres_changes", filter: unknown, cb: (p: { new: ChangelogEventRow }) => void) {
      state.onFilter = filter;
      this.rowCb = cb;
      return this;
    }
    subscribe(cb: (status: string, err?: Error) => void) {
      this.statusCb = cb;
      return this;
    }
    emitRow(row: ChangelogEventRow) {
      this.rowCb?.({ new: row });
    }
    emitStatus(status: string, err?: Error) {
      this.statusCb?.(status, err);
    }
  }

  const client: SupabaseLike = {
    realtime: {
      setAuth: (token: string) => {
        state.setAuthCalls.push(token);
      },
    },
    channel: (_topic: string) => {
      const ch = new MockChannel();
      state.channels.push(ch);
      return ch;
    },
    removeChannel: (ch) => {
      state.removed.push(ch as MockChannel);
    },
  };

  return { client, state };
}

function row(overrides: Partial<ChangelogEventRow> = {}): ChangelogEventRow {
  return {
    id: "r1",
    workspace_id: "ws-1",
    chapter_id: "ch1",
    element_id: "el1",
    slice_id: "sl1",
    user_id: "u1",
    event_type: "element-added",
    event_data: { type: "element-added" },
    created_at: "2026-09-14T10:00:00Z",
    ...overrides,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("RealtimeClient", () => {
  it("subscribes to changelog:{workspaceId} with the correct filter", async () => {
    const { client, state } = mockSupabase();
    const events: string[] = [];
    const rc = new RealtimeClient({
      supabaseUrl: "u",
      supabaseAnonKey: "a",
      workspaceId: "ws-1",
      accessToken: "tok-1",
      createClient: () => client,
      onEvent: (e) => events.push(e.type),
    });
    await rc.connect();
    expect(state.setAuthCalls).toEqual(["tok-1"]);
    expect(state.channels).toHaveLength(1);
    expect(state.onFilter).toMatchObject({
      event: "INSERT",
      schema: "public",
      table: "changelog_events",
      filter: "workspace_id=eq.ws-1",
    });
  });

  it("emits normalized events for incoming rows", async () => {
    const { client, state } = mockSupabase();
    const events: string[] = [];
    const rc = new RealtimeClient({
      supabaseUrl: "u",
      supabaseAnonKey: "a",
      workspaceId: "ws-1",
      accessToken: "t",
      createClient: () => client,
      onEvent: (e) => events.push(e.type),
    });
    await rc.connect();
    state.channels[0].emitRow(row({ event_type: "slice-added", event_data: { type: "slice-added" } }));
    expect(events).toEqual(["slice-added"]);
  });

  it("skips malformed rows without throwing", async () => {
    const { client, state } = mockSupabase();
    const events: string[] = [];
    const rc = new RealtimeClient({
      supabaseUrl: "u",
      supabaseAnonKey: "a",
      workspaceId: "ws-1",
      accessToken: "t",
      createClient: () => client,
      onEvent: (e) => events.push(e.type),
    });
    await rc.connect();
    // Missing workspace_id -> normalizeRow throws -> skipped
    expect(() =>
      state.channels[0].emitRow(row({ workspace_id: "" } as Partial<ChangelogEventRow>)),
    ).not.toThrow();
    expect(events).toEqual([]);
  });

  it("marks connected on SUBSCRIBED and resets backoff", async () => {
    const { client, state } = mockSupabase();
    const rc = new RealtimeClient({
      supabaseUrl: "u",
      supabaseAnonKey: "a",
      workspaceId: "ws-1",
      accessToken: "t",
      createClient: () => client,
      onEvent: () => {},
    });
    await rc.connect();
    expect(rc.isConnected).toBe(false);
    state.channels[0].emitStatus("SUBSCRIBED");
    expect(rc.isConnected).toBe(true);
  });

  it("reconnects with backoff on CHANNEL_ERROR", async () => {
    const { client, state } = mockSupabase();
    const scheduled: number[] = [];
    const rc = new RealtimeClient({
      supabaseUrl: "u",
      supabaseAnonKey: "a",
      workspaceId: "ws-1",
      accessToken: "t",
      createClient: () => client,
      onEvent: () => {},
      backoff: new Backoff({ baseMs: 1000, jitterMs: 0 }),
      onReconnectScheduled: (delay) => scheduled.push(delay),
    });
    await rc.connect();
    state.channels[0].emitStatus("CHANNEL_ERROR");
    expect(scheduled).toEqual([1000]);

    // advancing the timer opens a new channel
    vi.advanceTimersByTime(1000);
    expect(state.channels).toHaveLength(2);
    expect(state.removed).toHaveLength(1); // old channel removed
  });

  it("does not reconnect after disconnect()", async () => {
    const { client, state } = mockSupabase();
    const scheduled: number[] = [];
    const rc = new RealtimeClient({
      supabaseUrl: "u",
      supabaseAnonKey: "a",
      workspaceId: "ws-1",
      accessToken: "t",
      createClient: () => client,
      onEvent: () => {},
      onReconnectScheduled: (d) => scheduled.push(d),
    });
    await rc.connect();
    await rc.disconnect();
    state.channels[0].emitStatus("CHANNEL_ERROR");
    expect(scheduled).toEqual([]);
    expect(rc.isConnected).toBe(false);
  });

  it("updateToken re-auths the socket", async () => {
    const { client, state } = mockSupabase();
    const rc = new RealtimeClient({
      supabaseUrl: "u",
      supabaseAnonKey: "a",
      workspaceId: "ws-1",
      accessToken: "t1",
      createClient: () => client,
      onEvent: () => {},
    });
    await rc.connect();
    await rc.updateToken("t2");
    expect(state.setAuthCalls).toEqual(["t1", "t2"]);
  });
});
