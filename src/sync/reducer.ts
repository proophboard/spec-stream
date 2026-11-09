/**
 * Pure projection reducer: `applyEvent(state, event) -> state`.
 *
 * Maps each prooph board changelog event to a mutation of the in-memory {@link ModelState}.
 * This module performs **no I/O** — it only updates the normalized model. The renderer and
 * writer turn the resulting state into files.
 *
 * The reducer mutates the passed `state` in place and returns it (the state is owned by the
 * projection loop, not shared). It is defensive about payload shape because event data is
 * untrusted: missing/edge payloads are skipped rather than throwing, so one odd event never
 * stops the stream. Unknown event types are ignored (a periodic full rebuild reconciles).
 *
 * Payload field references are from docs/event-reference.md. See docs/local-sync.md for the
 * full event → mutation table.
 */

import type { ChangelogEvent } from "../realtime/events.js";
import {
  type ModelState,
  type ChapterState,
  type SliceState,
  type LaneState,
  type ElementState,
  type MilestoneState,
  type MilestoneSliceRef,
  type ScenarioState,
  type ScenarioExpectation,
  type SeededEvent,
  type ScenarioInteraction,
  type HtmlSnippetState,
  type Comment,
  type SharedDetailsEntry,
  laneDetailsKey,
} from "./model.js";

/**
 * Tracks which entities were touched by a single `applyEvent` call so the projection
 * can write only the affected files instead of the entire tree.
 *
 * Callers accumulate dirty sets across the debounce window; `flushWrite` consumes and
 * resets the accumulated set after each write pass.
 */
export interface DirtySet {
  chapters: Set<string>;
  slices: Set<string>;
  lanes: Set<string>;
  elements: Set<string>;
  milestones: Set<string>;
  scenarios: Set<string>;
  /** Keyed by slug. */
  htmlSnippets: Set<string>;
  /** Keyed by laneDetailsKey (type\0name). */
  sharedLaneDetails: Set<string>;
  /** True when workspace-level fields (name) changed. */
  workspace: boolean;
  /**
   * Per-element file-level dirty tracking.
   * Maps element id → set of file basenames that need to be rewritten.
   * The special sentinel `"*"` means "all files for this element".
   * When an element id is in `elements` but absent from this map, all files are written
   * (backwards-compatible default — no regression for callers that only set `elements`).
   */
  elementFiles: Map<string, Set<string>>;
  /**
   * Per-slice file-level dirty tracking (same sentinel convention as elementFiles).
   * Files: "slice.json", "details.md", "comments", "*".
   */
  sliceFiles: Map<string, Set<string>>;
  /**
   * Per-milestone file-level dirty tracking (same sentinel convention as elementFiles).
   * Files: "milestone.json", "description.md", "*".
   */
  milestoneFiles: Map<string, Set<string>>;
  /**
   * Relative paths (from model root) of entity directories or files to delete immediately
   * during a partial write. Populated by deletion handlers at the time they still hold the
   * entity reference (so the path can be derived from state before the entity is removed).
   * Avoids the need to do a disk UUID-index lookup in renderPartial.
   * Examples: "chapters/c1/elements/el1", "chapters/c1/slices/s1", "milestones/m1".
   */
  dirsToDelete: Set<string>;
}

export function emptyDirtySet(): DirtySet {
  return {
    chapters: new Set(),
    slices: new Set(),
    lanes: new Set(),
    elements: new Set(),
    milestones: new Set(),
    scenarios: new Set(),
    htmlSnippets: new Set(),
    sharedLaneDetails: new Set(),
    workspace: false,
    elementFiles: new Map(),
    sliceFiles: new Map(),
    milestoneFiles: new Map(),
    dirsToDelete: new Set(),
  };
}

/** Merge file-level dirty maps (helper shared by mergeDirty). */
function mergeFileMaps(target: Map<string, Set<string>>, src: Map<string, Set<string>>): void {
  for (const [id, files] of src) {
    const existing = target.get(id);
    if (!existing) {
      target.set(id, new Set(files));
    } else {
      for (const f of files) existing.add(f);
    }
  }
}

export function mergeDirty(target: DirtySet, src: DirtySet): void {
  for (const id of src.chapters) target.chapters.add(id);
  for (const id of src.slices) target.slices.add(id);
  for (const id of src.lanes) target.lanes.add(id);
  for (const id of src.elements) target.elements.add(id);
  for (const id of src.milestones) target.milestones.add(id);
  for (const id of src.scenarios) target.scenarios.add(id);
  for (const id of src.htmlSnippets) target.htmlSnippets.add(id);
  for (const id of src.sharedLaneDetails) target.sharedLaneDetails.add(id);
  if (src.workspace) target.workspace = true;
  mergeFileMaps(target.elementFiles, src.elementFiles);
  mergeFileMaps(target.sliceFiles, src.sliceFiles);
  mergeFileMaps(target.milestoneFiles, src.milestoneFiles);
  for (const p of src.dirsToDelete) target.dirsToDelete.add(p);
}

/** Apply one event, mutating and returning `state`. Never throws on bad payloads. */
export function applyEvent(state: ModelState, event: ChangelogEvent, dirty?: DirtySet): ModelState {
  try {
    const handler = HANDLERS[event.type];
    if (handler) handler(state, event, dirty ?? emptyDirtySet());
  } catch {
    // Untrusted payloads must never crash the projection; a rebuild reconciles if needed.
  }
  return state;
}

// ─────────────────────────── helpers ───────────────────────────

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
function strArr(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
}

function newValue(e: ChangelogEvent): Record<string, unknown> {
  return obj(e.data.newValue);
}
function oldValue(e: ChangelogEvent): Record<string, unknown> {
  return obj(e.data.oldValue);
}

/**
 * Apply playFunction/playType from a config event's newValue to an element.
 * The board sends `null` when a play config is cleared — `str(null)` is
 * undefined, so "key present with a non-string value" must clear the field
 * rather than leave the stale value in the model.
 */
function applyPlayConfig(el: ElementState, nv: Record<string, unknown>): void {
  if ("playFunction" in nv) {
    const v = str(nv.playFunction);
    if (v) el.playFunction = v;
    else delete el.playFunction;
  }
  if ("playType" in nv) {
    const v = str(nv.playType);
    if (v) el.playType = v;
    else delete el.playType;
  }
}

/** Reassign `index` on children according to an ordered id list. */
function reindex(ids: string[], get: (id: string) => { index: number } | undefined): void {
  ids.forEach((id, i) => {
    const child = get(id);
    if (child) child.index = i;
  });
}

