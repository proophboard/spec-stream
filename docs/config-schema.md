# Configuration Schema

`spec-stream` is driven by a single config file, discovered on startup:
`proophboard.spec-stream.json`. Discovery rules and file locations are in
[`paths.md`](./paths.md). The API key is **not** part of this file — it comes from the
environment (see [`authentication.md`](./authentication.md)).

## Top-level shape

```jsonc
{
  "$schema": "https://unpkg.com/@proophboard/spec-stream/schema.json", // optional, editor help
  "endpoint": "https://flow.prooph-board.com/api", // prooph board API base URL
  "logDir": ".spec-stream/logs",                // optional; see paths.md for defaults
  "logLevel": "info",                           // trace|debug|info|warn|error (default: info)
  "maxConcurrent": 4,                            // global cap on running commands (default: 4)
  "drainTimeout": 30000,                         // ms to wait for in-flight commands on shutdown
  "shell": true,                                 // run commands via shell (default: true)
  "env": { "FOO": "bar" },                       // extra env vars for every command
  "rules": [ /* MappingRule[] — see below */ ]
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `endpoint` | string | required | API base URL of your prooph board instance, including the `/api` path (e.g. `https://flow.prooph-board.com/api`). spec-stream calls `POST {endpoint}/realtime-token`. |
| `logDir` | string | see [`paths.md`](./paths.md) | Where combined + per-command logs are written. |
| `logLevel` | enum | `info` | Minimum level logged. |
| `maxConcurrent` | number | `4` | Max commands running at once across all rules. |
| `drainTimeout` | number (ms) | `30000` | On shutdown, wait this long for running commands before force-killing. |
| `shell` | boolean | `true` | If `true`, `run` is a shell string; if `false`, use `command`+`args` array form. |
| `env` | object | `{}` | Extra environment variables merged into every command's env. |
| `rules` | array | required | Ordered list of mapping rules. |

## Mapping rule

Each rule maps an event pattern to a command and controls how it runs.

```jsonc
{
  "id": "implement-spec",                    // optional, for logs/status; auto-generated if omitted
  "on": "element-description-changed",       // string | string[] | "*"
  "when": {                                   // optional filters; ALL must match
    "elementType": ["command", "event"], // string | string[]
    "context": "Ordering",                    // string | string[]
    "chapterId": "…",                          // string | string[]
    "chapterName": "Checkout",                 // string | string[]
    "addedByAgent": false                      // default false — agent events are ignored unless true
  },
  "run": "kiro agent --task \"$SPEC_STREAM_ELEMENT_NAME\"", // shell string (shell:true)
  // OR, with shell:false —
  // "command": "kiro",
  // "args": ["agent", "--task", "$SPEC_STREAM_ELEMENT_NAME"],
  "cwd": "./",                                // optional working directory (relative to config file)
  "timeout": 1800000,                         // optional ms; kill the command after this
  "env": { "AGENT_MODE": "auto" },            // optional per-rule env (merged over global env)
  "consumeOwnEvents": false,                  // default false: ignore this key's own writes
  "concurrency": {
    "key": "element",                         // element|slice|chapter|global|<template> (default: element)
    "mode": "debounce",                       // parallel|queue|debounce|dedupe|batch (default: queue)
    "wait": 5000,                             // ms; used by debounce/batch
    "max": 1,                                 // per-rule concurrent cap (default: 1, except parallel)
    "maxBatch": 20                            // batch mode only: flush when this many collected
  }
}
```

