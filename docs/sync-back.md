# sync-back — Two-Way Local Sync

`@proophboard/spec-stream sync-back` pushes local edits to the `.spec-stream/model/` file tree back
to prooph board via the REST API.

Together with the existing [local model sync](./local-sync.md) (board → files), this
makes the local file tree a fully **two-way** replica:

```
prooph board  ──▶  spec-stream run  ──▶  .spec-stream/model/   (read replica, kept live)
                                                │
                     your agent edits files ────┘
                                                │
                     git add  ──▶  pre-commit hook
                                                │
                     spec-stream sync-back ─────┘
                                                │
                                                ▼
                                         prooph board
```

Agents — or you, manually — edit the local model files, stage the changes with git, and
the pre-commit hook calls `@proophboard/spec-stream sync-back` to replay those edits on the board.
If the sync fails, the hook exits with code 1 and git aborts the commit.

---

## Prerequisites

- `localSync` must be **enabled** in `proophboard.spec-stream.json`:
  ```json
  {
    "localSync": { "enabled": true, "dir": ".spec-stream/model" }
  }
  ```
- `PROOPHBOARD_API_KEY` must be set (same key used for `spec-stream run`).
- The `.spec-stream/model/` directory must be inside a git repository (git is used to
  detect which files changed).

---

## Quick start

### 1. Install the pre-commit hook

```sh
cat > .git/hooks/pre-commit << 'EOF'
#!/bin/sh
npx @proophboard/spec-stream sync-back
EOF
chmod +x .git/hooks/pre-commit
```

That's it. Every `git commit` that touches files under `.spec-stream/model/` now
automatically syncs the staged changes back to prooph board before the commit is
finalised. If the sync fails, the hook exits with code 1 and git aborts the commit,
so API errors are caught before the commit is written.

### 2. Test it with --dry-run

Before enabling the hook, stage your changes and preview what would be synced:

```sh
git add .spec-stream/model/
npx @proophboard/spec-stream sync-back --dry-run --verbose
```

This shows each operation that would be executed, without calling the API.

---

## How it works

On each invocation, `sync-back`:

1. Runs `git diff --cached --name-status -M HEAD` to get the list of staged files in
   the sync directory (index vs HEAD — the staged state before commit).
2. Parses each changed path to identify the entity (chapter/slice/lane/element/milestone/snippet/scenario)
   and the type of change (content update, create, rename, move, delete).
3. Reads the relevant `.json` and markdown files from disk (the staged state, already
   on disk when the pre-commit hook fires).
4. Builds an ordered list of prooph board API calls.
5. Executes them sequentially against the REST API.

### Operation ordering

Within a single commit, operations are executed in this order to respect dependencies:

1. Chapter creates
2. Lane creates
3. Slice creates
4. Element creates
5. Content updates (description, details, status, rename, etc.)
6. Element moves
7. Deletes (elements → slices → lanes → chapters → milestones)

### What gets synced

| Local change | API operation |
|---|---|
| `element.json` added | Create element |
| `element.json` modified (name) | Rename element |
| `element.json` modified (laneId/sliceId) | Move element |
| `description.md` modified | Update element description |
| `details.md` modified (under element) | Update element details |
| `play-function.ts` modified | Update element play config |
| `play-type.ts` modified | Update element play config |
| `slice.json` added | Create slice |
| `slice.json` modified (label) | Rename slice |
| `slice.json` modified (status) | Update slice status |
| `details.md` modified (under slice) | Update slice details |
| `lane.json` added | Create lane |
| `lane.json` modified (label) | Rename lane |
| `lane.json` modified (height) | Resize lane |
| `chapter.json` added | Create chapter |
| `chapter.json` modified (name) | Rename chapter |
| `chapter.json` modified (context) | Update chapter context |
| `milestone.json` added | Create milestone |
| `milestone.json` modified | Update milestone |
| `description.md` modified (under milestone) | Update milestone description |
| `html-snippets/[slug].html` added | Create HTML snippet |
| `html-snippets/[slug].html` modified | Update HTML snippet content |
| `html-snippets/[slug].json` modified (name) | Update HTML snippet name |
| `html-snippets/[slug].html` deleted | Delete HTML snippet |
| `scenario.json` modified (expectations array) | Set or remove scenario expectations |
| Directory renamed (element) | Rename or move element |
| Directory renamed (slice) | Rename slice |
| Primary `.json` deleted | Delete entity |