// ───────────────── shared-details table management ─────────────────

function getOrCreateShared(
  table: Map<string, SharedDetailsEntry>,
  key: string,
): SharedDetailsEntry {
  let entry = table.get(key);
  if (!entry) {
    entry = { key, body: "", members: new Set() };
    table.set(key, entry);
  }
  return entry;
}

/** Add a member to a shared-details group, seeding the body if the group is new/empty. */
function joinShared(
  table: Map<string, SharedDetailsEntry>,
  key: string,
  memberId: string,
  body: string,
): void {
  const entry = getOrCreateShared(table, key);
  entry.members.add(memberId);
  if (entry.body.length === 0 && body.length > 0) entry.body = body;
}

/** Remove a member; drop the group entirely when empty (GC the canonical file later). */
function leaveShared(
  table: Map<string, SharedDetailsEntry>,
  key: string,
  memberId: string,
): void {
  const entry = table.get(key);
  if (!entry) return;
  entry.members.delete(memberId);
  if (entry.members.size === 0) table.delete(key);
}

/** Propagate a details body to every member of a group (fan-out). */
function setSharedBody(
  table: Map<string, SharedDetailsEntry>,
  key: string,
  body: string,
  applyToMember: (memberId: string) => void,
): void {
  const entry = getOrCreateShared(table, key);
  entry.body = body;
  for (const id of entry.members) applyToMember(id);
}

function laneKeyOf(lane: LaneState): string {
  return laneDetailsKey(lane.type, lane.label);
}

// ───────────────── chapter builders ─────────────────

function putChapterFromRaw(state: ModelState, raw: Record<string, unknown>): void {
  const id = str(raw.id);
  if (!id) return;
  const existing = state.chapters.get(id);
  const chapter: ChapterState = {
    id,
    name: str(raw.name) ?? existing?.name ?? "",
    context: str(raw.context) ?? existing?.context ?? "",
    index: num(raw.index) ?? existing?.index ?? 0,
    mode: str(raw.mode) ?? existing?.mode ?? "event-modeling",
    sliceOrder: existing?.sliceOrder ?? [],
    laneOrder: existing?.laneOrder ?? [],
  };
  state.chapters.set(id, chapter);
}

function putSliceFromRaw(
  state: ModelState,
  chapterId: string,
  raw: Record<string, unknown>,
): void {
  const id = str(raw.id);
  if (!id) return;
  const existing = state.slices.get(id);
  const slice: SliceState = {
    id,
    label: str(raw.label) ?? existing?.label ?? "",
    chapterId,
    index: num(raw.index) ?? existing?.index ?? 0,
    status: str(raw.status) ?? existing?.status,
    width: num(raw.width) ?? existing?.width,
    icon: str(raw.icon) ?? existing?.icon,
    details: str(raw.details) ?? existing?.details ?? "",
    comments: commentsFromRaw(raw.comments) ?? existing?.comments ?? [],
    milestoneId: existing?.milestoneId,
    milestoneName: existing?.milestoneName,
    assignee: existing?.assignee,
    estimate: existing?.estimate,
    timeSpent: existing?.timeSpent,
  };
  state.slices.set(id, slice);
  const chapter = state.chapters.get(chapterId);
  if (chapter && !chapter.sliceOrder.includes(id)) {
    chapter.sliceOrder.push(id);
  }
}

function putLaneFromRaw(
  state: ModelState,
  chapterId: string,
  raw: Record<string, unknown>,
): void {
  const id = str(raw.id);
  if (!id) return;
  const existing = state.lanes.get(id);
  const lane: LaneState = {
    id,
    label: str(raw.label) ?? existing?.label ?? "",
    type: str(raw.type) ?? existing?.type ?? "user-lane",
    chapterId,
    index: num(raw.index) ?? existing?.index ?? 0,
    height: num(raw.height) ?? existing?.height,
    icon: str(raw.icon) ?? existing?.icon,
  };
  state.lanes.set(id, lane);
  const chapter = state.chapters.get(chapterId);
  if (chapter && !chapter.laneOrder.includes(id)) chapter.laneOrder.push(id);
  // Lane participates in the shared lane-details group.
  joinShared(state.sharedLaneDetails, laneKeyOf(lane), id, "");
}

function putElementFromRaw(
  state: ModelState,
  chapterId: string,
  raw: Record<string, unknown>,
): void {
  const id = str(raw.id);
  if (!id) return;
  const existing = state.elements.get(id);
  const context = str(raw.context) ?? existing?.context ?? "";
  const type = str(raw.type) ?? existing?.type ?? "";
  const name = str(raw.name) ?? existing?.name ?? "";
  const details = str(raw.details) ?? existing?.details ?? "";
  const el: ElementState = {
    id,
    type,
    name,
    context,
    description: str(raw.description) ?? existing?.description ?? "",
    details,
    laneId: str(raw.laneId) ?? existing?.laneId ?? "",
    sliceId: str(raw.sliceId) ?? existing?.sliceId ?? "",
    chapterId,
    index: num(raw.index) ?? existing?.index ?? 0,
    icon: str(raw.icon) ?? existing?.icon,
    noArrowSource: bool(raw.noArrowSource) ?? existing?.noArrowSource,
    noArrowTarget: bool(raw.noArrowTarget) ?? existing?.noArrowTarget,
    comments: commentsFromRaw(raw.comments) ?? existing?.comments ?? [],
    // Full-element payloads are authoritative for play config: an absent or
    // null playFunction/playType means "no play config", not "keep existing".
    playFunction: str(raw.playFunction),
    playType: str(raw.playType),
  };
  state.elements.set(id, el);
}

function commentFromRaw(raw: Record<string, unknown>): Comment | undefined {
  const id = str(raw.id);
  if (!id) return undefined;
  return {
    id,
    text: str(raw.text) ?? "",
    author: str(raw.author),
    userId: str(raw.userId),
    // The board sends `createdAt` as a numeric ms-epoch on live comment events
    // (e.g. 1794221000742) but as an ISO string on seeded/REST payloads. Accept
    // both so the comment directory name and metadata stay stable across paths.
    createdAt: str(raw.createdAt) ?? (num(raw.createdAt) !== undefined ? String(num(raw.createdAt)) : undefined),
    isTask: bool(raw.isTask) ?? bool(raw.is_task),
  };
}

/**
 * Parse an array of raw comment objects into {@link Comment}s. Returns undefined when
 * `raw` is not an array (so callers fall back to existing comments), and an empty array
 * for an explicitly-empty list. Used when a full slice/element payload carries its
 * comments inline — e.g. load-from-disk, where comments are rehydrated from the
 * comment.json/comment.md files rather than replayed as separate add events.
 */
