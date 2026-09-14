# Event Reference

`spec-stream` receives prooph board **changelog events** over Supabase Realtime. This is
the catalog of event types and their payloads. Use these `type` values in a rule's `on`
field ([`config-schema.md`](./config-schema.md)).

> This list reflects prooph board at the time of writing (~50 types). prooph board adds
> event types over time; `spec-stream` treats `type` as an opaque string, so new types
> work with `"on": "<new-type>"` or `"on": "*"` even before this doc is updated.

## Realtime message → event

Each realtime message carries a changelog record with these fields:

| Field | Meaning |
|-------|---------|
| `workspace_id` | Workspace the change happened in. |
| `chapter_id` | Chapter (nullable for workspace-level events). |
| `element_id` | Element involved (nullable). |
| `slice_id` | Slice involved (nullable). |
| `user_id` | The actor who made the change. |
| `event_type` | The `type` string below. |
| `event_data` | Full event object (the envelope + `oldValue`/`newValue`). |
| `created_at` | Timestamp of the change. |

`spec-stream` normalizes this into a single `ChangelogEvent`, filling `type`, `chapterId`
and `workspaceId` from the record fields if absent from `event_data`.

## Common envelope

```ts
interface ChangelogEventBase {
  id: string;
  type: ChangelogEventType;
  timestamp: number;
  chapterId: string | null;
  chapterName: string;
  userId?: string;
  workspaceId?: string;
  elementId?: string;
  sliceId?: string;
  addedByAgent?: boolean;   // produced by an automated actor
  revertOf?: string;        // id of the event this reverts (undo/redo)
}
```

## Event types by category

### Chapter
| `type` | Key payload |
|--------|-------------|
| `chapter-added` | `newValue: { id, name, mode }` |
| `chapter-renamed` | `oldValue/newValue: { name }` |
| `chapter-edited` | `oldValue/newValue: { name, context }` |
| `chapter-removed` | `oldValue: { chapter }` |
| `chapters-reordered` | `oldValue/newValue: { chapterIds }` |

### Slice
| `type` | Key payload |
|--------|-------------|
| `slice-added` | `newValue: { slice }` |
| `slice-renamed` | `sliceId`, `oldValue/newValue: { label }` |
| `slices-reordered` | `oldValue/newValue: { sliceIds }` |
| `slice-removed` | `oldValue: { slice, elements }` |
| `slice-details-changed` | `sliceId`, `oldValue/newValue: { details }` |
| `slice-status-changed` | `sliceId`, `oldValue/newValue: { status }` |
| `slice-icon-changed` | `sliceId`, `oldValue/newValue: { icon }` |
| `slice-resized` | `sliceId`, `oldValue/newValue: { width }` |
| `slice-assignee-set` | `sliceId`, `oldValue/newValue: { assigneeId }` |
| `slice-estimate-set` | `sliceId`, `oldValue/newValue: { estimate }` |
| `slice-time-spent-set` | `sliceId`, `oldValue/newValue: { timeSpent }` |
| `new-slice-comment-written` | `sliceId`, `newValue: { comment }` |
| `slice-comment-changed` | `sliceId`, `oldValue/newValue: { commentId, text }` |
| `slice-comment-removed` | `sliceId`, `oldValue: { comment }`, `newValue: { commentId }` |
| `slice-milestone-set` | `sliceId`, `newValue: { milestoneId, sliceId, action }` |
| `slice-mentioned` | `sliceId`, `context`, `mentionedUserIds`, `oldValue/newValue: { markdown }` |
| `slices-copied` | `sourceChapterId`, `targetChapterId`, `newValue: { slices, … }` |
| `slices-moved` | `sourceChapterId`, `targetChapterId`, `newValue: { slices, … }` |

### Lane
| `type` | Key payload |
|--------|-------------|
| `lane-added` | `newValue: { lane }` |
| `lane-renamed` | `laneId`, `oldValue/newValue: { label }` |
| `lanes-reordered` | `oldValue/newValue: { laneIds }` |
| `lane-removed` | `oldValue: { lane, elements }` |
| `lane-details-changed` | `laneId`, `oldValue/newValue: { details }` |
| `lane-details-synchronized` | `laneId`, `laneName`, `oldValue/newValue: { details }` |
| `lane-icon-changed` | `laneId`, `oldValue/newValue: { icon }` |
| `lane-resized` | `laneId`, `oldValue/newValue: { height }` |

### Element (sticky notes)
| `type` | Key payload |
|--------|-------------|
| `element-added` | `sliceId`, `newValue: { element }` |
| `element-added-with-name` | as above, name provided |
| `element-copied` | `sliceId`, `sourceElementId`, `newValue: { element }` |
| `element-moved` | `elementId`, `elementType`, `oldValue/newValue: { laneId, sliceId, index }` |
| `element-renamed` | `elementId`, `elementType`, `oldValue/newValue: { name }` |
| `element-description-changed` | `elementId`, `elementType`, `oldValue/newValue: { description }` |
| `element-details-changed` | `elementId`, `elementType`, `oldValue/newValue: { details }` |
| `element-details-synchronized` | `elementId`, `oldValue/newValue: { details }` |
| `element-config-changed` | `elementId`, `oldValue/newValue: Partial<Element>` |
| `element-comment-added` | `elementId`, `newValue: { id, text, author, userId, createdAt }` |
| `element-comment-updated` | `elementId`, `commentId`, `oldValue/newValue: { text }` |
| `element-comment-removed` | `elementId`, `commentId`, `oldValue: { … }` |
| `element-mentioned` | `elementId`, `context`, `mentionedUserIds`, `oldValue/newValue: { markdown }` |
| `elements-reordered` | `laneId`, `sliceId`, `oldValue/newValue: { elementIds }` |
| `element-removed` | `sliceId`, `oldValue: { element }` |

### Milestone
| `type` | Key payload |
|--------|-------------|
| `milestone-added` | `newValue: { milestone }` |
| `milestone-settings-changed` | `milestoneId`, `oldValue/newValue: { name?, description?, deadline? }` |
| `milestone-deleted` | `oldValue: { milestone }` |

## Element types (`elementType` values)

Used by the `when.elementType` filter. Common values: `command`, `event`, `information`,
`aggregate`, `ui`, `policy`/`processor`, `external-system`, `hot-spot`, plus `lane` and
`slice` for structural elements.

## Notes for rule authors

- **The most useful events for spec-driven automation** are usually
  `element-description-changed` and `element-details-changed` (a spec was written/edited),
  plus `element-added` / `element-renamed` (new work appeared).
- `element-details-synchronized` and `lane-details-synchronized` are prooph board's
  internal merge/sync events; you usually **don't** want to trigger agents on them.
- Events with `addedByAgent: true` are excluded by default (see `when.addedByAgent`) to
  prevent agents re-triggering themselves.
- Prefer `elementId`/`sliceId`/`chapterId` from the envelope for concurrency keys — they
  are reliably present on the row even when omitted from `event_data`.