### Rule fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | string | auto | Identifier used in logs and `status`. |
| `on` | string \| string[] \| `"*"` | required | Event type(s) this rule reacts to. `"*"` matches all. |
| `when` | object | `{}` | Filter predicates; **all** provided keys must match the event. |
| `run` | string | — | Shell command (when `shell: true`). Mutually exclusive with `command`/`args`. |
| `command` + `args` | string + string[] | — | Executable + argument array (when `shell: false`). Safer, no shell parsing. |
| `cwd` | string | config dir | Working directory for the command. |
| `timeout` | number (ms) | none | Hard timeout; the child is killed and the run marked failed. |
| `env` | object | `{}` | Extra env for this rule's commands. |
| `consumeOwnEvents` | boolean | `false` | If `true`, this rule also reacts to changes made by spec-stream's **own API-key user** (same user id). By default such events are ignored so triggered agents that write back to the board don't re-trigger themselves. See [Self-event filtering](#self-event-filtering). |
| `concurrency` | object | see below | How runs are coordinated. Full semantics: [`concurrency.md`](./concurrency.md). |

### `when` filters

All filters are optional and combine with **AND**. String filters accept a single value
or an array (matches if the event value is in the array).

| Filter | Matches against                                                                                                                                                                                                                                                        |
|--------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `elementType` | `event_data.elementType` (e.g. `command`, `event`, `automation`, `ui`, `information`).                                                                                                                                                                                 |
| `context` | element/chapter context.                                                                                                                                                                                                                                               |
| `chapterId` / `chapterName` | the event's chapter.                                                                                                                                                                                                                                                   |
| `addedByAgent` | `event_data.addedByAgent`. Optional with **no default** — when omitted, agent and non-agent events both match. Set `true`/`false` to require that value. (This is a plain filter; preventing self-triggering is handled by self-event filtering below, not this flag.) |

### Self-event filtering

Each API key is backed by its own user identity. By default, a rule **ignores changelog
events made by that same user** — i.e. spec-stream's own writes back to the board (or the
writes of agents acting under the same key). This prevents feedback loops where an agent's
change re-triggers the very rule that started it.

- Set `consumeOwnEvents: true` on a rule to make it react to its own user's events too.
- Self-detection needs the token endpoint to report the key's user id. If it doesn't
  (older prooph board), self-filtering is disabled and a `auth.no_self_identity` warning
  is logged.
- The key's identity is also passed to commands as `SPEC_STREAM_SELF_USER_ID` and
  `SPEC_STREAM_SELF_EMAIL` (see [`command-context.md`](./command-context.md)).

### `concurrency` defaults

| Field | Default | Notes |
|-------|---------|-------|
| `key` | `element` for element events, else `global` | Tasks sharing a key are coordinated. |
| `mode` | `queue` | Safe default: one run per key at a time, others wait. |
| `wait` | `2000` | Used by `debounce` and `batch`. |
| `max` | `1` (`parallel`: unbounded up to `maxConcurrent`) | Per-rule concurrent runs. |
| `maxBatch` | `50` | `batch` mode flush threshold. |

## Precedence

CLI flags override config file values, which override built-in defaults. The API key is
resolved only from the environment and is never overridden by config.

## Validation

The config is validated on startup. On any error (unknown event type in `on`, invalid
`mode`, both `run` and `command` set, etc.) `spec-stream` prints a precise message and
exits non-zero **before** connecting. This fail-fast behavior is intentional
(see `AGENT.md` §9).

## Minimal example

```json
{
  "endpoint": "https://flow.prooph-board.com/api",
  "rules": [
    {
      "on": "element-description-changed",
      "run": "kiro agent implement",
      "concurrency": { "key": "element", "mode": "debounce", "wait": 5000 }
    }
  ]
}
```

## Fuller example

```jsonc
{
  "endpoint": "https://flow.prooph-board.com/api",
  "logLevel": "info",
  "maxConcurrent": 3,
  "rules": [
    {
      "id": "spec-to-code",
      "on": ["element-description-changed", "element-details-changed"],
      "when": { "elementType": ["command", "ui", "event"] },
      "run": "claude -p \"Implement spec for $SPEC_STREAM_ELEMENT_NAME\"",
      "concurrency": { "key": "element", "mode": "debounce", "wait": 8000, "max": 1 }
    },
    {
      "id": "notify-comments",
      "on": "element-comment-added",
      "run": "./scripts/notify-slack.sh",
      "concurrency": { "key": "global", "mode": "parallel" }
    },
    {
      "id": "regenerate-on-structural-change",
      "on": ["element-added", "element-removed", "slice-added"],
      "when": { "chapterName": "Checkout" },
      "run": "./scripts/regen-docs.sh",
      "concurrency": { "key": "chapter", "mode": "batch", "wait": 15000, "maxBatch": 30 }
    }
  ]
}
```
