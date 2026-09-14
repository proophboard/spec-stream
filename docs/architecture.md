# Architecture

This document expands on the architecture summary in [`../AGENT.md`](../AGENT.md) §4.
Read `AGENT.md` first for the idea and the big picture.

## Process shape

`spec-stream` is a **single long-running Node.js process**. In foreground mode it owns
your terminal (like `tail -f`); in background mode the same process is detached and
managed via a PID file. There are no worker processes other than the **child processes**
it spawns to run your configured commands.

## Data flow

```
Supabase Realtime — workspace changelog stream (prooph board)
        │  changelog message
        ▼
Realtime Client ──normalize──▶ ChangelogEvent
        ▼
Event Router  ──match rules──▶ MatchedTask[]   (0..n per event)
        ▼
Scheduler     ──queue/debounce/dedupe/batch──▶ RunnableTask
        ▼
Command Runner ──spawn child process──▶ CommandResult
        ▼
Logger (terminal + JSONL + per-command log)
```

Control concerns (startup, reconnect, shutdown) are owned by the **Supervisor**, which
sits beside the pipeline rather than inside it.

## Components

### Config Loader (`src/config`)
- Discovers `proophboard.spec-stream.json` (see [`paths.md`](./paths.md)).
- Parses and validates it against the schema ([`config-schema.md`](./config-schema.md)).
- Merges CLI flags (highest precedence) → config file → defaults.
- Resolves the API key from `PROOPHBOARD_API_KEY` (env or `.env`). The key is **never**
  read from the JSON file.
- Fails fast with a clear message on invalid config or missing key.

### Token Exchanger (`src/auth`)
- Exchanges the `pb_…` key for a short-lived access token via the prooph board token
  endpoint ([`authentication.md`](./authentication.md)).
- Holds `supabase_url`, `supabase_anon_key`, `workspace_id`, and the current
  short-lived access token.
- Runs a renewal loop (re-presenting the API key) so the token never expires while
  connected. No refresh token is used.

### Realtime Client (`src/realtime`)
- Creates the supabase-js client and authorizes the socket with the access token
  (`realtime.setAuth`), refreshing it via the Token Exchanger's renewal loop.
- Subscribes to the workspace's changelog channel and receives one message per change.
- Normalizes each incoming message into a typed `ChangelogEvent`, filling envelope
  fields (`type`, `chapterId`, `workspaceId`, …) that may be omitted from the payload.
- Owns the reconnect state machine and health checks ([`reconnection.md`](./reconnection.md)).

### Event Router (`src/routing`)
- Evaluates configured rules against each event, in order.
- A rule matches on `on` (type / list / `*`) and optional `when` filters.
- Produces a `MatchedTask` per matching rule (an event can trigger several rules).
- Skips `addedByAgent` events unless the rule opts in.

### Scheduler (`src/scheduler`)
- Derives a **concurrency key** per task and applies the rule's mode
  (`parallel`/`queue`/`debounce`/`dedupe`/`batch`) plus global/per-rule limits.
- The single authority on *when* a task runs. See [`concurrency.md`](./concurrency.md).

### Command Runner (`src/runner`)
- Spawns the command as a child process with a controlled environment and the event JSON
  on stdin ([`command-context.md`](./command-context.md)).
- Captures stdout/stderr to a per-command log, enforces an optional timeout, and returns
  a structured result. **Never throws into the pipeline** — failures become logged results.

### Logger (`src/logging`)
- Dual sink: pretty/colorized terminal output + JSONL files with size-based rotation.
- See [`logging.md`](./logging.md).

### Supervisor / Lifecycle (`src/lifecycle`)
- PID file management, signal handling, graceful drain, and the background (detached)
  spawn. Implements `start`/`stop`/`status`/`logs`. See
  [`background-mode.md`](./background-mode.md).

## Key design properties

- **Single owner of concurrency.** All ordering/coalescing decisions live in the
  Scheduler, so behavior is deterministic and unit-testable.
- **Failures are values, not exceptions.** The Runner turns every outcome into a result
  object; the loop is never interrupted by a bad command.
- **Reference-faithful realtime.** The client uses `supabase-js` the same way the prooph
  board web app does, so `spec-stream` sees the same events a browser session would.
- **Secrets in memory only.** API key from env; the access token never touches disk.

## Intended source layout

See [`../AGENT.md`](../AGENT.md) §4.2 for the target `src/` tree.