function commentsFromRaw(raw: unknown): Comment[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Comment[] = [];
  for (const item of raw) {
    const c = commentFromRaw(obj(item));
    if (c) out.push(c);
  }
  return out;
}

/**
 * Remove a comment from an element and prune its on-disk directory.
 *
 * Comments live in per-comment subdirectories under `.../comments/`. A partial write
 * never deletes files that are not re-rendered, so dropping the comment from the model
 * alone would leave the old `comment.json`/`comment.md` on disk forever. We therefore
 * schedule the entity's whole `comments/` directory for deletion (`dirsToDelete`), which
 * `writeTree` removes *before* re-writing the surviving comments in the same pass.
 *
 * Handles both plain removal (`element-comment-removed`) and task resolution
 * (`element-comment-resolved`) — on the board, resolving a task comment is how it is
 * removed, and it emits a distinct event type with the same payload shape.
 */
function removeElementComment(
  state: ModelState,
  e: ChangelogEvent,
  d: DirtySet,
): void {
  const el = e.elementId ? state.elements.get(e.elementId) : undefined;
  if (!el) return;
  const commentId = str(e.data.commentId) ?? str(obj(oldValue(e).comment).id);
  if (!commentId) return;
  const before = el.comments.length;
  el.comments = el.comments.filter((x) => x.id !== commentId);
  if (el.comments.length === before) return; // nothing changed — skip churn
  d.dirsToDelete.add(`chapters/${el.chapterId}/elements/${el.id}/comments`);
  markElementFiles(d, el.id, "comments");
}

/** Slice counterpart to {@link removeElementComment}. */
function removeSliceComment(
  state: ModelState,
  e: ChangelogEvent,
  d: DirtySet,
): void {
  const sl = e.sliceId ? state.slices.get(e.sliceId) : undefined;
  if (!sl) return;
  const commentId = str(newValue(e).commentId) ?? str(obj(oldValue(e).comment).id) ?? str(e.data.commentId);
  if (!commentId) return;
  const before = sl.comments.length;
  sl.comments = sl.comments.filter((x) => x.id !== commentId);
  if (sl.comments.length === before) return;
  d.dirsToDelete.add(`chapters/${sl.chapterId}/slices/${sl.id}/comments`);
  markSliceFiles(d, sl.id, "comments");
}


function removeElement(state: ModelState, el: ElementState): void {
  state.elements.delete(el.id);
}

function removeSlice(state: ModelState, sliceId: string): void {
  const slice = state.slices.get(sliceId);
  if (!slice) return;
  for (const el of [...state.elements.values()]) {
    if (el.sliceId === sliceId) removeElement(state, el);
  }
  const chapter = state.chapters.get(slice.chapterId);
  if (chapter) chapter.sliceOrder = chapter.sliceOrder.filter((x) => x !== sliceId);
  state.slices.delete(sliceId);
}

function removeLane(state: ModelState, laneId: string): void {
  const lane = state.lanes.get(laneId);
  if (!lane) return;
  for (const el of [...state.elements.values()]) {
    if (el.laneId === laneId) removeElement(state, el);
  }
  leaveShared(state.sharedLaneDetails, laneKeyOf(lane), laneId);
  const chapter = state.chapters.get(lane.chapterId);
  if (chapter) chapter.laneOrder = chapter.laneOrder.filter((x) => x !== laneId);
  state.lanes.delete(laneId);
}

// ───────────────── handler table ─────────────────

type Handler = (state: ModelState, event: ChangelogEvent, dirty: DirtySet) => void;

/**
 * Mark specific files as dirty for an element.
 * Uses the sentinel "*" to mean "all files" (e.g. on add/replace/remove).
 * Always also adds the element id to d.elements so renderPartial knows the element is dirty.
 */
function markElementFiles(d: DirtySet, id: string, ...files: string[]): void {
  d.elements.add(id);
  const existing = d.elementFiles.get(id);
  if (existing?.has("*")) return; // already marked as fully dirty
  if (files.includes("*")) {
    d.elementFiles.set(id, new Set(["*"]));
    return;
  }
  if (!existing) {
    d.elementFiles.set(id, new Set(files));
  } else {
    for (const f of files) existing.add(f);
  }
}

/** Same as markElementFiles but for slices. Files: "slice.json", "details.md", "comments", "*". */
function markSliceFiles(d: DirtySet, id: string, ...files: string[]): void {
  d.slices.add(id);
  const existing = d.sliceFiles.get(id);
  if (existing?.has("*")) return;
  if (files.includes("*")) {
    d.sliceFiles.set(id, new Set(["*"]));
    return;
  }
  if (!existing) {
    d.sliceFiles.set(id, new Set(files));
  } else {
    for (const f of files) existing.add(f);
  }
}

/** Same as markElementFiles but for milestones. Files: "milestone.json", "description.md", "*". */
function markMilestoneFiles(d: DirtySet, id: string, ...files: string[]): void {
  d.milestones.add(id);
  const existing = d.milestoneFiles.get(id);
  if (existing?.has("*")) return;
  if (files.includes("*")) {
    d.milestoneFiles.set(id, new Set(["*"]));
    return;
  }
  if (!existing) {
    d.milestoneFiles.set(id, new Set(files));
  } else {
    for (const f of files) existing.add(f);
  }
}

