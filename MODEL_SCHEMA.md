# Local Model — File Tree Reference for Agents

This document describes the local file tree written by `spec-stream run` under
`.spec-stream/model/` (or the `localSync.dir` you configured). It is the primary
reference for agents that read or write the model.

---

## Quick orientation

```
.spec-stream/model/
  workspace.json          # workspace id + name
  uuid-index.json         # { uuid → "relative/dir" }  ← resolve any id to its path
  chapters/
    [Context]/
      [Chapter]/
        chapter.json
        index.md          # generated — DO NOT EDIT
        slices/
          [NNNN]_[Slice]/
            slice.json
            details.md
            lanes/
              [laneType]/
                [Lane]/
                  lane.json
                  elements/
                    [NNNN]_[Element]/
                      element.json
                      description.md
                      details.md
                      play-function.ts    # only if set
                      play-type.ts        # only if set
        scenarios/
          [Scenario]/
            scenario.json
  element-details/
    [Context]/[type]/[Name]/details.md   # canonical shared details
  milestones/
    [Milestone]/
      milestone.json
      description.md
  html-snippets/
    [slug].html
    [slug].json
```

**Key facts:**
- Directory names are sanitized slugs of the raw name. The raw value is always in the `.json`.
- Slice and element dirs are prefixed with a zero-padded index (`0001_`, `0002_`…) that reflects their order on the board.
- Lane dirs are NOT indexed — their order is `lane.json.index`.
- Lanes are only materialized for slices that actually contain elements in that lane.
- `uuid-index.json` maps every UUID to its directory. Use it to jump from a UUID (from an event or MCP call) to the right path without traversing the tree.
- `index.md` is auto-generated from the board state and overwritten on every sync — do not edit it.

---

## Read-only files (generated, overwritten by sync)

- `index.md` — chapter slice summary
- `uuid-index.json` — UUID→path lookup
- `workspace.json`
- `element-details/` — canonical shared details mirrored here; edit via the placement `details.md` instead

---

## Editable files (synced back to prooph board on `git commit`)

These files can be created or modified by an agent. On the next `git commit` the
pre-commit hook calls `@proophboard/spec-stream sync-back` which pushes the changes to the board.

| File | What it maps to |
|------|-----------------|
| `element.json` | element name, type, position (laneId/sliceId/index) |
| `description.md` | element description (the short sticky-note text) |
| `details.md` (in element dir) | element details (rich markdown content) |
| `play-function.ts` | Exploration Mode decide/apply handler |
| `play-type.ts` | Exploration Mode Payload type (without the `type Payload =` prefix — that is added automatically) |
| `scenario.json` | scenario definition, interactions, expectations |
| `slice.json` | slice label, status |
| `slice details.md` | slice details |
| `lane.json` | lane label, height |
| `chapter.json` | chapter name, context |
| `milestone.json` | milestone name, deadline, color |
| `milestone description.md` | milestone description |

---

## JSON schemas

### `workspace.json`
```json
{ "id": "uuid", "name": "Workspace Name" }
```

### `chapter.json`
```json
{
  "id": "uuid",
  "name": "Chapter Name",
  "context": "Bounded Context",
  "index": 0,
  "mode": "event-modeling",
  "sliceOrder": ["uuid", "uuid"],
  "laneOrder":  ["uuid", "uuid"]
}
```
`mode` is `"event-modeling"` or `"freestyle"`.

### `slice.json`
```json
{
  "id": "uuid",
  "label": "Slice Label",
  "index": 1,
  "status": "draft",
  "width": 250,
  "milestoneId": "uuid",
  "milestoneName": "MVP"
}
```
`status` values: `draft` | `planned` | `in-progress` | `blocked` | `ready` | `reviewed` | `deployed`

### `lane.json`
```json
{
  "id": "uuid",
  "label": "Lane Label",
  "type": "information-flow",
  "index": 1,
  "height": 150
}
```
`type` values: `user-lane` | `information-flow` | `system`

### `element.json`
```json
{
  "id": "uuid",
  "type": "command",
  "name": "Create Todo",
  "context": "Todo Management",
  "laneId": "uuid",
  "sliceId": "uuid",
  "index": 0,
  "detailsRef": "element-details/Todo-Management/command/Create-Todo/details.md",
  "playFunctionRef": "…/play-function.ts",
  "playTypeRef": "…/play-type.ts"
}
```
`type` values: `command` | `event` | `information` | `ui` | `automation` | `hotspot`

`playFunctionRef` / `playTypeRef` are only present when the corresponding file exists.
`detailsRef` always points to the canonical shared details file.

### `scenario.json`
```json
{
  "id": "uuid",
  "chapterId": "uuid",
  "name": "Add first Todo",
  "clock": "2026-01-01T00:00:00Z",
  "initialState": {
    "ContextName": { "ViewName": [] }
  },
  "seededEvents": [
    { "name": "Todo Added", "context": "Todo Management", "payload": { "title": "Buy Milk" } }
  ],
  "interactions": [
    { "stepIndex": 0, "storage": { "title": "Buy Milk" } }
  ],
  "expectations": [
    {
      "id": "uuid",
      "sliceId": "uuid",
      "kind": "information",
      "elementId": "uuid",
      "match": "subset",
      "expected": {
        "view": "read",
        "value": { "title": "Buy Milk", "status": "open" }
      }
    }
  ],
  "createdAt": "2026-10-04T19:45:13Z",
  "updatedAt": "2026-10-06T10:32:47Z"
}
```

