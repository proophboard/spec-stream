# Command Context

When a rule matches, `spec-stream` spawns the configured command as a child process. This
document defines exactly what the command receives.

## How commands are spawned

- With `shell: true` (default), the rule's `run` string is executed via the platform
  shell (`/bin/sh -c` or `cmd.exe /d /s /c`).
- With `shell: false`, `command` + `args` are executed directly (no shell parsing). This
  is safer against injection and is recommended when you don't need shell features.
- The working directory is `cwd` (relative to the config file) or the config directory.
- The environment is: the parent process env **+** global `env` **+** rule `env` **+**
  the `SPEC_STREAM_*` variables below. The parent process env includes
  **`PROOPHBOARD_API_KEY`** — see [Inherited environment & the API key](#inherited-environment--the-api-key).

## Environment variables

Every command receives these (values that don't apply to a given event are omitted):

| Variable | Source |
|----------|--------|
| `SPEC_STREAM_EVENT_ID` | `event.id` |
| `SPEC_STREAM_EVENT_TYPE` | `event.type` |
| `SPEC_STREAM_TIMESTAMP` | `event.timestamp` |
| `SPEC_STREAM_WORKSPACE_ID` | `event.workspaceId` / row `workspace_id` |
| `SPEC_STREAM_CHAPTER_ID` | `event.chapterId` / row `chapter_id` |
| `SPEC_STREAM_CHAPTER_NAME` | `event.chapterName` |
| `SPEC_STREAM_ELEMENT_ID` | `event.elementId` / row `element_id` |
| `SPEC_STREAM_ELEMENT_NAME` | `event.elementName` (when present) |
| `SPEC_STREAM_ELEMENT_TYPE` | `event.elementType` (when present) |
| `SPEC_STREAM_SLICE_ID` | `event.sliceId` / row `slice_id` |
| `SPEC_STREAM_USER_ID` | row `user_id` |
| `SPEC_STREAM_ADDED_BY_AGENT` | `"true"`/`"false"` |
| `SPEC_STREAM_RULE_ID` | the matched rule's id |
| `SPEC_STREAM_CONCURRENCY_KEY` | the resolved concurrency key |
| `SPEC_STREAM_BATCH_SIZE` | number of events in the batch (`batch` mode; `1` otherwise) |
| `SPEC_STREAM_SELF_USER_ID` | the API key's own user id (constant per process; omitted if unknown). Lets a command tell apart its own writes from others'. |
| `SPEC_STREAM_SELF_EMAIL` | the API key's own user email (constant per process; omitted if unknown) |

## Inherited environment & the API key

Spawned commands inherit **the full environment of the `spec-stream` process**, in
addition to the `SPEC_STREAM_*` variables and any `env` you configure. In particular,
this means **`PROOPHBOARD_API_KEY` is visible to every command you run** (and to their
subprocesses), because spec-stream reads the key from its own environment.

This is intentional and often useful: it lets your agents authenticate to the prooph
board API/MCP to write results back **without you re-passing the key**. But be aware of
the trade-off:

- Any command a rule runs — including third-party or untrusted code — can read the raw
  API key from `PROOPHBOARD_API_KEY`.
- Use a **read-only key** unless a command genuinely needs to write back (this is the
  recommended default anyway).
- Scope commands to code you trust, since they run with your privileges and your key.
- spec-stream redacts the key from **its own logs**, but it cannot redact what a spawned
  command chooses to print — a command that echoes its environment will reveal the key.

Values are passed as **discrete environment variables**, not interpolated into a shell
string by `spec-stream`. If you reference them in a `run` string (e.g.
`"$SPEC_STREAM_ELEMENT_NAME"`), quoting is the shell's job — quote them. With
`shell: false` there is no interpolation at all; use the variables from within your
script.

## Standard input (stdin)

The full event (and, in batch mode, the array of events) is written to the command's
**stdin** as JSON, then stdin is closed. This is the reliable way to get the complete
payload including `oldValue`/`newValue`.

Single event:

```json
{
  "mode": "single",
  "event": {
    "id": "…",
    "type": "element-description-changed",
    "chapterId": "…",
    "elementId": "…",
    "elementName": "Place Order",
    "elementType": "command",
    "oldValue": { "description": "…" },
    "newValue": { "description": "…" }
  },
  "row": { "workspace_id": "…", "chapter_id": "…", "element_id": "…", "user_id": "…", "created_at": "…" }
}
```

Batch (`concurrency.mode: "batch"`):

```json
{
  "mode": "batch",
  "events": [ { /* event */ }, { /* event */ } ],
  "rows": [ { /* row */ }, { /* row */ } ]
}
```

## Reading the payload in a command

Bash:

```bash
#!/usr/bin/env bash
set -euo pipefail
payload="$(cat)"                                  # read stdin
name="$SPEC_STREAM_ELEMENT_NAME"
desc="$(printf '%s' "$payload" | jq -r '.event.newValue.description')"
kiro agent --task "Implement '$name': $desc"
```

Node:

```js
import { readFileSync } from "node:fs";
const payload = JSON.parse(readFileSync(0, "utf8")); // fd 0 = stdin
console.log(payload.event.type, process.env.SPEC_STREAM_ELEMENT_ID);
```

## Output, exit codes, and timeouts

- The command's **stdout/stderr** are captured to a per-command log
  (`logs/commands/<timestamp>-<eventType>-<shortId>.log`) and, at `debug` level, mirrored
  to the terminal. See [`logging.md`](./logging.md).
- **Exit code `0`** = success; non-zero = failure (logged at `error`, loop continues).
- If `timeout` is set on the rule, the child is killed (SIGTERM, then SIGKILL) after the
  timeout and the run is marked failed.
- A command's failure **never** stops `spec-stream` (see `AGENT.md` §9).

## Security

Event data is **untrusted** — it originates from anyone who can edit the board. Because
values are passed as discrete env vars and JSON stdin rather than concatenated into a
shell command by `spec-stream`, the tool does not itself create a shell-injection vector.
If your `run` string interpolates values into the shell, **you** are responsible for
quoting. Prefer `shell: false` + reading stdin for untrusted content.