const HANDLERS: Record<string, Handler> = {
  // ── Chapter ──
  "chapter-added": (s, e, d) => {
    putChapterFromRaw(s, { ...newValue(e), context: str(newValue(e).context) ?? e.context });
    const id = str(newValue(e).id) ?? e.chapterId;
    if (id) d.chapters.add(id);
    d.workspace = true; // uuid-index changes
  },
  "chapter-renamed": (s, e, d) => {
    const c = e.chapterId && s.chapters.get(e.chapterId);
    const name = str(newValue(e).name);
    if (c && name !== undefined) { c.name = name; d.chapters.add(c.id); }
  },
  "chapter-edited": (s, e, d) => {
    const c = e.chapterId && s.chapters.get(e.chapterId);
    if (!c) return;
    const nv = newValue(e);
    const name = str(nv.name);
    const context = str(nv.context);
    if (name !== undefined) c.name = name;
    if (context !== undefined) c.context = context;
    d.chapters.add(c.id);
  },
  "chapter-removed": (s, e, d) => {
    if (!e.chapterId) return;
    for (const sl of [...s.slices.values()]) {
      if (sl.chapterId === e.chapterId) { removeSlice(s, sl.id); d.slices.add(sl.id); }
    }
    for (const ln of [...s.lanes.values()]) {
      if (ln.chapterId === e.chapterId) { removeLane(s, ln.id); d.lanes.add(ln.id); }
    }
    s.chapters.delete(e.chapterId);
    d.chapters.add(e.chapterId);
    d.workspace = true;
  },
  "chapters-reordered": (s, e, d) => {
    const ids = strArr(newValue(e).chapterIds);
    if (!ids) return;
    reindex(ids, (id) => s.chapters.get(id));
    for (const id of ids) d.chapters.add(id);
  },

  // ── Slice ──
  "slice-added": (s, e, d) => {
    if (e.chapterId) {
      putSliceFromRaw(s, e.chapterId, obj(newValue(e).slice));
      const id = str(obj(newValue(e).slice).id);
      if (id) { markSliceFiles(d, id, "*"); d.chapters.add(e.chapterId); }
      d.workspace = true;
    }
  },
  "slice-renamed": (s, e, d) => {
    const sl = e.sliceId && s.slices.get(e.sliceId);
    const label = str(newValue(e).label);
    if (sl && label !== undefined) { sl.label = label; markSliceFiles(d, sl.id, "slice.json"); }
  },
  "slices-reordered": (s, e, d) => {
    const ids = strArr(newValue(e).sliceIds);
    if (!ids) return;
    reindex(ids, (id) => s.slices.get(id));
    if (e.chapterId) {
      const c = s.chapters.get(e.chapterId);
      if (c) { c.sliceOrder = ids.filter((id) => s.slices.has(id)); d.chapters.add(e.chapterId); }
    }
    for (const id of ids) markSliceFiles(d, id, "slice.json");
  },
  "slice-removed": (s, e, d) => {
    if (e.sliceId) {
      const sl = s.slices.get(e.sliceId);
      if (sl) {
        d.dirsToDelete.add(`chapters/${sl.chapterId}/slices/${sl.id}`);
        d.chapters.add(sl.chapterId);
      }
      removeSlice(s, e.sliceId);
      markSliceFiles(d, e.sliceId, "*");
      d.workspace = true;
    }
  },
  "slice-details-changed": (s, e, d) => {
    const sl = e.sliceId && s.slices.get(e.sliceId);
    const details = str(newValue(e).details);
    if (sl && details !== undefined) { sl.details = details; markSliceFiles(d, sl.id, "details.md"); }
  },
  "slice-status-changed": (s, e, d) => {
    const sl = e.sliceId && s.slices.get(e.sliceId);
    const status = str(newValue(e).status);
    if (sl && status !== undefined) { sl.status = status; markSliceFiles(d, sl.id, "slice.json"); }
  },
  "slice-icon-changed": (s, e, d) => {
    const sl = e.sliceId && s.slices.get(e.sliceId);
    const icon = str(newValue(e).icon);
    if (sl && icon !== undefined) { sl.icon = icon; markSliceFiles(d, sl.id, "slice.json"); }
  },
  "slice-resized": (s, e, d) => {
    const sl = e.sliceId && s.slices.get(e.sliceId);
    const width = num(newValue(e).width);
    if (sl && width !== undefined) { sl.width = width; markSliceFiles(d, sl.id, "slice.json"); }
  },
  "slice-assignee-set": (s, e, d) => {
    const sl = e.sliceId && s.slices.get(e.sliceId);
    if (sl) { sl.assignee = str(newValue(e).assigneeId); markSliceFiles(d, sl.id, "slice.json"); }
  },
  "slice-estimate-set": (s, e, d) => {
    const sl = e.sliceId && s.slices.get(e.sliceId);
    if (!sl) return;
    sl.estimate = str(newValue(e).estimate);
    syncMilestoneSliceRef(s, sl);
    markSliceFiles(d, sl.id, "slice.json");
  },
  "slice-time-spent-set": (s, e, d) => {
    const sl = e.sliceId && s.slices.get(e.sliceId);
    if (!sl) return;
    sl.timeSpent = str(newValue(e).timeSpent);
    syncMilestoneSliceRef(s, sl);
    markSliceFiles(d, sl.id, "slice.json");
  },
  "slice-milestone-set": (s, e, d) => {
    const nv = newValue(e);
    const sliceId = str(nv.sliceId) ?? e.sliceId;
    const milestoneId = str(nv.milestoneId);
    const action = str(nv.action) ?? "add";
    if (!sliceId || !milestoneId) return;
    setSliceMilestone(s, sliceId, milestoneId, action === "remove" ? "remove" : "add");
    markSliceFiles(d, sliceId, "slice.json");
    d.milestones.add(milestoneId);
  },
  "new-slice-comment-written": (s, e, d) => {
    const sl = e.sliceId && s.slices.get(e.sliceId);
    const nv = newValue(e);
    // The board nests the comment under `newValue.comment` and may carry `isTask`
    // either inside the comment object or as a sibling on newValue — accept both.
    const rawComment = obj(nv.comment);
    const c = commentFromRaw(
      rawComment.isTask === undefined && rawComment.is_task === undefined && nv.isTask !== undefined
        ? { ...rawComment, isTask: nv.isTask }
        : rawComment,
    );
    if (sl && c) { sl.comments.push(c); markSliceFiles(d, sl.id, "comments"); }
  },
  "slice-comment-changed": (s, e, d) => {
    const sl = e.sliceId && s.slices.get(e.sliceId);
    if (!sl) return;
    const nv = newValue(e);
    const commentId = str(nv.commentId);
    const text = str(nv.text);
    const isTask = bool(nv.isTask) ?? bool(nv.is_task);
    const c = sl.comments.find((x) => x.id === commentId);
    if (c) {
      if (text !== undefined) c.text = text;
      if (isTask !== undefined) c.isTask = isTask;
      if (text !== undefined || isTask !== undefined) markSliceFiles(d, sl.id, "comments");
    }
  },
  "slice-comment-removed": (s, e, d) => {
    removeSliceComment(s, e, d);
  },
  "slice-comment-resolved": (s, e, d) => {
    removeSliceComment(s, e, d);
  },
  "slices-copied": (s, e, d) => {
    const target = str(e.data.targetChapterId) ?? e.chapterId ?? undefined;
    const slices = Array.isArray(newValue(e).slices) ? (newValue(e).slices as unknown[]) : [];
    if (target) {
      for (const raw of slices) {
        putSliceFromRaw(s, target, obj(raw));
        const id = str(obj(raw).id);
        if (id) markSliceFiles(d, id, "*");
      }
      d.chapters.add(target);
      d.workspace = true;
    }
  },
  "slices-moved": (s, e, d) => {
    const target = str(e.data.targetChapterId) ?? e.chapterId ?? undefined;
    const source = str(e.data.sourceChapterId);
    const nv = newValue(e);
    const slices = Array.isArray(nv.slices) ? (nv.slices as unknown[]) : [];
    if (!target) return;

    // Remove placeholder slices that were overridden (consumed) by this move.
    const overriddenSliceIds = strArr(nv.overriddenSliceIds) ?? [];
    const targetChapter = s.chapters.get(target);
    if (targetChapter && overriddenSliceIds.length > 0) {
      for (const overriddenId of overriddenSliceIds) {
        targetChapter.sliceOrder = targetChapter.sliceOrder.filter((x) => x !== overriddenId);
        s.slices.delete(overriddenId);
        markSliceFiles(d, overriddenId, "*");
      }
    }

    // Remove the moved slices from the source chapter order (they are being repositioned).
    for (const raw of slices) {
      const sliceRaw = obj(obj(raw).slice);
      const id = str(sliceRaw.id);
      if (id && source && source !== target) {
        const src = s.chapters.get(source);
        if (src) { src.sliceOrder = src.sliceOrder.filter((x) => x !== id); d.chapters.add(source); }
      }
      // Upsert the slice itself (updates index and label from newValue).
      putSliceFromRaw(s, target, sliceRaw);
      if (id) markSliceFiles(d, id, "slice.json");

      // Update the sliceId on all elements that belong to this moved slice.
      const elements = Array.isArray(obj(raw).elements) ? (obj(raw).elements as unknown[]) : [];
      for (const elRaw of elements) {
        const el = s.elements.get(str(obj(elRaw).id) ?? "");
        if (el) {
          const newSliceId = str(obj(raw).newSliceId) ?? str(sliceRaw.id);
          if (newSliceId) { el.sliceId = newSliceId; markElementFiles(d, el.id, "element.json"); }
        }
      }
    }

    // Re-apply the final slice order for the target chapter based on each slice's new index.
    if (targetChapter) {
      targetChapter.sliceOrder = [...targetChapter.sliceOrder].sort((a, b) => {
        const ia = s.slices.get(a)?.index ?? 0;
        const ib = s.slices.get(b)?.index ?? 0;
        return ia - ib;
      });
      d.chapters.add(target);
    }
  },

  // ── Lane ──
  "lane-added": (s, e, d) => {
    if (e.chapterId) {
      putLaneFromRaw(s, e.chapterId, obj(newValue(e).lane));
      const id = str(obj(newValue(e).lane).id);
      if (id) d.lanes.add(id);
      d.chapters.add(e.chapterId);
      d.workspace = true;
    }
  },
  "lane-renamed": (s, e, d) => {
    const lane = e.data.laneId ? s.lanes.get(str(e.data.laneId)!) : undefined;
    const label = str(newValue(e).label);
    if (!lane || label === undefined) return;
    d.sharedLaneDetails.add(laneKeyOf(lane)); // old key
    leaveShared(s.sharedLaneDetails, laneKeyOf(lane), lane.id);
    lane.label = label;
    joinShared(s.sharedLaneDetails, laneKeyOf(lane), lane.id, "");
    d.lanes.add(lane.id);
    d.sharedLaneDetails.add(laneKeyOf(lane)); // new key
  },
  "lanes-reordered": (s, e, d) => {
    const ids = strArr(newValue(e).laneIds);
    if (!ids) return;
    reindex(ids, (id) => s.lanes.get(id));
    if (e.chapterId) {
      const c = s.chapters.get(e.chapterId);
      if (c) { c.laneOrder = ids.filter((id) => s.lanes.has(id)); d.chapters.add(e.chapterId); }
    }
    for (const id of ids) d.lanes.add(id);
  },
  "lane-removed": (s, e, d) => {
    const laneId = str(e.data.laneId) ?? str(obj(oldValue(e).lane).id);
    if (laneId) {
      const lane = s.lanes.get(laneId);
      if (lane) {
        d.dirsToDelete.add(`chapters/${lane.chapterId}/lanes/${lane.id}`);
        d.sharedLaneDetails.add(laneKeyOf(lane));
        d.chapters.add(lane.chapterId);
      }
      removeLane(s, laneId);
      d.lanes.add(laneId);
      d.workspace = true;
    }
  },
  "lane-details-changed": (s, e, d) => {
    const lane = s.lanes.get(str(e.data.laneId) ?? "");
    const details = str(newValue(e).details);
    if (lane && details !== undefined) {
      setSharedBody(s.sharedLaneDetails, laneKeyOf(lane), details, () => {});
      d.sharedLaneDetails.add(laneKeyOf(lane));
    }
  },
  "lane-details-synchronized": (s, e, d) => {
    const lane = s.lanes.get(str(e.data.laneId) ?? "");
    const details = str(newValue(e).details);
    if (lane && details !== undefined) {
      setSharedBody(s.sharedLaneDetails, laneKeyOf(lane), details, () => {});
      d.sharedLaneDetails.add(laneKeyOf(lane));
    }
  },
  "lane-icon-changed": (s, e, d) => {
    const lane = s.lanes.get(str(e.data.laneId) ?? "");
    if (lane) { lane.icon = str(newValue(e).icon); d.lanes.add(lane.id); }
  },
  "lane-resized": (s, e, d) => {
    const lane = s.lanes.get(str(e.data.laneId) ?? "");
    const height = num(newValue(e).height);
    if (lane && height !== undefined) { lane.height = height; d.lanes.add(lane.id); }
  },

  // ── Element ──
  "element-added": (s, e, d) => {
    if (e.chapterId) {
      putElementFromRaw(s, e.chapterId, obj(newValue(e).element));
      const id = str(obj(newValue(e).element).id);
      if (id) markElementFiles(d, id, "*");
      d.workspace = true;
    }
  },
  "element-added-with-name": (s, e, d) => {
    if (e.chapterId) {
      putElementFromRaw(s, e.chapterId, obj(newValue(e).element));
      const id = str(obj(newValue(e).element).id);
      if (id) markElementFiles(d, id, "*");
      d.workspace = true;
    }
  },
  "element-copied": (s, e, d) => {
    if (e.chapterId) {
      putElementFromRaw(s, e.chapterId, obj(newValue(e).element));
      const id = str(obj(newValue(e).element).id);
      if (id) markElementFiles(d, id, "*");
      d.workspace = true;
    }
  },
  "element-moved": (s, e, d) => {
    const el = e.elementId && s.elements.get(e.elementId);
    if (!el) return;
    const nv = newValue(e);
    const laneId = str(nv.laneId);
    const sliceId = str(nv.sliceId);
    const index = num(nv.index);
    if (laneId !== undefined) el.laneId = laneId;
    if (sliceId !== undefined) el.sliceId = sliceId;
    if (index !== undefined) el.index = index;
    markElementFiles(d, el.id, "element.json");
  },
  "element-renamed": (s, e, d) => {
    const el = e.elementId && s.elements.get(e.elementId);
    const name = str(newValue(e).name);
    if (!el || name === undefined) return;
    el.name = name;
    markElementFiles(d, el.id, "element.json");
  },
  "element-description-changed": (s, e, d) => {
    const el = e.elementId && s.elements.get(e.elementId);
    const description = str(newValue(e).description);
    if (el && description !== undefined) { el.description = description; markElementFiles(d, el.id, "description.md"); }
  },
  "element-details-changed": (s, e, d) => {
    const el = e.elementId && s.elements.get(e.elementId);
    const details = str(newValue(e).details);
    if (el && details !== undefined) { el.details = details; markElementFiles(d, el.id, "details.md"); }
  },
  "element-details-synchronized": (s, e, d) => {
    const el = e.elementId && s.elements.get(e.elementId);
    const details = str(newValue(e).details);
    if (el && details !== undefined) { el.details = details; markElementFiles(d, el.id, "details.md"); }
  },
  "element-config-changed": (s, e, d) => {
    const el = e.elementId && s.elements.get(e.elementId);
    if (!el) return;
    const nv = newValue(e);
    const icon = str(nv.icon);
    const noArrowSource = bool(nv.noArrowSource);
    const noArrowTarget = bool(nv.noArrowTarget);
    if (icon !== undefined) el.icon = icon;
    if (noArrowSource !== undefined) el.noArrowSource = noArrowSource;
    if (noArrowTarget !== undefined) el.noArrowTarget = noArrowTarget;
    applyPlayConfig(el, nv);
    // element.json covers icon/arrows; play-function.ts and play-type.ts cover play config.
    markElementFiles(d, el.id, "element.json", "play-function.ts", "play-type.ts");
  },
  "element-config-synced": (s, e, d) => {
    const el = e.elementId && s.elements.get(e.elementId);
    if (!el) return;
    applyPlayConfig(el, newValue(e));
    markElementFiles(d, el.id, "play-function.ts", "play-type.ts");
  },
  "element-comment-added": (s, e, d) => {
    const el = e.elementId && s.elements.get(e.elementId);
    const c = commentFromRaw(newValue(e));
    if (el && c) { el.comments.push(c); markElementFiles(d, el.id, "comments"); }
  },
  "element-comment-updated": (s, e, d) => {
    const el = e.elementId && s.elements.get(e.elementId);
    if (!el) return;
    const commentId = str(e.data.commentId);
    const nv = newValue(e);
    const text = str(nv.text);
    const isTask = bool(nv.isTask) ?? bool(nv.is_task);
    const c = el.comments.find((x) => x.id === commentId);
    if (c) {
      if (text !== undefined) c.text = text;
      if (isTask !== undefined) c.isTask = isTask;
      if (text !== undefined || isTask !== undefined) markElementFiles(d, el.id, "comments");
    }
  },
  "element-comment-removed": (s, e, d) => {
    removeElementComment(s, e, d);
  },
  "element-comment-resolved": (s, e, d) => {
    removeElementComment(s, e, d);
  },
  "elements-reordered": (s, e, d) => {
    const ids = strArr(newValue(e).elementIds);
    if (ids) {
      reindex(ids, (id) => s.elements.get(id));
      for (const id of ids) markElementFiles(d, id, "element.json");
    }
  },
  "element-removed": (s, e, d) => {
    const el = e.elementId && s.elements.get(e.elementId);
    if (el) {
      d.dirsToDelete.add(`chapters/${el.chapterId}/elements/${el.id}`);
      removeElement(s, el);
      markElementFiles(d, el.id, "*");
      d.workspace = true;
    }
  },

  // ── Milestone ──
  "milestone-added": (s, e, d) => {
    putMilestoneFromRaw(s, obj(newValue(e).milestone));
    const id = str(obj(newValue(e).milestone).id);
    if (id) markMilestoneFiles(d, id, "*");
    d.workspace = true;
  },
  "milestone-settings-changed": (s, e, d) => {
    const id = str(e.data.milestoneId) ?? str(newValue(e).id);
    const m = id ? s.milestones.get(id) : undefined;
    if (!m) return;
    const nv = newValue(e);
    const name = str(nv.name);
    const description = str(nv.description);
    const deadline = str(nv.deadline);
    const color = str(nv.color);
    const isCompleted = bool(nv.is_completed);
    if (name !== undefined) m.name = name;
    if (description !== undefined) m.description = description;
    if (deadline !== undefined) m.deadline = deadline;
    if (color !== undefined) m.color = color;
    if (isCompleted !== undefined) m.isCompleted = isCompleted;
    // Mark only the files that actually changed.
    const structuralChanged = name !== undefined || deadline !== undefined || color !== undefined || isCompleted !== undefined;
    const descriptionChanged = description !== undefined;
    if (structuralChanged) markMilestoneFiles(d, m.id, "milestone.json");
    if (descriptionChanged) markMilestoneFiles(d, m.id, "description.md");
    if (!structuralChanged && !descriptionChanged) markMilestoneFiles(d, m.id, "milestone.json"); // fallback
  },
  "milestone-deleted": (s, e, d) => {
    const id = str(e.data.milestoneId) ?? str(obj(oldValue(e).milestone).id);
    if (!id) return;
    // Detach denormalized fields from any slice that referenced it.
    for (const sl of s.slices.values()) {
      if (sl.milestoneId === id) {
        sl.milestoneId = undefined;
        sl.milestoneName = undefined;
        markSliceFiles(d, sl.id, "slice.json");
      }
    }
    s.milestones.delete(id);
    markMilestoneFiles(d, id, "*");
    d.workspace = true;
  },

  // ── Scenario ──
  "scenario-created": (s, e, d) => {
    const chapterId = e.chapterId;
    if (!chapterId) return;
    putScenarioFromRaw(s, chapterId, obj(newValue(e).scenario));
    const id = str(obj(newValue(e).scenario).id);
    if (id) d.scenarios.add(id);
    d.workspace = true;
  },
  "scenario-renamed": (s, e, d) => {
    const scenarioId = str(e.data.scenarioId);
    const name = str(newValue(e).name);
    const sc = scenarioId ? s.scenarios.get(scenarioId) : undefined;
    if (sc && name !== undefined) { sc.name = name; d.scenarios.add(sc.id); }
  },
  "scenario-initial-state-changed": (s, e, d) => {
    const scenarioId = str(e.data.scenarioId);
    const sc = scenarioId ? s.scenarios.get(scenarioId) : undefined;
    if (!sc) return;
    const nv = newValue(e);
    const initialState = nv.initialState;
    const seededEvents = nv.seededEvents;
    if (initialState && typeof initialState === "object" && !Array.isArray(initialState)) {
      sc.initialState = initialState as Record<string, unknown>;
    }
    if (Array.isArray(seededEvents)) sc.seededEvents = seededEvents.map(toSeededEvent);
    d.scenarios.add(sc.id);
  },
  "scenario-clock-changed": (s, e, d) => {
    const scenarioId = str(e.data.scenarioId);
    const sc = scenarioId ? s.scenarios.get(scenarioId) : undefined;
    if (!sc) return;
    const clock = newValue(e).clock;
    sc.clock = clock === null ? undefined : str(clock);
    d.scenarios.add(sc.id);
  },
  "scenario-interaction-recorded": (s, e, d) => {
    const scenarioId = str(e.data.scenarioId);
    const sc = scenarioId ? s.scenarios.get(scenarioId) : undefined;
    if (!sc) return;
    const nv = newValue(e);
    if (Array.isArray(nv.interactions)) {
      sc.interactions = nv.interactions
        .map(toScenarioInteraction)
        .filter((i): i is ScenarioInteraction => i !== null);
    } else {
      const entry = obj(nv.entry);
      const uiElementId = str(entry.uiElementId);
      const storage = entry.storage && typeof entry.storage === "object" && !Array.isArray(entry.storage)
        ? (entry.storage as Record<string, unknown>)
        : undefined;
      if (uiElementId && storage !== undefined) {
        const existing = sc.interactions.findIndex((i) => i.uiElementId === uiElementId);
        if (existing >= 0) {
          sc.interactions[existing] = { uiElementId, storage };
        } else {
          sc.interactions.push({ uiElementId, storage });
        }
      }
    }
    d.scenarios.add(sc.id);
  },
  "scenario-deleted": (s, e, d) => {
    const scenarioId = str(e.data.scenarioId) ?? str(obj(obj(e.data.oldValue).scenario).id);
    if (scenarioId) {
      const sc = s.scenarios.get(scenarioId);
      if (sc) d.dirsToDelete.add(`chapters/${sc.chapterId}/scenarios/${sc.id}`);
      s.scenarios.delete(scenarioId);
      d.scenarios.add(scenarioId);
      d.workspace = true;
    }
  },
  "scenario-expectation-set": (s, e, d) => {
    const scenarioId = str(e.data.scenarioId);
    const sc = scenarioId ? s.scenarios.get(scenarioId) : undefined;
    if (!sc) return;
    const nv = newValue(e);
    if (Array.isArray(nv.expectations)) {
      sc.expectations = nv.expectations.map(toScenarioExpectation);
    } else {
      const raw = obj(nv.expectation);
      const exp = toScenarioExpectation(raw);
      if (!exp.id) return;
      const idx = sc.expectations.findIndex((x) => x.id === exp.id);
      if (idx >= 0) {
        sc.expectations[idx] = exp;
      } else {
        sc.expectations.push(exp);
      }
    }
    d.scenarios.add(sc.id);
  },
  "scenario-expectation-removed": (s, e, d) => {
    const scenarioId = str(e.data.scenarioId);
    const sc = scenarioId ? s.scenarios.get(scenarioId) : undefined;
    if (!sc) return;
    const nv = newValue(e);
    if (Array.isArray(nv.expectations)) {
      sc.expectations = nv.expectations.map(toScenarioExpectation);
    } else {
      const expectationId = str(nv.expectationId);
      if (expectationId) {
        sc.expectations = sc.expectations.filter((x) => x.id !== expectationId);
      }
    }
    d.scenarios.add(sc.id);
  },

  // ── HTML Snippet ──
  "html-snippet-added": (s, e, d) => {
    const raw = obj(newValue(e).snippet);
    const slug = str(raw.slug) ?? str(e.data.slug);
    if (!slug) return;
    s.htmlSnippets.set(slug, {
      slug,
      name: str(raw.name) ?? "",
      snippet: str(raw.snippet) ?? "",
      createdAt: str(raw.created_at) ?? str(raw.createdAt),
      updatedAt: str(raw.updated_at) ?? str(raw.updatedAt),
    } satisfies HtmlSnippetState);
    d.htmlSnippets.add(slug);
    d.workspace = true;
  },
  "html-snippet-updated": (s, e, d) => {
    const slug = str(e.data.slug);
    if (!slug) return;
    const existing = s.htmlSnippets.get(slug);
    if (!existing) return;
    const nv = newValue(e);
    const name = str(nv.name);
    const snippet = str(nv.snippet);
    if (name !== undefined) existing.name = name;
    if (snippet !== undefined) existing.snippet = snippet;
    d.htmlSnippets.add(slug);
  },
  "html-snippet-deleted": (s, e, d) => {
    const slug = str(e.data.slug) ?? str(obj(obj(oldValue(e).snippet)).slug);
    if (slug) {
      // html-snippets are flat files — sanitize slug the same way renderHtmlSnippet does.
      const safeSlug = slug.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "snippet";
      d.dirsToDelete.add(`html-snippets/${safeSlug}.html`);
      d.dirsToDelete.add(`html-snippets/${safeSlug}.json`);
      s.htmlSnippets.delete(slug);
      d.htmlSnippets.add(slug);
      d.workspace = true;
    }
  },
};

