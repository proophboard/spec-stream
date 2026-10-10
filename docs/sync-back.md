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
                     spec-stream sync-back ─────┘
                                                │
                                                ▼
                                         prooph board
```

Agents — or you, manually — edit the local model files, then call
`@proophboard/spec-stream sync-back` to replay those edits on the board.

**No git required.** sync-back uses its own manifest files to track state, so it
works whether or not the model directory is tracked by git. A git pre-commit hook
is one convenient way to trigger it, but it is entirely optional.

---

## Prerequisites

- `localSync` must be **enabled** in `proophboard.spec-stream.json`:
  ```json
  {
    "localSync": { "enabled": true, "dir": ".spec-stream/model" }
  }
  ```
- `PROOPHBOARD_API_KEY` must be set (same key used for `spec-stream run`).

---

## Quick start

### 1. Run it manually

After editing model files:

```sh
npx @proophboard/spec-stream sync-back --dry-run --verbose   # preview
npx @proophboard/spec-stream sync-back                        # apply
```

### 2. (Optional) Install a git pre-commit hook

If you use git, you can hook sync-back into every commit so API errors abort the
commit before it is finalised:

```sh
cat > .git/hooks/pre-commit << 'EOF'
#!/bin/sh
npx @proophboard/spec-stream sync-back
EOF
chmod +x .git/hooks/pre-commit
```

---

## How it works

On each invocation, `sync-back`:

1. **Reads the manifests** — `sync-manifest.json` (written by `spec-stream run` after
   each model write) and `sync-back-ids.json` (written by previous sync-back runs for
   locally-created entities). Together these describe every entity that is already known
   to prooph board.
2. **Walks the model directory** on disk and collects all current entity directories.
3. **Diffs** the disk state against the manifests to classify each entity:
   - **create** — directory on disk, not in either manifest (new entity)
   - **update** — directory present in the manifest (existing entity, possibly changed)
   - **delete** — id in manifest but directory gone from disk
   - **rename/move** — same id in manifest under a different directory
4. **Reads** the relevant `.json` and markdown files from disk to build the exact API
   calls needed.
5. **Builds an ordered list** of prooph board API calls and executes them sequentially.
6. **Persists new entity ids** returned by create operations to `sync-back-ids.json` so
   the next run correctly treats those entities as updates even if `spec-stream run` has
   not yet processed the corresponding board events.

### Manifest files

Two files live alongside `sync-state.json` in `.spec-stream/`:

| File | Written by | Contains |
|---|---|---|
| `sync-manifest.json` | `spec-stream run` (sync process) | All entities currently on the board — authoritative |
| `sync-back-ids.json` | `spec-stream sync-back` | Ids of entities created locally since the last sync pass |

`sync-back` reads both and merges them. `spec-stream run` is the primary writer;
`sync-back-ids.json` is a lightweight bridge for newly created entities until sync
absorbs them on its next pass.

These files are written atomically (write to `.tmp`, then rename) so concurrent sync
and sync-back processes cannot corrupt them — each file has exactly one writer.

### First run (no manifest)

When no `sync-manifest.json` exists yet (e.g. before running `spec-stream run` for
the first time), every entity on disk is treated as a create. If those entities
already exist on the board the API will return a conflict error for each one, which
is logged and skipped — nothing is duplicated. Running `spec-stream run` first to
seed the manifest is the recommended workflow.

### Operation ordering

Within a single run, operations are executed in this order to respect dependencies:

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
| New entity directory (not in manifest) | Create entity |
| `element.json` updated (name) | Rename element |
| `element.json` updated (laneId/sliceId) | Move element |
| `description.md` updated (under element) | Update element description |
| `details.md` updated (under element) | Update element details |
| `play-function.ts` updated | Update element play config |
| `play-type.ts` updated | Update element play config |
| `slice.json` updated (label) | Rename slice |
| `slice.json` updated (status) | Update slice status |
| `details.md` updated (under slice) | Update slice details |
| `lane.json` updated (label) | Rename lane |
| `lane.json` updated (height) | Resize lane |
| `chapter.json` updated (name) | Rename chapter |
| `chapter.json` updated (context) | Update chapter context |
| `milestone.json` updated | Update milestone |
| `description.md` updated (under milestone) | Update milestone description |
| `html-snippets/[slug].html` new/updated | Create or update HTML snippet content |
| `html-snippets/[slug].json` updated (name) | Update HTML snippet name |
| Entity directory deleted (id in manifest) | Delete entity |
| Entity directory renamed (same id, new dir) | Rename or move entity |
| `scenario.json` updated (expectations array) | Set or remove scenario expectations |

### Scenario expectations sync-back

When a scenario entity differs from the manifest, sync-back diffs the `expectations[]`
array against the version stored in `sync-manifest.json`:

- Expectations that are **new or changed** → `POST …/expectations` (set/upsert)
- Expectations that were **removed** → `DELETE …/expectations/{id}`

### What is intentionally skipped

- `index.md` — auto-generated summary, not synced back.
- `uuid-index.json`, `workspace.json`, `sync-state.json`, `sync-manifest.json`,
  `sync-back-ids.json` — internal bookkeeping.
- `element-details/` canonical copies — updates go through the element's own `details.md`.
- `lane-details/` — lane details are updated via `lane.json` modifications.
- Non-expectation scenario fields — managed via the prooph board UI / MCP.

---

## Command reference

```
spec-stream sync-back [options]
```

| Option | Default | Description |
|---|---|---|
| `--dry-run` | false | Log operations without calling the API |
| `--verbose` / `-v` | false | Show each detected change and verbose output |
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
- If any operations fail, `sync-back` exits with code 1 so a pre-commit hook (if used)
  aborts the commit and surfaces the failure.
- The prooph board REST API validates all inputs. If a change is structurally invalid
  (e.g. moving an element to a non-existent slice), the API returns an error which is
  logged and skipped.

---

## Architecture

```
src/sync-back/
  manifest.ts        Types + read/write helpers for sync-manifest.json and sync-back-ids.json
  manifestDiff.ts    Disk walker + manifest comparison → EntityDiff[]
  pathParser.ts      Path → entity descriptor (pure, no I/O)
  operationBuilder.ts EntityDiff[] + disk reads → SyncBackOperation[]
  executor.ts        SyncBackOperation[] + RestClient → API calls, returns new ids
  syncBack.ts        Entry point: wires the above together
  gitDiff.ts         Legacy git diff reader (kept for reference, no longer used in main path)
```

The `RestClient` (`src/sync/restClient.ts`) was extended with `postJson`, `patchJson`,
and `deleteReq` write methods used by the executor.