### Scenario expectations sync-back

When `scenario.json` is modified, sync-back diffs the `expectations[]` array against the version in the base commit (read via `git show HEAD`):

- Expectations that are **new or changed** → `POST /chapters/{id}/scenarios/{id}/expectations` (set/upsert)
- Expectations that were **removed** → `DELETE /chapters/{id}/scenarios/{id}/expectations/{expectation_id}`

This is a structural diff by `id` — if the full `expected` object or any field changes, the expectation is re-set. Other `scenario.json` fields (`clock`, `initialState`, `seededEvents`, `interactions`) are **not** synced back; those are managed via the prooph board UI or MCP.

### What is intentionally skipped

- `index.md` — auto-generated summary, not synced back.
- `uuid-index.json`, `workspace.json`, `sync-state.json` — internal bookkeeping.
- `element-details/` canonical copies — updates go through the element's own `details.md`.
- `lane-details/` — lane details are updated via `lane.json` modifications.
- Non-expectation scenario fields (`clock`, `initialState`, `seededEvents`, `interactions`) — managed via the prooph board UI / MCP.
- Comment files — not yet supported.

---

## Command reference

```
spec-stream sync-back [options]
```

| Option | Default | Description |
|---|---|---|
| `--dry-run` | false | Log operations without calling the API |
| `--from-commit <sha>` | `HEAD` | Base commit for the diff (index is compared to this commit) |
| `--verbose` / `-v` | false | Show each changed file and verbose output |
| `-c`, `--config <path>` | auto | Path to `proophboard.spec-stream.json` |

---

## Own-write loop prevention

When `spec-stream run` is active at the same time as `sync-back`, the writes made by
`sync-back` will appear as changelog events on the board. These events are automatically
ignored by `spec-stream run` because they come from the **same API key** — the existing
own-write filtering handles this transparently. No configuration needed.

---

## Conflict handling

sync-back is **last-write-wins**: it sends the current file content directly to the board
without checking whether the remote has changed since the last sync. This is intentional
for simplicity.

- If `spec-stream run` is active and the board is ahead of your local sync, the next
  incoming event will overwrite your local files with the board's version. The board's
  version takes precedence.
- If you edit locally while `spec-stream run` is stopped, your edits win when you sync
  back (since `run` is not active to overwrite them). The board's event-sourced history
  preserves both versions — nothing is irrecoverably lost.

The recommended workflow: keep `spec-stream run` running in the background while agents
work so the local model stays current.

---

## Error handling

- A failed API call for one operation does **not** stop the rest. `sync-back` logs the
  error and continues (fail-forward).
- If any operations fail, `sync-back` exits with code 1 so the pre-commit hook aborts
  the commit and surfaces the failure.
- The prooph board REST API validates all inputs. If a change is structurally invalid
  (e.g. moving an element to a non-existent slice), the API returns an error which is
  logged and skipped.

---

## Architecture

```
src/sync-back/
  pathParser.ts      Path → entity descriptor (pure, no I/O)
  gitDiff.ts         git diff --name-status -M → FileChange[]
  operationBuilder.ts FileChange[] + disk reads → SyncBackOperation[]
  executor.ts        SyncBackOperation[] + RestClient → API calls
  syncBack.ts        Entry point: wires the above together
```

The `RestClient` (`src/sync/restClient.ts`) was extended with `postJson`, `patchJson`,
and `deleteReq` write methods used by the executor.