// ───────────────── milestone helpers ─────────────────

function putMilestoneFromRaw(state: ModelState, raw: Record<string, unknown>): void {
  const id = str(raw.id);
  if (!id) return;
  const existing = state.milestones.get(id);
  const slicesRaw = Array.isArray(raw.slices) ? (raw.slices as unknown[]) : undefined;
  const m: MilestoneState = {
    id,
    name: str(raw.name) ?? existing?.name ?? "",
    description: str(raw.description) ?? existing?.description ?? "",
    deadline: str(raw.deadline) ?? existing?.deadline,
    color: str(raw.color) ?? existing?.color,
    isCompleted: bool(raw.is_completed) ?? existing?.isCompleted,
    completedAt: str(raw.completed_at) ?? existing?.completedAt,
    createdAt: str(raw.created_at) ?? existing?.createdAt,
    updatedAt: str(raw.updated_at) ?? existing?.updatedAt,
    slices: slicesRaw ? slicesRaw.map(toMilestoneSliceRef) : existing?.slices ?? [],
  };
  state.milestones.set(id, m);
  // Reflect membership onto the referenced slices.
  for (const ref of m.slices) {
    const sl = state.slices.get(ref.sliceId);
    if (sl) {
      sl.milestoneId = m.id;
      sl.milestoneName = m.name;
      if (ref.estimate !== undefined) sl.estimate = ref.estimate;
      if (ref.timeSpent !== undefined) sl.timeSpent = ref.timeSpent;
    }
  }
}

