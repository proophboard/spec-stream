/**
 * prooph board changelog event types and realtime-row normalization.
 *
 * `spec-stream` treats the event `type` as an opaque string so that new prooph board
 * event types work without a code change. The types below document the known catalog
 * (see docs/event-reference.md) but are intentionally open (`string` union member).
 */

/** Known prooph board changelog event types (non-exhaustive — new ones are accepted). */
export type KnownChangelogEventType =
  | "chapter-added"
  | "chapter-renamed"
  | "chapter-edited"
  | "chapter-removed"
  | "chapters-reordered"
  | "slice-added"
  | "slice-renamed"
  | "slices-reordered"
  | "slice-removed"
  | "slice-details-changed"
  | "slice-status-changed"
  | "slice-icon-changed"
  | "slice-resized"
  | "slice-assignee-set"
  | "slice-estimate-set"
  | "slice-time-spent-set"
  | "new-slice-comment-written"
  | "slice-comment-changed"
  | "slice-comment-removed"
  | "slice-milestone-set"
  | "slice-mentioned"
  | "slices-copied"
  | "slices-moved"
  | "lane-added"
  | "lane-renamed"
  | "lanes-reordered"
  | "lane-removed"
  | "lane-details-changed"
  | "lane-details-synchronized"
  | "lane-icon-changed"
  | "lane-resized"
  | "element-added"
  | "element-added-with-name"
  | "element-copied"
  | "element-moved"
  | "element-renamed"
  | "element-description-changed"
  | "element-details-changed"
  | "element-details-synchronized"
  | "element-config-changed"
  | "element-comment-added"
  | "element-comment-updated"
  | "element-comment-removed"
  | "element-mentioned"
  | "elements-reordered"
  | "element-removed"
  | "milestone-added"
  | "milestone-settings-changed"
  | "milestone-deleted";

/** Open string union: any known type OR any other string prooph board may emit. */
export type ChangelogEventType = KnownChangelogEventType | (string & {});

/**
 * A raw `changelog_events` row as delivered by Supabase Realtime `payload.new`.
 * Columns mirror the prooph board table.
 */
export interface ChangelogEventRow {
  id: string;
  workspace_id: string;
  chapter_id: string | null;
  element_id: string | null;
  slice_id: string | null;
  user_id: string;
  event_type: string;
  event_data: Record<string, unknown> | null;
  created_at: string;
}

/**
 * A normalized changelog event: the `event_data` payload merged with the guaranteed
 * envelope fields taken from the row columns. This is what the router, scheduler, and
 * command runner consume.
 */
export interface ChangelogEvent {
  /** Event id (from event_data.id or the row id). */
  id: string;
  /** Event type (from event_data.type or the row event_type). */
  type: ChangelogEventType;
  /** Unix ms timestamp when known (event_data.timestamp), else derived from created_at. */
  timestamp: number;
  workspaceId: string;
  chapterId: string | null;
  chapterName?: string;
  elementId?: string;
  elementName?: string;
  elementType?: string;
  sliceId?: string;
  sliceName?: string;
  userId?: string;
  context?: string;
  addedByAgent: boolean;
  /** ISO timestamp of the DB row insertion. */
  createdAt: string;
  /** Full original event payload (event_data), for command stdin and advanced filters. */
  data: Record<string, unknown>;
  /** The raw row, preserved for command stdin and diagnostics. */
  row: ChangelogEventRow;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

/**
 * Normalize a raw realtime row into a {@link ChangelogEvent}.
 *
 * Envelope fields (`type`, `chapterId`, `workspaceId`, `elementId`, `sliceId`, `userId`)
 * are taken from `event_data` when present and fall back to the row columns — matching
 * prooph board's own handling, since agent-emitted events may omit them from event_data.
 *
 * @throws {Error} if the row is missing required identity columns.
 */
export function normalizeRow(row: ChangelogEventRow): ChangelogEvent {
  if (!row || typeof row !== "object") {
    throw new Error("Invalid changelog row: not an object");
  }
  if (!row.workspace_id) {
    throw new Error("Invalid changelog row: missing workspace_id");
  }
  if (!row.event_type && !(row.event_data && (row.event_data as Record<string, unknown>).type)) {
    throw new Error("Invalid changelog row: missing event_type");
  }

  const data: Record<string, unknown> =
    row.event_data && typeof row.event_data === "object" ? row.event_data : {};

  const type = asString(data.type) ?? row.event_type;
  const id = asString(data.id) ?? row.id;

  const tsRaw = data.timestamp;
  const timestamp =
    typeof tsRaw === "number" && Number.isFinite(tsRaw)
      ? tsRaw
      : Date.parse(row.created_at) || Date.now();

  return {
    id,
    type,
    timestamp,
    workspaceId: asString(data.workspaceId) ?? row.workspace_id,
    chapterId: asString(data.chapterId) ?? row.chapter_id ?? null,
    chapterName: asString(data.chapterName),
    elementId: asString(data.elementId) ?? row.element_id ?? undefined,
    elementName: asString(data.elementName),
    elementType: asString(data.elementType),
    sliceId: asString(data.sliceId) ?? row.slice_id ?? undefined,
    sliceName: asString(data.sliceName),
    userId: asString(data.userId) ?? row.user_id ?? undefined,
    context: asString(data.context),
    addedByAgent: asBoolean(data.addedByAgent) ?? false,
    createdAt: row.created_at,
    data,
    row,
  };
}
