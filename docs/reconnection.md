# Reconnection & Reliability

`spec-stream` is a long-running supervisor. Once healthy, it stays connected until you
stop it. This document defines how it handles connection loss, token expiry, and other
runtime failures.

> See `AGENT.md` §9 for the philosophy: **infinite resilience for transient/runtime
> errors; fail-fast for startup misconfiguration.**

## Connection lifecycle

`spec-stream` mirrors prooph board's own realtime handling:

1. Subscribe to `changelog:{workspaceId}`.
2. Track the channel state. Healthy = `joined`/`SUBSCRIBED`.
3. On `CHANNEL_ERROR` or `TIMED_OUT`, begin reconnection.
4. A **health check every 30 s** re-subscribes if the channel is not `joined` (covers
   silent drops, laptop sleep/wake, network changes).

## Backoff policy

Reconnection uses **capped exponential backoff with jitter** and retries **indefinitely**:

- Base delay ≈ 1 s.
- Each attempt doubles the delay: 1s, 2s, 4s, 8s, … plus a small random jitter.
- Capped at **30 minutes** — the tool keeps retrying at most every 30 minutes forever.
- The backoff resets to base once a connection is re-established.

```
attempt  1     2     3     4     5     6      7      8      ...   n
delay    1s    2s    4s    8s    16s   32s    64s    128s   ...  ≤30min (cap)
```

This satisfies the requirement to keep retrying up to a 30-minute interval and never
give up on transient failures.

## On reconnect: catch up on missed events

Realtime only delivers events that occur **while subscribed**. After a disconnect,
events inserted during the gap were not received. On successful re-subscribe,
`spec-stream`:

1. Records the timestamp of the last event it processed before the drop.
2. Fetches changelog events created **after** that timestamp via the prooph board API
   (bounded query), and feeds them through the router/scheduler as if received live.
3. Resumes live streaming.

This "replay the gap" step prevents silently missing changes across a reconnect. If the
catch-up query fails, it is retried under the same backoff; live streaming still resumes.

## Token expiry & auth failures

- The session is refreshed proactively before `expires_at`
  (see [`authentication.md`](./authentication.md)).
- On `TOKEN_EXPIRED` / auth errors, the full token exchange is re-run using the `pb_…`
  key, under the same backoff policy.
- A **revoked** key produces persistent `401`s: `spec-stream` keeps retrying and logs a
  clear, repeated `error` (and reflects it in `status`), but a *running* process does not
  exit. (An already-revoked key at **startup** fails fast.)

## Command failures don't affect the connection

The realtime connection and command execution are independent. A crashing/timing-out
command is caught, logged at `error`, and the loop continues. Command failures never
trigger a reconnect and never stop the stream.

## Degraded polling mode (fallback)

If realtime cannot be established at all (e.g. the token endpoint or WebSocket is
unavailable in the environment), `spec-stream` can fall back to **polling** the prooph
board API for new changelog events on an interval. This is a last resort:

- Higher latency than realtime.
- Uses REST rate limits.
- Enabled explicitly (e.g. `--poll` / config `transport: "poll"`), or entered
  automatically after a configurable number of failed realtime attempts.

Realtime via the token endpoint remains the primary, intended transport.

## What is fatal (startup only)

These cause a **non-zero exit at startup** because retrying cannot help:

- No config file found / invalid config.
- No `PROOPHBOARD_API_KEY` present.
- Token endpoint returns `401` for the key on the very first exchange (invalid/revoked
  key) — reported clearly so the user can fix it.

Everything else is treated as transient and handled by the loops above.

## Observability

- Every connection state change is logged (`conn.state`) and counted.
- `spec-stream status` reports: running/stopped, connection state, uptime, current
  backoff delay, events received, commands run/failed, last event time.