function toMilestoneSliceRef(raw: unknown): MilestoneSliceRef {
  const r = obj(raw);
  return {
    sliceId: str(r.slice_id) ?? str(r.sliceId) ?? "",
    label: str(r.label),
    chapterId: str(r.chapter_id) ?? str(r.chapterId),
    chapterName: str(r.chapter_name) ?? str(r.chapterName),
    status: str(r.status) ?? undefined,
    estimate: str(r.estimate) ?? undefined,
    timeSpent: str(r.time_spent) ?? str(r.timeSpent) ?? undefined,
  };
}

/** Add/remove a slice↔milestone association, keeping both sides in sync. */
function setSliceMilestone(
  state: ModelState,
  sliceId: string,
  milestoneId: string,
  action: "add" | "remove",
): void {
  const slice = state.slices.get(sliceId);
  const milestone = state.milestones.get(milestoneId);
  if (action === "add") {
    if (slice) {
      slice.milestoneId = milestoneId;
      slice.milestoneName = milestone?.name;
    }
    if (milestone && !milestone.slices.some((r) => r.sliceId === sliceId)) {
      milestone.slices.push(buildSliceRef(state, sliceId));
    }
  } else {
    if (slice && slice.milestoneId === milestoneId) {
      slice.milestoneId = undefined;
      slice.milestoneName = undefined;
    }
    if (milestone) milestone.slices = milestone.slices.filter((r) => r.sliceId !== sliceId);
  }
}

