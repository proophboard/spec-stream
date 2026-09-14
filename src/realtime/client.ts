/**
 * Realtime client: thin wrapper over supabase-js that subscribes to the prooph board
 * changelog stream for a workspace and emits normalized {@link ChangelogEvent}s.
 *
 * Faithful to prooph board: channel `changelog:{workspaceId}`, `postgres_changes` INSERT
 * on `public.changelog_events` filtered by `workspace_id=eq.{id}`.
 *
 * The supabase client factory and token provider are injected so this is testable with a
 * mock realtime client. Reconnection uses {@link Backoff} (capped at 30 min).
 */

import { normalizeRow, type ChangelogEvent, type ChangelogEventRow } from "./events.js";
import { Backoff } from "../util/backoff.js";

/** Minimal shape of the supabase client we depend on (keeps us decoupled + testable). */
export interface SupabaseLike {
  realtime: { setAuth(token: string): Promise<void> | void };
  channel(topic: string): ChannelLike;
  removeChannel(channel: ChannelLike): void;
}

export interface ChannelLike {
  on(
    type: "postgres_changes",
    filter: { event: string; schema: string; table: string; filter: string },
    callback: (payload: { new: ChangelogEventRow }) => void,
  ): ChannelLike;
  subscribe(callback: (status: string, err?: Error) => void): ChannelLike;
}

export type SupabaseFactory = (url: string, anonKey: string) => SupabaseLike;

export interface RealtimeClientOptions {
  supabaseUrl: string;
  supabaseAnonKey: string;
  workspaceId: string;
  accessToken: string;
  createClient: SupabaseFactory;
  onEvent: (event: ChangelogEvent) => void;
  /** Called on connection state transitions (for logging/status). */
  onStatus?: (status: string, err?: Error) => void;
  /** Called when the client decides to reconnect after `delayMs`. */
  onReconnectScheduled?: (delayMs: number, attempt: number) => void;
  backoff?: Backoff;
  timers?: {
    setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimeout: (h: ReturnType<typeof setTimeout>) => void;
  };
}

const realTimers = {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (h: ReturnType<typeof setTimeout>) => clearTimeout(h),
};

const RECONNECT_STATUSES = new Set(["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"]);

export class RealtimeClient {
  private client: SupabaseLike;
  private channel?: ChannelLike;
  private accessToken: string;
  private readonly backoff: Backoff;
  private readonly timers: NonNullable<RealtimeClientOptions["timers"]>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private connected = false;

  constructor(private readonly opts: RealtimeClientOptions) {
    this.client = opts.createClient(opts.supabaseUrl, opts.supabaseAnonKey);
    this.accessToken = opts.accessToken;
    this.backoff = opts.backoff ?? new Backoff();
    this.timers = opts.timers ?? realTimers;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Subscribe to the changelog channel. Idempotent-ish: removes any prior channel first. */
  async connect(): Promise<void> {
    this.stopped = false;
    await this.client.realtime.setAuth(this.accessToken);
    this.openChannel();
  }

  private openChannel(): void {
    if (this.channel) {
      this.client.removeChannel(this.channel);
      this.channel = undefined;
    }

    const channel = this.client.channel(`changelog:${this.opts.workspaceId}`);
    channel.on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "changelog_events",
        filter: `workspace_id=eq.${this.opts.workspaceId}`,
      },
      (payload) => this.handleRow(payload.new),
    );
    channel.subscribe((status, err) => this.handleStatus(status, err));
    this.channel = channel;
  }

  private handleRow(row: ChangelogEventRow): void {
    let event: ChangelogEvent;
    try {
      event = normalizeRow(row);
    } catch {
      // Malformed row: skip, never fatal.
      return;
    }
    this.opts.onEvent(event);
  }

  private handleStatus(status: string, err?: Error): void {
    this.opts.onStatus?.(status, err);
    if (status === "SUBSCRIBED") {
      this.connected = true;
      this.backoff.reset();
      return;
    }
    if (RECONNECT_STATUSES.has(status) && !this.stopped) {
      this.connected = false;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return;
    const delay = this.backoff.nextDelay();
    this.opts.onReconnectScheduled?.(delay, this.backoff.attempts);
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.stopped) this.openChannel();
    }, delay);
  }

  /** Update the access token after a renewal and re-auth the socket. */
  async updateToken(accessToken: string): Promise<void> {
    this.accessToken = accessToken;
    await this.client.realtime.setAuth(accessToken);
  }

  /** Stop reconnecting and remove the channel. */
  async disconnect(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.channel) {
      this.client.removeChannel(this.channel);
      this.channel = undefined;
    }
    this.connected = false;
  }
}
