# Local Model Sync (one-way projection)

**Status: design / spec. Not yet implemented.**

An optional feature that materializes the entire prooph board model into a local file
tree and keeps it up to date in near-realtime from the changelog stream `spec-stream`
already consumes. The goal is to let AI coding agents **read** the model from the
filesystem (grep/glob/cat — where agents are strongest) instead of round-tripping an MCP
server, while they continue to **write** changes through the prooph board API/MCP.

## Design decisions (settled)

- **One-way only.** Board → files. Local edits are **not** synced back; they are
  overwritten on the next projection update. Contract: *edit via MCP/API, read via files.*
- **The files are a read replica**, not a source of truth. They can be nuked and rebuilt
  from the changelog at any time. No local state is precious except the sync cursor.
- **Slice-first layout.** Lanes are nested under slices so "read everything in slice X"
  is a single directory subtree — the dominant agent query.
- **One sanitizer for name path segments.** Raw names/labels always live in the `.json`;
  the on-disk directory name is a sanitized slug. Identity is the `id`, carried in both
  the `[id]_` directory prefix and the json.
- **Shared details modeled once, copied for readability.** `details` are shared across
  elements with the same `name`+`type`+`context` (and lanes by `type`+`name`). The
  canonical copy lives in `element-details/` / `lane-details/`; each placement gets a
  copy of `details.md` for zero-indirection reads. `element.json.detailsRef` points at
  the canonical path.

## Non-goals

- No outbound sync (files → board) in this phase. May be added later as a separate,
  opt-in feature using the write endpoints in the OpenAPI spec.
- No conflict resolution, no merge base, no git dependency for correctness. (Git may be
  layered on purely for human-browsable history — optional, not load-bearing.)
- The file tree is **optimized for the reader (agent)**, not for lossless reconstruction.
  The board remains authoritative for anything the files don't capture.

---

## File structure

```
.spec-stream/
  sync-state.json                      # cursor + identity (see below)
  model/
    workspace.json                     # { id, name, syncedAt }
    chapters/
      [Context]/
        [chapterId]_[Chapter name]/
          chapter.json                 # id, name, context, index, mode, laneOrder[], sliceOrder[]
          index.md                     # generated summary (slices in order + status)
          slices/
            [index]_[sliceId]_[Slice label]/
              slice.json               # id, label, index, status, width, icon,
                                       #   + denormalized milestone fields (see note)
              details.md               # slice.details
              comments/
                [createdAt]_[commentId]/
                  comment.json         # id, author, userId, createdAt
                  comment.md           # text (with <mention userId="…"> markup)
              lanes/
                [laneType]/
                  [laneId]_[Lane label]/
                    lane.json          # id, label, type, index, height, icon
                    elements/
                      [index]_[elementId]_[Element name]/
                        element.json   # id, type, name, context, laneId, sliceId, index,
                                       #   icon, noArrowSource, noArrowTarget, detailsRef,
                                       #   playFunctionRef? (when playFunction set),
                                       #   playTypeRef? (when playType set)
                        description.md  # per-placement description
                        details.md      # copy of shared details
                        play-function.ts  # (optional) Exploration Mode play function
                        play-type.ts      # (optional) Exploration Mode play type
                        comments/
                          [createdAt]_[commentId]/{comment.json, comment.md}
    element-details/                   # canonical shared details
      [Context]/[ElementType]/[Element name]/details.md
    lane-details/                      # canonical shared lane details
      [LaneType]/[Lane name]/details.md
    milestones/
      [milestoneId]_[Milestone name]/
        milestone.json                 # id, name, deadline, color, is_completed,
                                       #   completed_at, created_at, updated_at, slices[]
        description.md
```