/** Keep a milestone's cached slice ref in sync with denormalized slice fields. */
function syncMilestoneSliceRef(state: ModelState, slice: SliceState): void {
  if (!slice.milestoneId) return;
  const m = state.milestones.get(slice.milestoneId);
  if (!m) return;
  const ref = m.slices.find((r) => r.sliceId === slice.id);
  if (ref) {
    ref.estimate = slice.estimate;
    ref.timeSpent = slice.timeSpent;
    ref.status = slice.status;
  }
}

function buildSliceRef(state: ModelState, sliceId: string): MilestoneSliceRef {
  const sl = state.slices.get(sliceId);
  const chapter = sl ? state.chapters.get(sl.chapterId) : undefined;
  return {
    sliceId,
    label: sl?.label,
    chapterId: sl?.chapterId,
    chapterName: chapter?.name,
    status: sl?.status,
    estimate: sl?.estimate,
    timeSpent: sl?.timeSpent,
  };
}

// ───────────────── scenario helpers ─────────────────

function toSeededEvent(raw: unknown): SeededEvent {
  const r = obj(raw);
  return {
    name: str(r.name) ?? "",
    context: str(r.context) ?? "",
    payload: (r.payload && typeof r.payload === "object" && !Array.isArray(r.payload))
      ? (r.payload as Record<string, unknown>)
      : {},
    timestamp: str(r.timestamp),
  };
}

