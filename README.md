# @proophboard/spec-stream

**Stream changes from your [prooph board](https://prooph-board.com) event model to your
terminal, and run a command — usually an AI coding agent — for every change.**

You model a feature on prooph board (even from your phone). The moment you save a change,
`spec-stream` receives it in real time and runs the command you configured — kicking off
an agent to implement the spec, regenerate docs, notify your team, or anything else.

```
prooph board change ──▶ realtime event ──▶ spec-stream ──▶ your command / AI agent
```

> **Status: beta.** The CLI is implemented and covered by an automated test suite, and
> our first end-to-end tests against a live prooph board workspace confirmed it works —
> realtime events trigger commands, and own-write filtering behaves as designed. APIs and
> config may still change before a stable `1.0` release. Feedback and issues welcome.

---

## Why

- **Spec-driven, continuously.** Write a spec in a sticky note; an agent starts working
  when you save.
- **Work from anywhere.** Edit the board on mobile while away — agents run on your
  machine or a server.
- **Lightweight.** A tiny, dependency-minimal CLI. No framework, no daemon manager
  required.
- **Controllable.** Decide exactly which events trigger which commands, and how to
  **queue, debounce, dedupe, or batch** them so agents don't collide.

---

## Prerequisites

- **Node.js ≥ 18** (≥ 20 recommended).
- A **prooph board API key** for the workspace you want to stream. Create one in prooph board (Settings → API Keys). It looks like `pb_1a2b3c…`.

---

## Installation

`spec-stream` is a CLI you can run directly with `npx` — no install step required:

```bash
npx @proophboard/spec-stream --help
```

To pin a version (recommended while in beta):

```bash
npx @proophboard/spec-stream@latest run
```

Or install it globally / as a project dev dependency if you prefer:

```bash
# global
npm install -g @proophboard/spec-stream
spec-stream --help

# project (dev dependency)
npm install --save-dev @proophboard/spec-stream
npx spec-stream --help
```

Requires Node.js ≥ 18. The package ships as ESM.

---

## Quick start

### 1. Provide your API key (never put it in the config file)

```bash
export PROOPHBOARD_API_KEY="pb_xxxxxxxxxxxxxxxx"
# or put it in a .env file (see below)
```

### 2. Create `proophboard.spec-stream.json` in your project

Scaffold one instantly with:

```bash
npx @proophboard/spec-stream init
```

This writes a starter `proophboard.spec-stream.json` into the current directory with an
example `echo` rule you can edit. (Use `init --force` to overwrite an existing file.)

Or create it by hand:

```json
{
  "endpoint": "https://flow.prooph-board.com/api",
  "rules": [
    {
      "on": "element-description-changed",
      "run": "echo \"Spec changed for $SPEC_STREAM_ELEMENT_NAME\"",
      "concurrency": { "key": "element", "mode": "debounce", "wait": 5000 }
    }
  ]
}
```

This runs your command whenever a sticky note's **description** changes, collapsing rapid
edits to the same note into a single run.

### 3. Run it

```bash
npx @proophboard/spec-stream
```

You'll see a live log of connections, incoming events, and command runs. Press **Ctrl-C**
to stop. Now edit an element description on your board and watch the command fire.

---

## A more realistic example: trigger an AI agent

```json
{
  "endpoint": "https://flow.prooph-board.com/api",
  "maxConcurrent": 3,
  "rules": [
    {
      "id": "implement-spec",
      "on": ["element-description-changed", "element-details-changed"],
      "when": { "elementType": ["command", "ui", "event"] },
      "run": "claude -p \"Implement the spec for '$SPEC_STREAM_ELEMENT_NAME'. Full event on stdin.\"",
      "cwd": "./",
      "concurrency": { "key": "element", "mode": "debounce", "wait": 8000, "max": 1 }
    },
    {
      "id": "build-planned-slice",
      "on": "slice-status-changed",
      "when": { "data": { "newValue.status": ["planned"] } },
      "run": "claude -p \"Build the slice $SPEC_STREAM_SLICE_ID. Full event on stdin.\"",
      "cwd": "./",
      "concurrency": { "key": "slice", "mode": "queue", "max": 1 }
    }
  ]
}
```

- The first rule reacts to specs on `command` / `ui` / `event` elements.
- Rapid re-saves of the same element collapse into one agent run (`debounce`).
- The **same element** is never worked on by two agents at once (`key: element`, `max: 1`),
  but **different elements** run in parallel — up to `maxConcurrent`.
- The second rule shows a common workflow: when you flip a slice's status to **`planned`**
  on the board, a build agent starts implementing it. The `when.data` filter matches the
  new status in the event payload (`newValue.status`), so only the `planned` transition
  fires — not every status change. `when.data` can match **any** field in the event by
  dot-path.

Your command receives the change as `SPEC_STREAM_*` environment variables **and** the full
event as JSON on **stdin**. See [`docs/command-context.md`](./docs/command-context.md).

---

## Running in the background

Foreground is the default (like `tail -f`). To run detached:

```bash
spec-stream start      # start in the background (writes a PID file)
spec-stream status     # is it running? connection + counters
spec-stream logs -f    # follow the log
spec-stream stop       # graceful stop (waits for running commands to finish)
```

For servers, run the foreground command under systemd/Docker and let the manager handle
restarts. See [`docs/background-mode.md`](./docs/background-mode.md).

---

## Using a `.env` file

```
# .env
PROOPHBOARD_API_KEY=pb_xxxxxxxxxxxxxxxx
```

- **Node ≥ 20.6:** `node --env-file=.env …` (or `spec-stream` loads it automatically when
  present).
- **Older Node:** install the optional `dotenv` dependency.

`.env` is already git-ignored in this project. **Never commit your API key**, and never
put it in `proophboard.spec-stream.json`.

---

## Which events can I react to?

Any prooph board changelog event — `element-description-changed`,
`element-details-changed`, `element-added`, `element-renamed`, `element-comment-added`,
`slice-added`, `chapter-added`, and ~40 more. Use a single type, a list, or `"*"`.

The full catalog with payloads is in [`docs/event-reference.md`](./docs/event-reference.md).
The most useful for spec-driven automation are usually `element-description-changed` and
`element-details-changed`.

---

## Controlling concurrency

The key feature for automation is deciding **when** commands run so agents don't fight
over the same work:

| Mode | Use it when |
|------|-------------|
| `parallel` | Independent side effects (notifications). |
| `queue` | Every change matters; process one at a time per key. |
| `debounce` | A spec is being edited; collapse a burst into one run. |
| `dedupe` | Avoid duplicate long-running jobs on the same target. |
| `batch` | Coalesce many related changes into a single pass. |

Combined with a **concurrency key** (`element`, `slice`, `chapter`, `global`, or a custom
template), this gives precise control. Full guide with timelines:
[`docs/concurrency.md`](./docs/concurrency.md).

---

## Avoiding feedback loops (own writes)

If your triggered agents write back to the board (via the prooph board API/MCP using the
same key), those changes would themselves be changelog events. By default, `spec-stream`
**ignores events made by its own API-key user**, so an agent never re-triggers itself.

- This is automatic — no configuration needed.
- Opt a rule back in with `"consumeOwnEvents": true` if you *do* want it to react to its
  own user's changes.
- Your commands also receive `SPEC_STREAM_SELF_USER_ID` / `SPEC_STREAM_SELF_EMAIL` so they
  can distinguish their own writes.

---

## Reliability

Once running, `spec-stream` stays up until you stop it:

- **Command errors never stop the stream** — they're logged and the loop continues.
- **Connection drops** trigger reconnection with capped exponential backoff (up to every
  30 minutes, retrying indefinitely) and a 30s health check.
- **Missed events** during a disconnect are replayed on reconnect.
- **Invalid startup config** (missing key, bad config) fails fast with a clear message —
  the one case where it exits on purpose.

Details: [`docs/reconnection.md`](./docs/reconnection.md).

---

## Security

- The API key is a **secret**: env/`.env` only, never in config, never logged (redacted).
- **Invoked commands inherit `PROOPHBOARD_API_KEY`.** Commands run with spec-stream's full
  environment, so every command (and its subprocesses) can read the API key. This is handy
  for agents that write back to prooph board, but means you should only run **trusted**
  commands and prefer a **read-only key**. See [`docs/command-context.md`](./docs/command-context.md#inherited-environment--the-api-key).
- **Configured commands run with your privileges.** The config file controls what gets
  executed — treat it as trusted and review rules before running.
- **Event data is untrusted** (anyone who can edit the board produces it). `spec-stream`
  passes values as discrete env vars and JSON stdin rather than interpolating them into a
  shell. If your `run` string embeds values, quote them, or use the safer
  `command` + `args` form (`shell: false`).

---

## Configuration reference

Every option is documented in [`docs/config-schema.md`](./docs/config-schema.md). Paths
(config discovery, logs, PID file) are in [`docs/paths.md`](./docs/paths.md).

---

## How it works (short version)

`spec-stream` exchanges your `pb_…` API key for a **short-lived access token** via prooph
board's token endpoint (no long-lived refresh token — the key stays the single
credential, so revoking it stops the stream), then subscribes to your workspace's
realtime changelog stream. Matching events are routed through a scheduler
(queue/debounce/dedupe/batch) and executed as child processes.

The full architecture is in [`AGENT.md`](./AGENT.md) and [`docs/`](./docs/).

---

## Documentation

- [`AGENT.md`](./AGENT.md) — idea + overall architecture (start here to contribute).
- [`docs/`](./docs/) — architecture, auth, config, events, concurrency, logging, paths,
  reconnection, background mode, and the prooph board dependency.

---

## License

[MIT](./LICENSE) © prooph board
E) © prooph board
