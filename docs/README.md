# spec-stream Documentation

Design and reference documentation for `@proophboard/spec-stream`.

Start with the top-level [`../AGENT.md`](../AGENT.md) for the idea and overall
architecture, then dive into the specific topics below.

| Doc | What it covers |
|-----|----------------|
| [architecture.md](./architecture.md) | Components, data flow, module boundaries. |
| [authentication.md](./authentication.md) | API key → short-lived token exchange and token lifecycle. |
| [config-schema.md](./config-schema.md) | The `proophboard.spec-stream.json` format and every option. |
| [event-reference.md](./event-reference.md) | All prooph board changelog event types and payloads. |
| [command-context.md](./command-context.md) | Env vars + JSON stdin passed to spawned commands. |
| [concurrency.md](./concurrency.md) | Queue / debounce / dedupe / batch semantics with examples. |
| [logging.md](./logging.md) | Dual-sink logging, JSONL format, rotation. |
| [paths.md](./paths.md) | Config discovery, log/PID locations, XDG. |
| [reconnection.md](./reconnection.md) | Backoff, health checks, gap replay, degraded polling. |
| [background-mode.md](./background-mode.md) | Foreground vs background, PID file, `start`/`stop`/`status`/`logs`, service managers. |

> Status: design phase — these docs are written before implementation and describe the
> intended behavior. Keep them in sync with the code as it lands.