> **Milestone-sourced slice fields.** The API models `estimate`, `time_spent`,
> assignee, and milestone membership as a **milestone↔slice association**
> (`Milestone.slices[] = { slice_id, label, chapter_id, chapter_name, status, estimate,
> time_spent }`), not as fields on the `Slice`. The projection **denormalizes** them onto
> `slice.json` (`estimate`, `timeSpent`, `assignee`, `milestoneId`, `milestoneName`) for
> reader convenience, while `milestones/.../milestone.json` keeps the authoritative
> ordered `slices[]` list. Both are kept in sync by the reducer.

### Path-segment sanitizer (single definition)

- Lowercase is **not** forced (names can be meaningful mixed-case); only make them
  filesystem-safe.
- Replace path separators and reserved characters (`/ \ : * ? " < > |`), control chars,
  and trailing dots/spaces with `-`.
- Collapse whitespace runs to a single `-`. Trim to a max length (e.g. 80 chars).
- If the result is empty, fall back to the `id`.
- The raw value is always preserved verbatim in the entity's `.json`.
- Applied to **every** `[Name]`/`[Label]` path segment, everywhere.

---

## Sync state

`.spec-stream/sync-state.json`:

```json
{
  "workspaceId": "…",
  "cursor": { "lastEventId": "…", "lastCreatedAt": "2026-10-03T00:00:00Z" },
  "selfUserId": "…",
  "selfEmail": "…",
  "schemaVersion": 1,
  "syncedAt": "2026-10-03T00:00:00Z"
}
```

- `cursor` reuses the same changelog replay mechanism used for reconnection, so a restart
  catches up on missed events, then stays live.