**`kind`** values: `events` | `information` | `rejection`

**`kind: "events"` expectation:**
```json
{
  "id": "uuid",
  "sliceId": "uuid",
  "kind": "events",
  "match": "exact",
  "expected": {
    "events": [
      { "name": "Todo Added", "context": "Todo Management", "payload": { "title": "Buy Milk" } }
    ]
  }
}
```

**`kind: "rejection"` expectation:**
```json
{
  "id": "uuid",
  "sliceId": "uuid",
  "kind": "rejection",
  "expected": { "message": "Title is required" }
}
```

`match` defaults: `events` → `"exact"`, `information` → `"subset"`. Omit to use the default.

Fields `clock`, `initialState`, `seededEvents`, `interactions`, `expectations` are optional — omit entirely rather than setting to `null`/`[]`.

### `milestone.json`
```json
{
  "id": "uuid",
  "name": "MVP",
  "deadline": "2026-12-31",
  "color": "#3b82f6",
  "isCompleted": false,
  "slices": [{ "sliceId": "uuid", "chapterId": "uuid", "label": "Plan Todo" }]
}
```

---

## `uuid-index.json`

Flat map of every UUID to the directory that contains its primary `.json`:

```json
{
  "2ee8e1ec-f9c9-44c5-ba42-2179aaf1cd0c": "chapters/Todo-Management/Manage-Todolist",
  "b6deb81e-7704-4716-8e75-749325effbee": "chapters/Todo-Management/Manage-Todolist/slices/0001_Plan-Todo",
  "9ef03fea-3c84-4f3a-956f-43a949b6dbe9": "chapters/Todo-Management/Manage-Todolist/slices/0001_Plan-Todo/lanes/information-flow/Information-Flow/elements/0000_Create-Todo"
}
```

Use this to resolve a UUID from a changelog event or MCP response to a local path without recursing the tree.

---

## play-function.ts

The full TypeScript handler for a command or event. The function signature expected by
the Exploration Mode runner:

```typescript
// For a command element — decide function
async function decide(command: Payload, state: Record<string, unknown>) {
  // return an array of events
  return [{ name: "Todo Added", payload: { title: command.title } }];
}

// For an event element — apply function
function apply(event: Payload, state: Record<string, unknown>) {
  // return new state
  return { ...state, todos: [...(state.todos ?? []), event.payload] };
}
```

The file must export `decide` or `apply` (or both). Named exports, not default.

## play-type.ts

The TypeScript type for the command/event payload, written as a full type alias:

```typescript
// play-type.ts
type Payload = {
  title: string;
  until?: string;
}
```

The `type Payload = ` prefix is stripped automatically by `sync-back` before sending the value to prooph board (which stores only the type body). Always write the full alias in the file — it makes the file valid TypeScript and readable as-is.

---

## How to write a scenario (step by step)

1. Find the chapter directory: `uuid-index.json["<chapterId>"]`
2. Create a new directory under `scenarios/`: name it a sanitized slug of the scenario name (e.g. `Add-first-Todo`).
3. Write `scenario.json` with at minimum `id` (generate a UUID v4), `chapterId`, and `name`.
4. Add `interactions` if you have UI form input to simulate.
5. Add `expectations` for each slice you want to assert.
6. Run `spec-stream scenario test --chapter <path>` to verify before committing.

To find slice IDs for expectations, read `slice.json` in the relevant slice directory, or look them up in `uuid-index.json` (search by partial path).

---

## How sync-back works

On `git commit`, the pre-commit hook runs `@proophboard/spec-stream sync-back`. It diffs staged
changes against HEAD and translates them into prooph board API calls:

- Modified `element.json` → rename and/or move element
- Modified `description.md` / `details.md` → update description/details
- Modified `play-function.ts` / `play-type.ts` → update element config
- Modified `scenario.json` → set/remove expectations
- Added files → create the entity
- Deleted primary `.json` → delete the entity

If any API call fails, the hook exits non-zero and the commit is aborted. Fix the issue
and try again.

**Preview without committing:**
```sh
git add .spec-stream/model/
@proophboard/spec-stream sync-back --dry-run --verbose
```

---

## Validate the model before committing

```sh
@proophboard/spec-stream model validate
```

Checks:
- All `.json` files are valid JSON
- `element.json` `laneId` and `sliceId` exist in `uuid-index.json`
- Scenario `sliceId` and `elementId` in expectations exist in `uuid-index.json`
- No duplicate UUIDs in `uuid-index.json` pointing to different dirs
- Directory slug matches the sanitized name in the corresponding `.json`

Exits 0 if clean, 1 if issues found. Use `--verbose` to see all checked paths.
