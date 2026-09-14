# AGENT.md — proophboard/spec-stream

> This document is the source of truth for the **idea** and **overall architecture** of
> `@proophboard/spec-stream`. Read it before implementing or changing anything.
> Human contributors and AI coding agents should keep this file in sync with the design.

---

## 1. What is spec-stream?

`spec-stream` is a lightweight, open-source command-line tool that turns **changes made
on a [prooph board](https://prooph-board.com) event model into local CLI command
invocations** — in real time.

prooph board is a collaborative event modeling tool. Every change a user makes to a
board (adding a sticky note, editing a description, renaming an element, moving things
around, commenting, …) is recorded as a **changelog event** and broadcast to all
connected clients through Supabase Realtime.

`spec-stream` connects to that same realtime stream from a terminal using a **prooph
board API key**, and — based on a **config file** — runs a shell command for each event
it cares about. Those commands typically **invoke an AI coding agent** (Claude Code,
Kiro, Codex, Aider, a custom script, …) that acts on the change.

### The core loop

```
prooph board change  ──▶  changelog event  ──▶  Supabase Realtime
                                                      │
                                                      ▼
                                             spec-stream (this tool)
                                                      │  match event → command mapping
                                                      ▼
                                             spawn configured CLI command
                                                      │
                                                      ▼
                                             AI agent / script does the work
```

### The motivating scenario

> A developer models a feature on prooph board. They write a specification into the
> description of a command sticky note. On save, prooph board emits an
> `element-description-changed` event. `spec-stream`, running on the developer's
> machine (or a build server), receives the event and starts an AI agent that
> implements the described change in the codebase, opens a pull request, and reports
> back.
>
> The developer can be **away from their machine** — editing the board from a phone or
> tablet. Their edits stream to `spec-stream` and agents start working automatically.
> This is "spec-driven development", continuously streamed.

`spec-stream` is the **bridge** between a modeling tool and an automation runtime. It is
deliberately unopinionated about *what* the commands do — it only guarantees a reliable,
observable, long-running connection and a predictable event→command execution model.

---

## 2. Design goals & principles

1. **Lightweight.** Minimal dependencies, fast cold start via `npx`, small install size.
   The tool is a thin, robust event router — not a framework.
2. **Never die silently.** Once started, `spec-stream` runs until the user stops it.
   Connection loss, command failures, and malformed events must never crash the loop.
   (See §9 for why this is a deliberate, bounded choice and not "swallow all errors".)
3. **Standards-based CLI UX.** Behaves like a well-mannered Unix daemon: foreground by
   default, optional background mode, PID file, `start`/`stop`/`status`/`logs`
   subcommands, graceful shutdown on `SIGINT`/`SIGTERM`, XDG-compliant paths.
4. **Observable.** Every received event and every command invocation is logged both to
   the terminal (human-readable) and to a log folder (structured, rotated).
5. **Safe by default.** Secrets come from the environment, never from the committed
   config file. Commands are opt-in per event type; nothing runs unless configured.
6. **Controllable concurrency.** Users can run multiple agents in parallel for unrelated
   work, but must be able to **queue, debounce, and deduplicate** to avoid two agents
   fighting over the same task (see §7).

### Non-goals

- `spec-stream` does not write back to prooph board. (Agents may do so themselves via
  the prooph board REST API / MCP server, but that is out of scope for this tool.)
- It is not a general-purpose workflow engine or job scheduler.
- It does not interpret the *semantics* of a changelog event beyond routing.

---

## 3. How spec-stream connects to prooph board (public contract)

`spec-stream` builds only on prooph board's **public interface**. It does not depend on
any private implementation details.

### 3.1 Realtime transport

- prooph board exposes a realtime changelog stream backed by **Supabase Realtime**, and
  `spec-stream` connects with the standard **`@supabase/supabase-js`** client.
- It subscribes to the workspace's changelog channel and receives one message per
  change. Each message carries a changelog record with a stable envelope
  (`event_type`/`type`, workspace, chapter, element and slice identifiers, the actor, a
  timestamp, and the full event payload). See [`docs/event-reference.md`](./docs/event-reference.md)
  for the fields `spec-stream` relies on.

### 3.2 Authentication

- A prooph board **API key** (format `pb_…`) is created by a workspace admin and scoped
  to one workspace. The key's access (read-only vs. write) is chosen at creation time.
- The realtime stream is authorized with a **short-lived access token**, not the API key
  directly. prooph board provides a public **token endpoint** that accepts the API key
  and returns a token, the connection details, and the key's **user identity**
  (`user_id`/`email`) that `spec-stream` uses to filter out its own writes (see §6.1).
- `spec-stream` treats the exchange as an opaque HTTP call: send the key, receive a
  short-lived token. It does not know or care how prooph board issues that token.

### 3.3 Consequence for spec-stream

> `spec-stream` never uses the raw API key to talk to Supabase directly. It exchanges the
> key for a short-lived token via the public endpoint, uses that token to authorize the
> realtime connection, and renews it before expiry by calling the endpoint again. The API
> key is the single credential the user manages; revoking it stops the stream.

---

## 4. High-level architecture

`spec-stream` is a single long-running Node.js process composed of small, testable
modules. Data flows left to right; control (shutdown, reconnect) flows through the
Supervisor.

```
                         ┌──────────────────────────────────────────────────────┐
                         │                     spec-stream                        │
                         │                                                        │
  env (.env/process)     │   ┌───────────┐    ┌───────────────┐                   │
  PROOPHBOARD_API_KEY ───┼──▶│  Config   │    │   Token        │  exchange pb_ key │
  proophboard.spec-      │   │  Loader   │───▶│   Exchanger    │──────────────────▶│──▶ prooph board
  stream.json ───────────┼──▶│(discover, │    │ (pb_ → token,  │◀──────────────────│    /api/realtime-token
                         │   │ validate) │    │  renew loop)   │  token + url      │
                         │   └───────────┘    └───────┬───────┘                   │
                         │                            │ access_token              │
                         │                            ▼                           │
                         │                   ┌──────────────────┐   realtime       │
                         │                   │ Realtime Client  │   changelog      │
                         │                   │ (supabase-js,    │◀─────────────────│──▶ Supabase Realtime
                         │                   │  channel +       │   changelog      │    (prooph board)
                         │                   │  reconnect)      │   message        │
                         │                   └────────┬─────────┘                  │
                         │                            │ ChangelogEvent             │
                         │                            ▼                            │
                         │                   ┌──────────────────┐                  │
                         │                   │  Event Router    │  match event →   │
                         │                   │ (mapping rules,  │  rule(s)         │
                         │                   │  filters)        │                  │
                         │                   └────────┬─────────┘                  │
                         │                            │ MatchedTask                │
                         │                            ▼                            │
                         │                   ┌──────────────────┐                  │
                         │                   │  Scheduler       │  queue / debounce│
                         │                   │ (per-key queues, │  / dedupe /      │
                         │                   │  concurrency)    │  batch           │
                         │                   └────────┬─────────┘                  │
                         │                            │ ready-to-run               │
                         │                            ▼                            │
                         │                   ┌──────────────────┐   spawn          │
                         │                   │  Command Runner  │─────────────────▶│──▶ AI agent / shell command
                         │                   │ (spawn, env,     │   stdout/stderr  │    (child process)
                         │                   │  capture, cwd)   │◀─────────────────│
                         │                   └────────┬─────────┘                  │
                         │                            │ result                     │
                         │                            ▼                            │
                         │                   ┌──────────────────┐                  │
                         │                   │  Logger          │──────────────────│──▶ terminal + log folder
                         │                   │ (pretty + JSONL, │                  │
                         │                   │  rotation)       │                  │
                         │                   └──────────────────┘                  │
                         │                                                         │
                         │   ┌──────────────────────────────────────────────┐     │
                         │   │  Supervisor / Lifecycle                        │     │
                         │   │  (PID file, signals, graceful drain, backoff)  │     │
                         │   └──────────────────────────────────────────────┘     │
                         └──────────────────────────────────────────────────────┘
```

### 4.1 Components

| Component | Responsibility |
|-----------|----------------|
| **Config Loader** | Discover and parse `proophboard.spec-stream.json`; validate schema; merge CLI flags & env; resolve the API key from the environment (never from the file). |
| **Token Exchanger** | Trade the `pb_…` key for a short-lived access token against the prooph board token endpoint. Proactively renew before expiry by re-presenting the key (no refresh token). Surfaces `workspaceId`, Supabase URL and anon key. |
| **Realtime Client** | Thin wrapper over `supabase-js`: authorize with the access token, subscribe to the workspace's changelog channel, normalize each incoming message into a typed `ChangelogEvent`, emit to the router. Owns reconnect/backoff and health checks. |
| **Event Router** | Evaluate the configured mapping rules against each event (by `type`, and optional filters like `context`, `chapterId`, `elementType`). Produce zero or more `MatchedTask`s. |
| **Scheduler** | Apply per-rule concurrency, queueing, debouncing, deduplication and optional batching (see §7). Decides *when* a matched task actually runs. |
| **Command Runner** | Spawn the configured command as a child process with a controlled environment (event data injected as env vars / stdin), capture stdout/stderr, enforce timeouts, and report the result. Never throws into the loop. |
| **Logger** | Dual-sink logging: pretty, colorized output to the terminal (when TTY) and structured JSONL to rotating log files. Also writes per-command logs. |
| **Supervisor / Lifecycle** | Owns the process: writes/reads the PID file, handles `start`/`stop`/`status`/`logs`, background (detached) mode, signal handling, and graceful shutdown (drain running commands, then exit). |

### 4.2 Module boundaries (intended source layout)

```
src/
  cli.ts               # arg parsing, subcommand dispatch (start/stop/status/logs/run)
  config/
    load.ts            # discovery + read + merge
    schema.ts          # config type + validation
  auth/
    tokenExchange.ts   # pb_ key → short-lived access token, renewal loop
  realtime/
    client.ts          # supabase-js wrapper, channel, reconnect
    events.ts          # ChangelogEvent types + payload normalization
  routing/
    router.ts          # event → matched rules
    filters.ts         # filter predicates
  scheduler/
    scheduler.ts       # queue/debounce/dedupe/batch, concurrency
    keys.ts            # concurrency-key derivation
  runner/
    command.ts         # child_process spawn + capture + timeout
    context.ts         # event → command env/stdin payload
  logging/
    logger.ts          # pretty + JSONL sinks
    rotate.ts          # size-based rotation
  lifecycle/
    supervisor.ts      # PID file, signals, graceful drain
    daemon.ts          # detached spawn for background mode
    paths.ts           # XDG / project-local path resolution
  index.ts             # wiring / bootstrap
```

> This layout is a target, not a contract. Keep modules small and independently
> testable. If you deviate, update this section.

---

## 5. Authentication flow (token endpoint)

`spec-stream` authenticates by exchanging the API key for a short-lived token at prooph
board's public token endpoint, then uses that token to authorize the realtime
connection.

**Request:**

```
POST {endpoint}/realtime-token
Authorization: Bearer pb_xxxxxxxx…
```

`{endpoint}` is the prooph board **API base URL** from the config (e.g.
`https://flow.prooph-board.com/api`).

**Response `200`:**

```jsonc
{
  "supabase_url": "https://…",           // Supabase project URL to connect to
  "supabase_anon_key": "…",              // publishable key, safe for clients
  "workspace_id": "…",                    // the key's workspace
  "user_id": "…",                         // the key's user id (for own-write filtering)
  "email": "…",                           // the key's user email (command context)
  "access_token": "…",                    // SHORT-LIVED token authorizing realtime
  "expires_at": 1737045600                // unix seconds
}
```

**Error responses:** `401` (invalid/revoked key — fatal at startup), `429` (rate
limited — retry with backoff), `5xx` (retry with backoff).

> **No refresh token is issued — by design.** Returning only a short-lived access token
> keeps the `pb_…` API key as the *single* credential the user manages, so revoking the
> key stops the stream within one token lifetime. The token carries exactly the access
> the user chose for the key (**a read-only key is recommended for spec-stream**, but a
> write-capable key is allowed if the user wants triggered agents to write back).

`spec-stream` then:

1. Calls the endpoint once on startup to obtain the access token + connection info.
2. Creates the supabase-js client with `supabase_url` + `supabase_anon_key` and
   `autoRefreshToken: false` (there is no refresh token).
3. Calls `supabase.realtime.setAuth(access_token)` and subscribes to the workspace's
   changelog channel.
4. Renews by **re-presenting the `pb_` key** to the endpoint at ~75% of the token
   lifetime, then `realtime.setAuth(newAccessToken)` (seamless, no reconnect). On any
   auth error it re-runs the exchange; on endpoint failure it retries under backoff.

**Fallback (documented, not preferred):** if realtime is unavailable, `spec-stream` can
poll the prooph board API for new changelog events. This is a degraded mode only; the
user explicitly wants realtime, so the token-exchange path is primary.

---

## 6. Event model & routing

`spec-stream` receives the full prooph board `ChangelogEvent` union (~50 types). The
complete, current list and payload shapes live in
[`docs/event-reference.md`](./docs/event-reference.md). The common envelope is:

```ts
interface ChangelogEventBase {
  id: string;
  type: ChangelogEventType;          // e.g. 'element-description-changed'
  timestamp: number;
  chapterId: string | null;
  chapterName: string;
  userId?: string;
  workspaceId?: string;
  elementId?: string;
  sliceId?: string;
  addedByAgent?: boolean;            // event was produced by an automated actor
  revertOf?: string;                 // undo/redo tracking
  // + event-specific oldValue / newValue
}
```

A **mapping rule** ties an event pattern to a command. Rules are evaluated top to bottom;
zero or more may match a single event. Full schema in
[`docs/config-schema.md`](./docs/config-schema.md). Sketch:

```jsonc
{
  "on": "element-description-changed",     // type or array of types or "*"
  "when": {                                 // optional filters (all must match)
    "elementType": ["command", "event"],
    "context": "Ordering"
  },
  "run": "kiro agent --task \"$SPEC_STREAM_ELEMENT_NAME\"",
  "cwd": "./",                              // optional working directory
  "concurrency": { "key": "element", "mode": "debounce", "wait": 5000 }
}
```

Event data is passed to the command via environment variables (prefixed
`SPEC_STREAM_`, e.g. `SPEC_STREAM_EVENT_TYPE`, `SPEC_STREAM_ELEMENT_ID`,
`SPEC_STREAM_ELEMENT_NAME`, `SPEC_STREAM_CHAPTER_ID`) and the full event JSON on
**stdin**. The exact contract is in [`docs/command-context.md`](./docs/command-context.md).

> **Guarding against feedback loops:** by default a rule does **not** match changelog
> events made by spec-stream's own API-key user (same user id) — so an agent's own writes
> back to the board don't re-trigger the rule that started it. A rule can opt in with
> `consumeOwnEvents: true`. (`addedByAgent` is a separate, optional filter, not the
> self-guard.) See §6.1.

### 6.1 Self-event filtering

Each API key has its own **user identity** (returned by the token endpoint as `user_id`).
`spec-stream` uses it to tell apart *its own* writes to the board from everyone else's:

- **Default:** a rule ignores events whose `userId` equals the key's own `user_id`. This
  is the primary guard against feedback loops — when a triggered agent writes back to the
  board (via the API/MCP under the same key), those changes do not re-trigger rules.
- **Opt-in:** set `consumeOwnEvents: true` on a rule to also react to the key's own events.
- **Unknown identity:** if the endpoint doesn't provide `user_id`, self-filtering is off
  (nothing is treated as "self") and a warning is logged.
- The identity is exposed to commands as `SPEC_STREAM_SELF_USER_ID` / `SPEC_STREAM_SELF_EMAIL`.

This replaces the earlier `addedByAgent`-based guard: `addedByAgent` is now just an
optional `when` filter, while same-user filtering is the default self-guard.

---

## 7. Concurrency: queue, debounce, dedupe, batch

This is the subtle part and a first-class design concern. The problem:

> A user edits a sticky note description and saves → `element-description-changed` fires
> → an agent starts implementing it. The user edits the same note again while the agent
> is still working → a second event fires. We must **not** start a second agent on the
> same task. But an edit to an **unrelated** element **should** be free to start its own
> agent in parallel.

### 7.1 Concurrency keys

Every matched task is assigned a **concurrency key**. The key defines the "lane" the task
runs in. Tasks with the same key are serialized/coalesced; tasks with different keys are
independent. Configurable derivations:

- `element` → key = `elementId` (default for element events): edits to the *same* sticky
  note are coalesced; different elements run in parallel.
- `slice` → key = `sliceId`.
- `chapter` → key = `chapterId`.
- `global` → single key for the whole rule: fully serialized.
- `custom` → a template string, e.g. `"$SPEC_STREAM_CHAPTER_ID:$SPEC_STREAM_ELEMENT_TYPE"`.

### 7.2 Modes (per rule, applied within a key)

| Mode | Behavior |
|------|----------|
| `parallel` | Run immediately, no coordination. Use for independent, idempotent commands. |
| `queue` | Run one at a time per key; additional matches wait in FIFO order. |
| `debounce` | Wait `wait` ms of quiet after the last matching event, then run once with the **latest** event. Bursts of edits collapse into a single run. **Recommended default for description edits.** |
| `dedupe` | While a command for this key is running, drop (or optionally keep-last) further matches. Prevents two agents on the same task. |
| `batch` | Collect matches for `wait` ms (or up to `maxBatch`), then run **once** with the whole batch passed to the command. Useful for "N elements changed → one agent pass". |

`debounce` + a per-key `dedupe` while running is the combination that solves the
motivating scenario: rapid re-edits collapse (debounce), and if the agent is still busy
when a new edit lands, the new run is held until the current one finishes (queue/keep-last)
rather than spawning a competing agent.

### 7.3 Global limits

- `maxConcurrent` — global cap on simultaneously running commands (across all keys).
- Per-rule `concurrency.max` — cap within a rule.

The Scheduler is the single place that owns these decisions so behavior is predictable
and testable. Full semantics and examples: [`docs/concurrency.md`](./docs/concurrency.md).

---

## 8. Logging & observability

Dual-sink logging (details in [`docs/logging.md`](./docs/logging.md)):

- **Terminal:** human-readable, colorized when attached to a TTY, plain otherwise.
- **Log folder:** structured **JSON Lines** (`.jsonl`), one object per line, rotated by
  size. Fields include timestamp, level, event id/type, rule id, concurrency key,
  command, pid, exit code, duration.
- **Per-command logs:** each spawned command's stdout/stderr is captured to
  `logs/commands/<timestamp>-<eventType>-<shortId>.log` so an agent run can be inspected
  after the fact.

**Log location** (see [`docs/paths.md`](./docs/paths.md)):

- Default (project mode): `./.spec-stream/logs/` next to the config file, so logs live
  with the repository the agents operate on. PID file: `./.spec-stream/spec-stream.pid`.
- Daemon / user mode: `${XDG_STATE_HOME:-~/.local/state}/spec-stream/` for logs and PID.
- Overridable via config (`logDir`) and `--log-dir`.

---

## 9. Reliability model — "never fail" done responsibly

The user requirement is: *the tool should never fail without the user explicitly stopping
it.* This is good practice **for a supervisor loop**, provided failures are contained and
surfaced rather than hidden. Concretely:

- **Command failures** (non-zero exit, timeout, spawn error) are caught, logged at
  `error` level with full context, and the loop continues. One bad agent run never takes
  down the stream.
- **Connection failures** trigger reconnection with **capped exponential backoff**:
  start ~1s, double each attempt with jitter, cap at **30 minutes**, retry indefinitely.
  A 30s health check re-subscribes if the channel is not `joined` (mirrors prooph board).
  Connection state changes are logged and reflected in `status`.
- **Auth/token expiry** is handled by proactive refresh; on failure the exchange is
  retried under the same backoff policy.
- **Malformed events** are logged and skipped, never fatal.
- **Fatal, unrecoverable misconfiguration** (missing API key, invalid config, endpoint
  returns 401 for the key) **does** exit non-zero on startup — failing fast here is
  correct, because retrying cannot help and a silent zombie process would be worse.
  Once the process is *healthy and running*, it stays running until stopped.
- **Graceful shutdown:** on `SIGINT`/`SIGTERM`, stop accepting new events, optionally
  wait for in-flight commands to finish (`drainTimeout`), remove the PID file, exit 0.

So: **infinite resilience for transient/runtime errors; fail-fast for startup
misconfiguration.** That distinction is the responsible interpretation of "never fail".

---

## 10. CLI surface (planned)

```
spec-stream [run]                 # foreground (default); like `tail -f` for your model
spec-stream start                 # start in background (detached), write PID file
spec-stream stop                  # stop the background process (SIGTERM, then drain)
spec-stream status                # is it running? connection state, uptime, counters
spec-stream logs [-f]             # print / follow the combined log
spec-stream --config <path>       # explicit config path
spec-stream --log-dir <path>      # override log directory
spec-stream --detach              # alias for background start on `run`
spec-stream --verbose | --quiet   # log level
spec-stream --dry-run             # match & log events but do NOT spawn commands
```

- **Package:** `@proophboard/spec-stream`, invoked via `npx @proophboard/spec-stream`.
- **Bin name:** `spec-stream`.
- **Runtime:** Node.js `>=18` required (global `fetch` + `WebSocket`), `>=20` recommended.
- **Language:** TypeScript, compiled to ESM.

---

## 11. Dependencies (keep minimal)

| Dependency | Why | Notes |
|------------|-----|-------|
| `@supabase/supabase-js` | Realtime client, matches prooph board exactly | Bundles a WS impl; on Node <20 a `ws` polyfill may be needed. |
| *(optional)* `dotenv` | `.env` loading on Node <20.6 | Node ≥20.6 can use `--env-file`; prefer built-in. |

Everything else (arg parsing, PID files, rotation, backoff, pretty logging) is
**hand-rolled** with the Node standard library to stay lightweight. Do not add a
dependency without justifying it here.

---

## 12. Security notes

- The API key is a **secret**. It is read only from `PROOPHBOARD_API_KEY` (env or
  `.env`), never stored in `proophboard.spec-stream.json`. Never log it; redact `pb_…`
  in all output.
- The short-lived `access_token` lives in memory only; it is never written to disk. There
  is no refresh token.
- **Invoked commands inherit the full process environment, including `PROOPHBOARD_API_KEY`.**
  Child processes are spawned with a copy of `process.env` (plus `SPEC_STREAM_*` and
  configured `env`), so every command — and its subprocesses — can read the raw API key.
  This is intentional (agents may need it to write back to prooph board) but means rules
  should run only trusted commands, and a read-only key is recommended. spec-stream redacts
  the key from its own logs but cannot redact what a spawned command prints. Documented in
  `docs/command-context.md`.
- Configured commands run with the **user's** privileges. The config file therefore
  controls code execution — treat it as trusted input and document this clearly for
  users (see README security section).
- Event data injected into command env/stdin is **untrusted** (it comes from whoever can
  edit the board). Commands must quote/escape appropriately; `spec-stream` passes values
  as discrete env vars and JSON stdin (not string-interpolated into a shell) to reduce
  injection risk. When a rule uses a shell string, that is the user's responsibility and
  is documented.

---

## 13. Documentation map

| File | Purpose |
|------|---------|
| `AGENT.md` (this file) | Idea + overall architecture (start here). |
| `README.md` | User-facing getting started. |
| `docs/architecture.md` | Deeper component/dataflow detail. |
| `docs/authentication.md` | Full auth flow and token lifecycle. |
| `docs/config-schema.md` | Config file format and every option. |
| `docs/event-reference.md` | All changelog event types and payloads. |
| `docs/command-context.md` | Env vars + stdin passed to commands. |
| `docs/concurrency.md` | Queue/debounce/dedupe/batch semantics with examples. |
| `docs/logging.md` | Log formats, levels, rotation. |
| `docs/paths.md` | Config discovery, log/PID locations, XDG. |
| `docs/reconnection.md` | Backoff, health checks, degraded modes. |
| `docs/background-mode.md` | Daemon lifecycle, start/stop/status/logs. |

---

## 14. Status

Design phase. No runtime code implemented yet. This document and the `docs/` folder are
written **before** implementation, per the project plan. Implementation should follow the
module layout in §4.2 and the semantics defined in the linked docs.
nd the semantics defined in the linked docs.
ked docs.
 linked docs.