- `schemaVersion` lets a future layout change trigger a full rebuild.
- **Own writes are irrelevant to the projection.** Self-event filtering is a *rule*
  concern (don't re-trigger agents). The projection applies **all** events so the mirror
  reflects the true board state, including the agent's own writes — that is exactly how
  the replica self-heals after an agent writes via MCP.

---

## Projection core

Two pure pieces plus an I/O writer:

```
applyEvent(state, event) -> state       // reducer over the in-memory model
render(state) -> FileTree               // model -> desired files
diffAndWrite(prevTree, nextTree)        // minimal fs mutations (create/update/move/delete)
```

- **In-memory `state`** is the normalized model: maps of chapters, slices, lanes,
  elements (by id), milestones, and the shared-details tables keyed by
  `context|type|name` (elements) and `type|name` (lanes).
- **Startup**: build `state` by fetching current model (GET `/chapters`, `/milestones`)
  or by replaying the changelog from zero, then `render` + write the full tree. Because
  it is a replica, a mismatch is resolved by **rebuild**, never by guessing.
- **Live**: each event → `applyEvent` → re-`render` affected subtree → `diffAndWrite`.
  Rendering can be scoped to the touched entity for efficiency; a periodic/`--rebuild`
  full render guarantees convergence.
- **Idempotent & deterministic**: replaying the same events yields the same tree. Writes
  are diff-based so unchanged files are untouched (clean git history if git is layered).

---

## Event → mutation mapping

Payload field names are from [`event-reference.md`](./event-reference.md). "FS effect"
is relative to `.spec-stream/model/`. All name/label segments go through the sanitizer.

### Chapter

| Event | State mutation | FS effect |
|-------|----------------|-----------|
| `chapter-added` | insert chapter `{id,name,mode,context,index}` | mkdir `chapters/[Context]/[id]_[name]/`; write `chapter.json`, `index.md` |
| `chapter-renamed` | set `name` | update `chapter.json`; **rename dir** `[id]_[oldName]`→`[id]_[newName]`; refresh `index.md` |
| `chapter-edited` | set `name`, `context` | if context changed, **move dir** to new `[Context]/`; update `chapter.json` |
| `chapter-removed` | delete chapter + descendants | **rmdir** chapter dir |
| `chapters-reordered` | reassign `index` per `newValue.chapterIds` | update each `chapter.json.index`; (dir names unprefixed by chapter index, so only json changes) |

### Slice

| Event | State mutation | FS effect |
|-------|----------------|-----------|
| `slice-added` | insert `newValue.slice` under chapter | mkdir `slices/[index]_[id]_[label]/`; write `slice.json`, `details.md`; refresh chapter `index.md` + `sliceOrder[]` |
| `slice-renamed` | set `label` | update `slice.json`; **rename slice dir** |
| `slices-reordered` | reassign `index` per `newValue.sliceIds` | **rename** each slice dir's `[index]_` prefix; update `slice.json.index`; refresh `chapter.json.sliceOrder[]` + `index.md` |
| `slice-removed` | delete slice + nested lanes/elements/comments | **rmdir** slice dir; refresh chapter order |
| `slice-details-changed` | set `details` | write slice `details.md` |
| `slice-status-changed` | set `status` | update `slice.json.status`; refresh `index.md` |
| `slice-icon-changed` | set `icon` | update `slice.json.icon` |
| `slice-resized` | set `width` | update `slice.json.width` |
| `slice-assignee-set` | set `assignee` (denorm) | update `slice.json.assignee` |
| `slice-estimate-set` | set `estimate` (denorm) | update `slice.json.estimate`; update milestone `slices[]` entry if assigned |
| `slice-time-spent-set` | set `timeSpent` (denorm) | update `slice.json.timeSpent`; update milestone `slices[]` entry |
| `slice-milestone-set` | add/remove milestone↔slice per `newValue.action` | update `slice.json.milestoneId/Name`; update milestone `slices[]` + `milestone.json` |
| `new-slice-comment-written` | append `newValue.comment` | mkdir `comments/[createdAt]_[id]/`; write `comment.json`+`comment.md` |
| `slice-comment-changed` | update comment `text` | rewrite `comment.md` |
| `slice-comment-removed` | drop comment | **rmdir** comment dir |
| `slice-milestone-set` (remove) | detach | as above with removal |
| `slice-mentioned` | (no structural change) | optionally append to a `mentions.md`; **default: ignore** |
| `slices-copied` | insert copied slices in target chapter | create slice subtrees in target chapter |
| `slices-moved` | move slices between chapters | **move** slice dirs to target chapter; refresh both chapters' order |

### Lane

| Event | State mutation | FS effect |
|-------|----------------|-----------|
| `lane-added` | insert `newValue.lane` | lanes are rendered **per slice**: create `lanes/[type]/[id]_[label]/` under **every** slice of the chapter; write `lane.json` |
| `lane-renamed` | set `label` | **rename lane dir** under every slice; update `lane.json` |
| `lanes-reordered` | reassign lane `index` | update each `lane.json.index`; (lane dirs grouped by type, order via json) |
| `lane-removed` | delete lane + its elements | **rmdir** lane dir under every slice |
| `lane-details-changed` | set lane `details` | write canonical `lane-details/[type]/[name]/details.md` |
| `lane-details-synchronized` | fan-out details to all lanes sharing `type`+`name` | rewrite canonical + all placement copies |
| `lane-icon-changed` | set `icon` | update `lane.json.icon` |
| `lane-resized` | set `height` | update `lane.json.height` |

> **Lane-per-slice rendering.** Because lanes are nested under slices, a lane is
> materialized once per slice in the chapter. A lane mutation fans out to each slice's
> copy. The reducer keeps lanes in `state` once (by id) and `render` expands them per
> slice; `diffAndWrite` touches only the copies that actually changed.

### Element

| Event | State mutation | FS effect |
|-------|----------------|-----------|
| `element-added` / `element-added-with-name` | insert `newValue.element` at its `laneId`×`sliceId`×`index` | mkdir `…/lanes/[type]/[lane]/elements/[index]_[id]_[name]/`; write `element.json`, `description.md`, `details.md`; set/create shared `element-details/` canonical |
| `element-copied` | insert `newValue.element` | as `element-added` |
| `element-moved` | update `laneId`,`sliceId`,`index` | **move** element dir to new slice/lane subtree; fix `[index]_` prefixes in old and new cells |
| `element-renamed` | set `name` | **rename element dir**; update `element.json`; **re-key shared details** (`element-details` path changes with name) — see note |
| `element-description-changed` | set `description` | write `description.md` |
| `element-details-changed` | set `details` | write canonical `element-details/[ctx]/[type]/[name]/details.md` + this placement copy |
| `element-details-synchronized` | fan-out to all elements sharing `ctx+type+name` | rewrite canonical + all placement copies |
| `element-config-changed` | merge `Partial<Element>` (icon, noArrow*, playFunction, playType, …) | update `element.json`; write/remove `play-function.ts` and `play-type.ts` |
| `element-config-synced` | merge synced keys (e.g. `playFunction`, `playType`) | update `element.json`; write/remove `play-function.ts` and `play-type.ts` |
| `element-comment-added` | append comment | mkdir comment dir; write `comment.json`+`comment.md` |
| `element-comment-updated` | update `text` | rewrite `comment.md` |
| `element-comment-removed` | drop comment | **rmdir** comment dir |
| `element-mentioned` | (no structural change) | **default: ignore** |
| `elements-reordered` | reassign `index` within `laneId`×`sliceId` per `newValue.elementIds` | **rename** `[index]_` prefixes of affected element dirs |
| `element-removed` | drop element | **rmdir** element dir; if last placement of a shared-details group, optionally GC canonical |

> **Rename re-keys shared details.** Because `element-details/` is keyed by
> `context/type/name`, an `element-renamed` moves the canonical details to the new name
> key. If other elements still share the **old** name, the group splits; if the new name
> matches an existing group, they merge. The reducer resolves this against the in-memory
> shared-details table rather than guessing from the filesystem.

### Milestone

| Event | State mutation | FS effect |
|-------|----------------|-----------|
| `milestone-added` | insert `newValue.milestone` | mkdir `milestones/[id]_[name]/`; write `milestone.json`, `description.md` |
| `milestone-settings-changed` | merge `{name?,description?,deadline?,color?,is_completed?}` | update `milestone.json`; rewrite `description.md`; **rename dir** if name changed |
| `milestone-deleted` | drop milestone; detach from slices | **rmdir** milestone dir; clear denormalized milestone fields on affected `slice.json` |

### Events intentionally ignored by the projection

- `*-mentioned` (no model-state change; mention markup already lives in the referenced
  text). Optional future `mentions.md`.
- Any unknown/new event type: **log and skip** (never crash). Because `render` is driven
  by `state`, an unhandled event simply leaves the tree unchanged; a periodic full
  rebuild from a fresh fetch will reconcile if the unknown event mattered.

---

## Convergence & safety

- **Rebuild is always correct.** `spec-stream sync --rebuild` (or on `schemaVersion`
  bump / corruption) wipes `.spec-stream/model/` and re-renders from a fresh model fetch.
- **Diff-based writes** keep the tree stable and git-friendly; unchanged files are not
  rewritten.
- **Generated marker.** Each generated file carries a header/comment (or a top-level
  `.spec-stream/model/README.md`) stating it is generated and local edits are not synced.
- **Untrusted content.** Event values (names, markdown) are written as file content, not
  interpolated into shell; the sanitizer prevents path traversal via crafted names.

---

## Open items

- **Config surface**: `localSync: { enabled, dir, rebuildOnStart?, git? }` in
  `proophboard.spec-stream.json` (schema addition — see `config-schema.md`).
- **Comment ordering key**: `createdAt` prefix assumes stable creation time; confirm all
  comment events carry it (element comments do; verify slice comments).
- **Assignee display**: events carry `assigneeId`; do we resolve to a name/email via
  `/me`-style lookups, or store the id only? (Default: store id, optional resolved name.)
- **Milestone↔slice fetch at startup**: milestones are not in the model export; the
  startup rebuild must call `GET /milestones` to seed `milestone.json` and the
  denormalized slice fields.
