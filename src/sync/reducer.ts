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
  elementDetailsKey,
  laneDetailsKey,
} from "./model.js";

/** Apply one event, mutating and returning `state`. Never throws on bad payloads. */
export function applyEvent(state: ModelState, event: ChangelogEvent): ModelState {
  try {
    const handler = HANDLERS[event.type];
    if (handler) handler(state, event);
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

function elementKeyOf(el: ElementState): string {
  return elementDetailsKey(el.context, el.type, el.name);
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
    comments: existing?.comments ?? [],
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
    comments: existing?.comments ?? [],
    playFunction: str(raw.playFunction) ?? existing?.playFunction,
    playType: str(raw.playType) ?? existing?.playType,
  };
  state.elements.set(id, el);
  joinShared(state.sharedElementDetails, elementKeyOf(el), id, details);
}

function commentFromRaw(raw: Record<string, unknown>): Comment | undefined {
  const id = str(raw.id);
  if (!id) return undefined;
  return {
    id,
    text: str(raw.text) ?? "",
    author: str(raw.author),
    userId: str(raw.userId),
    createdAt: str(raw.createdAt),
  };
}

function removeElement(state: ModelState, el: ElementState): void {
  leaveShared(state.sharedElementDetails, elementKeyOf(el), el.id);
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

type Handler = (state: ModelState, event: ChangelogEvent) => void;

const HANDLERS: Record<string, Handler> = {
  // ── Chapter ──
  "chapter-added": (s, e) => putChapterFromRaw(s, { ...newValue(e), context: e.context }),
  "chapter-renamed": (s, e) => {
    const c = e.chapterId && s.chapters.get(e.chapterId);
    const name = str(newValue(e).name);
    if (c && name !== undefined) c.name = name;
  },
  "chapter-edited": (s, e) => {
    const c = e.chapterId && s.chapters.get(e.chapterId);
    if (!c) return;
    const nv = newValue(e);
    const name = str(nv.name);
    const context = str(nv.context);
    if (name !== undefined) c.name = name;
    if (context !== undefined) c.context = context;
  },
  "chapter-removed": (s, e) => {
    if (!e.chapterId) return;
    for (const sl of [...s.slices.values()]) {
      if (sl.chapterId === e.chapterId) removeSlice(s, sl.id);
    }
    for (const ln of [...s.lanes.values()]) {
      if (ln.chapterId === e.chapterId) removeLane(s, ln.id);
    }
    s.chapters.delete(e.chapterId);
  },
  "chapters-reordered": (s, e) => {
    const ids = strArr(newValue(e).chapterIds);
    if (ids) reindex(ids, (id) => s.chapters.get(id));
  },

  // ── Slice ──
  "slice-added": (s, e) => {
    if (e.chapterId) putSliceFromRaw(s, e.chapterId, obj(newValue(e).slice));
  },
  "slice-renamed": (s, e) => {
    const sl = e.sliceId && s.slices.get(e.sliceId);
    const label = str(newValue(e).label);
    if (sl && label !== undefined) sl.label = label;
  },
  "slices-reordered": (s, e) => {
    const ids = strArr(newValue(e).sliceIds);
    if (!ids) return;
    reindex(ids, (id) => s.slices.get(id));
    if (e.chapterId) {
      const c = s.chapters.get(e.chapterId);
      if (c) c.sliceOrder = ids.filter((id) => s.slices.has(id));
    }
  },
  "slice-removed": (s, e) => {
    if (e.sliceId) removeSlice(s, e.sliceId);
  },
  "slice-details-changed": (s, e) => {
    const sl = e.sliceId && s.slices.get(e.sliceId);
    const details = str(newValue(e).details);
    if (sl && details !== undefined) sl.details = details;
  },
  "slice-status-changed": (s, e) => {
    const sl = e.sliceId && s.slices.get(e.sliceId);
    const status = str(newValue(e).status);
    if (sl && status !== undefined) sl.status = status;
  },
  "slice-icon-changed": (s, e) => {
    const sl = e.sliceId && s.slices.get(e.sliceId);
    const icon = str(newValue(e).icon);
    if (sl && icon !== undefined) sl.icon = icon;
  },
  "slice-resized": (s, e) => {
    const sl = e.sliceId && s.slices.get(e.sliceId);
    const width = num(newValue(e).width);
    if (sl && width !== undefined) sl.width = width;
  },
  "slice-assignee-set": (s, e) => {
    const sl = e.sliceId && s.slices.get(e.sliceId);
    if (sl) sl.assignee = str(newValue(e).assigneeId);
  },
  "slice-estimate-set": (s, e) => {
    const sl = e.sliceId && s.slices.get(e.sliceId);
    if (!sl) return;
    sl.estimate = str(newValue(e).estimate);
    syncMilestoneSliceRef(s, sl);
  },
  "slice-time-spent-set": (s, e) => {
    const sl = e.sliceId && s.slices.get(e.sliceId);
    if (!sl) return;
    sl.timeSpent = str(newValue(e).timeSpent);
    syncMilestoneSliceRef(s, sl);
  },
  "slice-milestone-set": (s, e) => {
    const nv = newValue(e);
    const sliceId = str(nv.sliceId) ?? e.sliceId;
    const milestoneId = str(nv.milestoneId);
    const action = str(nv.action) ?? "add";
    if (!sliceId || !milestoneId) return;
    setSliceMilestone(s, sliceId, milestoneId, action === "remove" ? "remove" : "add");
  },
  "new-slice-comment-written": (s, e) => {
    const sl = e.sliceId && s.slices.get(e.sliceId);
    const c = commentFromRaw(obj(newValue(e).comment));
    if (sl && c) sl.comments.push(c);
  },
  "slice-comment-changed": (s, e) => {
    const sl = e.sliceId && s.slices.get(e.sliceId);
    if (!sl) return;
    const nv = newValue(e);
    const commentId = str(nv.commentId);
    const text = str(nv.text);
    const c = sl.comments.find((x) => x.id === commentId);
    if (c && text !== undefined) c.text = text;
  },
  "slice-comment-removed": (s, e) => {
    const sl = e.sliceId && s.slices.get(e.sliceId);
    if (!sl) return;
    const commentId = str(newValue(e).commentId) ?? str(obj(oldValue(e).comment).id);
    if (commentId) sl.comments = sl.comments.filter((x) => x.id !== commentId);
  },
  "slices-copied": (s, e) => {
    const target = str(e.data.targetChapterId) ?? e.chapterId ?? undefined;
    const slices = Array.isArray(newValue(e).slices) ? (newValue(e).slices as unknown[]) : [];
    if (target) for (const raw of slices) putSliceFromRaw(s, target, obj(raw));
  },
  "slices-moved": (s, e) => {
    const target = str(e.data.targetChapterId) ?? e.chapterId ?? undefined;
    const source = str(e.data.sourceChapterId);
    const slices = Array.isArray(newValue(e).slices) ? (newValue(e).slices as unknown[]) : [];
    if (!target) return;
    for (const raw of slices) {
      const id = str(obj(raw).id);
      if (id && source) {
        const src = s.chapters.get(source);
        if (src) src.sliceOrder = src.sliceOrder.filter((x) => x !== id);
      }
      putSliceFromRaw(s, target, obj(raw));
    }
  },

  // ── Lane ──
  "lane-added": (s, e) => {
    if (e.chapterId) putLaneFromRaw(s, e.chapterId, obj(newValue(e).lane));
  },
  "lane-renamed": (s, e) => {
    const lane = e.data.laneId ? s.lanes.get(str(e.data.laneId)!) : undefined;
    const label = str(newValue(e).label);
    if (!lane || label === undefined) return;
    leaveShared(s.sharedLaneDetails, laneKeyOf(lane), lane.id);
    lane.label = label;
    joinShared(s.sharedLaneDetails, laneKeyOf(lane), lane.id, "");
  },
  "lanes-reordered": (s, e) => {
    const ids = strArr(newValue(e).laneIds);
    if (!ids) return;
    reindex(ids, (id) => s.lanes.get(id));
    if (e.chapterId) {
      const c = s.chapters.get(e.chapterId);
      if (c) c.laneOrder = ids.filter((id) => s.lanes.has(id));
    }
  },
  "lane-removed": (s, e) => {
    const laneId = str(e.data.laneId) ?? str(obj(oldValue(e).lane).id);
    if (laneId) removeLane(s, laneId);
  },
  "lane-details-changed": (s, e) => {
    const lane = s.lanes.get(str(e.data.laneId) ?? "");
    const details = str(newValue(e).details);
    if (lane && details !== undefined) {
      setSharedBody(s.sharedLaneDetails, laneKeyOf(lane), details, () => {});
    }
  },
  "lane-details-synchronized": (s, e) => {
    const lane = s.lanes.get(str(e.data.laneId) ?? "");
    const details = str(newValue(e).details);
    if (lane && details !== undefined) {
      setSharedBody(s.sharedLaneDetails, laneKeyOf(lane), details, () => {});
    }
  },
  "lane-icon-changed": (s, e) => {
    const lane = s.lanes.get(str(e.data.laneId) ?? "");
    if (lane) lane.icon = str(newValue(e).icon);
  },
  "lane-resized": (s, e) => {
    const lane = s.lanes.get(str(e.data.laneId) ?? "");
    const height = num(newValue(e).height);
    if (lane && height !== undefined) lane.height = height;
  },

  // ── Element ──
  "element-added": (s, e) => {
    if (e.chapterId) putElementFromRaw(s, e.chapterId, obj(newValue(e).element));
  },
  "element-added-with-name": (s, e) => {
    if (e.chapterId) putElementFromRaw(s, e.chapterId, obj(newValue(e).element));
  },
  "element-copied": (s, e) => {
    if (e.chapterId) putElementFromRaw(s, e.chapterId, obj(newValue(e).element));
  },
  "element-moved": (s, e) => {
    const el = e.elementId && s.elements.get(e.elementId);
    if (!el) return;
    const nv = newValue(e);
    const laneId = str(nv.laneId);
    const sliceId = str(nv.sliceId);
    const index = num(nv.index);
    if (laneId !== undefined) el.laneId = laneId;
    if (sliceId !== undefined) el.sliceId = sliceId;
    if (index !== undefined) el.index = index;
  },
  "element-renamed": (s, e) => {
    const el = e.elementId && s.elements.get(e.elementId);
    const name = str(newValue(e).name);
    if (!el || name === undefined) return;
    // Re-key shared details: leave the old group, join the new one.
    const details = el.details;
    leaveShared(s.sharedElementDetails, elementKeyOf(el), el.id);
    el.name = name;
    joinShared(s.sharedElementDetails, elementKeyOf(el), el.id, details);
    // Adopt the (possibly different) group body.
    const entry = s.sharedElementDetails.get(elementKeyOf(el));
    if (entry) el.details = entry.body;
  },
  "element-description-changed": (s, e) => {
    const el = e.elementId && s.elements.get(e.elementId);
    const description = str(newValue(e).description);
    if (el && description !== undefined) el.description = description;
  },
  "element-details-changed": (s, e) => {
    const el = e.elementId && s.elements.get(e.elementId);
    const details = str(newValue(e).details);
    if (el && details !== undefined) {
      setSharedBody(s.sharedElementDetails, elementKeyOf(el), details, (id) => {
        const member = s.elements.get(id);
        if (member) member.details = details;
      });
    }
  },
  "element-details-synchronized": (s, e) => {
    const el = e.elementId && s.elements.get(e.elementId);
    const details = str(newValue(e).details);
    if (el && details !== undefined) {
      setSharedBody(s.sharedElementDetails, elementKeyOf(el), details, (id) => {
        const member = s.elements.get(id);
        if (member) member.details = details;
      });
    }
  },
  "element-config-changed": (s, e) => {
    const el = e.elementId && s.elements.get(e.elementId);
    if (!el) return;
    const nv = newValue(e);
    const icon = str(nv.icon);
    const noArrowSource = bool(nv.noArrowSource);
    const noArrowTarget = bool(nv.noArrowTarget);
    const playFunction = str(nv.playFunction);
    const playType = str(nv.playType);
    if (icon !== undefined) el.icon = icon;
    if (noArrowSource !== undefined) el.noArrowSource = noArrowSource;
    if (noArrowTarget !== undefined) el.noArrowTarget = noArrowTarget;
    if (playFunction !== undefined) el.playFunction = playFunction;
    if (playType !== undefined) el.playType = playType;
  },
  "element-config-synced": (s, e) => {
    const el = e.elementId && s.elements.get(e.elementId);
    if (!el) return;
    const nv = newValue(e);
    const playFunction = str(nv.playFunction);
    const playType = str(nv.playType);
    if (playFunction !== undefined) el.playFunction = playFunction;
    if (playType !== undefined) el.playType = playType;
  },
  "element-comment-added": (s, e) => {
    const el = e.elementId && s.elements.get(e.elementId);
    const c = commentFromRaw(newValue(e));
    if (el && c) el.comments.push(c);
  },
  "element-comment-updated": (s, e) => {
    const el = e.elementId && s.elements.get(e.elementId);
    if (!el) return;
    const commentId = str(e.data.commentId);
    const text = str(newValue(e).text);
    const c = el.comments.find((x) => x.id === commentId);
    if (c && text !== undefined) c.text = text;
  },
  "element-comment-removed": (s, e) => {
    const el = e.elementId && s.elements.get(e.elementId);
    if (!el) return;
    const commentId = str(e.data.commentId) ?? str(obj(oldValue(e).comment).id);
    if (commentId) el.comments = el.comments.filter((x) => x.id !== commentId);
  },
  "elements-reordered": (s, e) => {
    const ids = strArr(newValue(e).elementIds);
    if (ids) reindex(ids, (id) => s.elements.get(id));
  },
  "element-removed": (s, e) => {
    const el = e.elementId && s.elements.get(e.elementId);
    if (el) removeElement(s, el);
  },

  // ── Milestone ──
  "milestone-added": (s, e) => putMilestoneFromRaw(s, obj(newValue(e).milestone)),
  "milestone-settings-changed": (s, e) => {
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
  },
  "milestone-deleted": (s, e) => {
    const id = str(e.data.milestoneId) ?? str(obj(oldValue(e).milestone).id);
    if (!id) return;
    // Detach denormalized fields from any slice that referenced it.
    for (const sl of s.slices.values()) {
      if (sl.milestoneId === id) {
        sl.milestoneId = undefined;
        sl.milestoneName = undefined;
      }
    }
    s.milestones.delete(id);
  },

  // ── Scenario ──
  "scenario-created": (s, e) => {
    const chapterId = e.chapterId;
    if (!chapterId) return;
    putScenarioFromRaw(s, chapterId, obj(newValue(e).scenario));
  },
  "scenario-renamed": (s, e) => {
    const scenarioId = str(e.data.scenarioId);
    const name = str(newValue(e).name);
    const sc = scenarioId ? s.scenarios.get(scenarioId) : undefined;
    if (sc && name !== undefined) sc.name = name;
  },
  "scenario-initial-state-changed": (s, e) => {
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
  },
  "scenario-clock-changed": (s, e) => {
    const scenarioId = str(e.data.scenarioId);
    const sc = scenarioId ? s.scenarios.get(scenarioId) : undefined;
    if (!sc) return;
    // clock may be null to clear, or a string ISO datetime
    const clock = newValue(e).clock;
    sc.clock = clock === null ? undefined : str(clock);
  },
  "scenario-interaction-recorded": (s, e) => {
    const scenarioId = str(e.data.scenarioId);
    const sc = scenarioId ? s.scenarios.get(scenarioId) : undefined;
    if (!sc) return;
    const nv = newValue(e);
    // The event carries the full updated interactions array (authoritative)
    if (Array.isArray(nv.interactions)) {
      sc.interactions = nv.interactions.map(toScenarioInteraction);
    } else {
      // Fallback: upsert the single entry from nv.entry
      const entry = obj(nv.entry);
      const stepIndex = typeof entry.stepIndex === "number" ? entry.stepIndex : undefined;
      const storage = entry.storage && typeof entry.storage === "object" && !Array.isArray(entry.storage)
        ? (entry.storage as Record<string, unknown>)
        : undefined;
      if (stepIndex !== undefined && storage !== undefined) {
        const existing = sc.interactions.findIndex((i) => i.stepIndex === stepIndex);
        if (existing >= 0) {
          sc.interactions[existing] = { stepIndex, storage };
        } else {
          sc.interactions.push({ stepIndex, storage });
          sc.interactions.sort((a, b) => a.stepIndex - b.stepIndex);
        }
      }
    }
  },
  "scenario-deleted": (s, e) => {
    const scenarioId = str(e.data.scenarioId) ?? str(obj(obj(e.data.oldValue).scenario).id);
    if (scenarioId) s.scenarios.delete(scenarioId);
  },
  "scenario-expectation-set": (s, e) => {
    const scenarioId = str(e.data.scenarioId);
    const sc = scenarioId ? s.scenarios.get(scenarioId) : undefined;
    if (!sc) return;
    const nv = newValue(e);
    // nv.expectations is the full updated array (authoritative)
    if (Array.isArray(nv.expectations)) {
      sc.expectations = nv.expectations.map(toScenarioExpectation);
    } else {
      // Fallback: upsert the single expectation from nv.expectation
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
  },
  "scenario-expectation-removed": (s, e) => {
    const scenarioId = str(e.data.scenarioId);
    const sc = scenarioId ? s.scenarios.get(scenarioId) : undefined;
    if (!sc) return;
    const nv = newValue(e);
    // nv.expectations is the full updated array (authoritative)
    if (Array.isArray(nv.expectations)) {
      sc.expectations = nv.expectations.map(toScenarioExpectation);
    } else {
      // Fallback: remove by expectationId
      const expectationId = str(nv.expectationId);
      if (expectationId) {
        sc.expectations = sc.expectations.filter((x) => x.id !== expectationId);
      }
    }
  },

  // ── HTML Snippet ──
  "html-snippet-added": (s, e) => {
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
  },
  "html-snippet-updated": (s, e) => {
    const slug = str(e.data.slug);
    if (!slug) return;
    const existing = s.htmlSnippets.get(slug);
    if (!existing) return;
    const nv = newValue(e);
    const name = str(nv.name);
    const snippet = str(nv.snippet);
    if (name !== undefined) existing.name = name;
    if (snippet !== undefined) existing.snippet = snippet;
  },
  "html-snippet-deleted": (s, e) => {
    const slug = str(e.data.slug) ?? str(obj(obj(oldValue(e).snippet)).slug);
    if (slug) s.htmlSnippets.delete(slug);
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

function toScenarioInteraction(raw: unknown): ScenarioInteraction {
  const r = obj(raw);
  const stepIndex = typeof r.stepIndex === "number" ? r.stepIndex : 0;
  const storage = (r.storage && typeof r.storage === "object" && !Array.isArray(r.storage))
    ? (r.storage as Record<string, unknown>)
    : {};
  return { stepIndex, storage };
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
      ? interactionsRaw.map(toScenarioInteraction)
      : existing?.interactions ?? [],
    expectations: Array.isArray(expectationsRaw)
      ? expectationsRaw.map(toScenarioExpectation)
      : existing?.expectations ?? [],
    createdAt: str(raw.created_at) ?? str(raw.createdAt) ?? existing?.createdAt,
    updatedAt: str(raw.updated_at) ?? str(raw.updatedAt) ?? existing?.updatedAt,
  };
  state.scenarios.set(id, sc);
}