function toScenarioInteraction(raw: unknown): ScenarioInteraction | null {
  const r = obj(raw);
  const storage = (r.storage && typeof r.storage === "object" && !Array.isArray(r.storage))
    ? (r.storage as Record<string, unknown>)
    : {};
  // New format: keyed by uiElementId.
  if (typeof r.uiElementId === "string" && r.uiElementId) {
    return { uiElementId: r.uiElementId, storage };
  }
  // Legacy format: keyed by stepIndex — kept for migration of old persisted entries.
  if (typeof r.stepIndex === "number") {
    return { uiElementId: "", stepIndex: r.stepIndex, storage };
  }
  return null;
}

function toScenarioExpectation(raw: unknown): ScenarioExpectation {
  const r = obj(raw);
  const id = str(r.id) ?? str(r.expectation_id) ?? "";
  const sliceId = str(r.sliceId) ?? str(r.slice_id) ?? "";
  const kind = (str(r.kind) ?? "events") as ScenarioExpectation["kind"];
  const expected = (r.expected && typeof r.expected === "object" && !Array.isArray(r.expected))
    ? (r.expected as Record<string, unknown>)
    : {};
  return {
    id,
    sliceId,
    kind,
    elementId: str(r.elementId) ?? str(r.element_id),
    match: str(r.match) as ScenarioExpectation["match"] | undefined,
    expected,
  };
}

function putScenarioFromRaw(
  state: ModelState,
  chapterId: string,
  raw: Record<string, unknown>,
): void {
  const id = str(raw.id);
  if (!id) return;
  const existing = state.scenarios.get(id);
  const initialStateRaw = raw.initial_state ?? raw.initialState;
  const seededEventsRaw = raw.seeded_events ?? raw.seededEvents;
  const interactionsRaw = raw.interactions;
  const expectationsRaw = raw.expectations;
  const sc: ScenarioState = {
    id,
    chapterId,
    name: str(raw.name) ?? existing?.name ?? "",
    clock: raw.clock === null ? undefined : (str(raw.clock) ?? existing?.clock),
    initialState: (initialStateRaw && typeof initialStateRaw === "object" && !Array.isArray(initialStateRaw))
      ? (initialStateRaw as Record<string, unknown>)
      : existing?.initialState ?? {},
    seededEvents: Array.isArray(seededEventsRaw)
      ? seededEventsRaw.map(toSeededEvent)
      : existing?.seededEvents ?? [],
    interactions: Array.isArray(interactionsRaw)
      ? interactionsRaw.map(toScenarioInteraction).filter((i): i is ScenarioInteraction => i !== null)
      : existing?.interactions ?? [],
    expectations: Array.isArray(expectationsRaw)
      ? expectationsRaw.map(toScenarioExpectation)
      : existing?.expectations ?? [],
    createdAt: str(raw.created_at) ?? str(raw.createdAt) ?? existing?.createdAt,
    updatedAt: str(raw.updated_at) ?? str(raw.updatedAt) ?? existing?.updatedAt,
  };
  state.scenarios.set(id, sc);
}
