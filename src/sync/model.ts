/**
 * In-memory normalized model for the local projection.
 *
 * This is the authoritative state the reducer (`applyEvent`) mutates and the renderer
 * reads. It is a flat, id-keyed representation of the prooph board model — chapters,
 * slices, lanes, elements, milestones — plus the two "shared details" tables that mirror
 * prooph board's behavior where `details` are shared across similar elements/lanes.
 *
 * The model can always be rebuilt from scratch by replaying the changelog (or from a
 * fresh fetch), so it holds no information that isn't recoverable from the board.
 *
 * Field names mirror the prooph board API (`label` for slices/lanes, `name` for elements/
 * chapters) so values map 1:1 to API calls. See docs/local-sync.md.
 */

export type SliceStatus =
  | "planned"
  | "in-progress"
  | "blocked"
  | "ready"
  | "deployed"
  | "draft"
  | "reviewed";

export type LaneType = "user-lane" | "information-flow" | "system";

export type ElementType =
  | "ui"
  | "command"
  | "event"
  | "information"
  | "automation"
  | "hotspot";

export interface Comment {
  id: string;
  /** Raw comment text, may contain `<mention userId="…">` markup. */
  text: string;
  author?: string;
  userId?: string;
  createdAt?: string;
}

export interface ElementState {
  id: string;
  type: string;
  name: string;
  context: string;
  /** Per-placement description (shown on the sticky). */
  description: string;
  /** Per-placement copy of the shared details body (canonical lives in sharedElementDetails). */
  details: string;
  laneId: string;
  sliceId: string;
  chapterId: string;
  index: number;
  icon?: string;
  noArrowSource?: boolean;
  noArrowTarget?: boolean;
  comments: Comment[];
  /** TypeScript source for the Exploration Mode play function. */
  playFunction?: string;
  /** TypeScript type definition for the play function's input/output. */
  playType?: string;
}

export interface LaneState {
  id: string;
  label: string;
  type: string;
  chapterId: string;
  index: number;
  height?: number;
  icon?: string;
}

export interface SliceState {
  id: string;
  label: string;
  chapterId: string;
  index: number;
  status?: string;
  width?: number;
  icon?: string;
  /** Slice-level details markdown. */
  details: string;
  comments: Comment[];
  // Denormalized milestone↔slice association fields (authoritative list on the milestone).
  milestoneId?: string;
  milestoneName?: string;
  assignee?: string;
  estimate?: string;
  timeSpent?: string;
}

export interface ChapterState {
  id: string;
  name: string;
  context: string;
  index: number;
  mode: string;
  /** Ordered child ids (kept in sync with each child's `index`). */
  sliceOrder: string[];
  laneOrder: string[];
}

/** A single event injected before step 0 in a scenario. */
export interface SeededEvent {
  name: string;
  context: string;
  payload: Record<string, unknown>;
  timestamp?: string;
}

/** A recorded UI interaction for a specific UI element in a scenario. */
export interface ScenarioInteraction {
  /** Stable id of the UI element whose input was captured. */
  uiElementId: string;
  storage: Record<string, unknown>;
  /** @deprecated Kept only for migration of pre-uiElementId entries; do not write. */
  stepIndex?: number;
}

/** A pinned expectation on a scenario (Exploration Mode M5). */
export interface ScenarioExpectation {
  id: string;
  sliceId: string;
  kind: "events" | "information" | "rejection";
  elementId?: string;
  match?: "exact" | "subset";
  expected: Record<string, unknown>;
}

/** An Exploration Mode scenario attached to a chapter. */
export interface ScenarioState {
  id: string;
  chapterId: string;
  name: string;
  clock?: string;
  initialState: Record<string, unknown>;
  seededEvents: SeededEvent[];
  interactions: ScenarioInteraction[];
  expectations: ScenarioExpectation[];
  createdAt?: string;
  updatedAt?: string;
}

/** A workspace-wide reusable HTML snippet. */
export interface HtmlSnippetState {
  slug: string;
  name: string;
  snippet: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface MilestoneSliceRef {
  sliceId: string;
  label?: string;
  chapterId?: string;
  chapterName?: string;
  status?: string;
  estimate?: string;
  timeSpent?: string;
}

export interface MilestoneState {
  id: string;
  name: string;
  description: string;
  deadline?: string;
  color?: string;
  isCompleted?: boolean;
  completedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  /** Ordered list of assigned slices. */
  slices: MilestoneSliceRef[];
}

/**
 * Shared-details entry. prooph board shares the `details` field across all elements with
 * the same (context, type, name) — and lanes with the same (type, name). We store the
 * canonical body once, plus the set of member element/lane ids currently in the group,
 * so renames can split/merge groups and removals can GC the canonical file.
 */
export interface SharedDetailsEntry {
  key: string;
  body: string;
  members: Set<string>;
}

export interface ModelState {
  workspaceId: string;
  workspaceName: string;
  chapters: Map<string, ChapterState>;
  slices: Map<string, SliceState>;
  lanes: Map<string, LaneState>;
  elements: Map<string, ElementState>;
  milestones: Map<string, MilestoneState>;
  /** Exploration Mode scenarios, keyed by scenario id. */
  scenarios: Map<string, ScenarioState>;
  /** Workspace-wide HTML snippets, keyed by slug. */
  htmlSnippets: Map<string, HtmlSnippetState>;
  /** Shared element details keyed by `context\u0000type\u0000name`. */
  sharedElementDetails: Map<string, SharedDetailsEntry>;
  /** Shared lane details keyed by `type\u0000name`. */
  sharedLaneDetails: Map<string, SharedDetailsEntry>;
}

/** Create an empty model. */
export function emptyModel(workspaceId = "", workspaceName = ""): ModelState {
  return {
    workspaceId,
    workspaceName,
    chapters: new Map(),
    slices: new Map(),
    lanes: new Map(),
    elements: new Map(),
    milestones: new Map(),
    scenarios: new Map(),
    htmlSnippets: new Map(),
    sharedElementDetails: new Map(),
    sharedLaneDetails: new Map(),
  };
}

const SEP = "\u0000";

/** Key for the shared *element* details table: (context, type, name). */
export function elementDetailsKey(context: string, type: string, name: string): string {
  return `${context}${SEP}${type}${SEP}${name}`;
}

/** Key for the shared *lane* details table: (type, label/name). */
export function laneDetailsKey(type: string, name: string): string {
  return `${type}${SEP}${name}`;
}

/** Decompose an element-details key back into its parts. */
export function parseElementDetailsKey(
  key: string,
): { context: string; type: string; name: string } {
  const [context = "", type = "", name = ""] = key.split(SEP);
  return { context, type, name };
}

/** Decompose a lane-details key back into its parts. */
export function parseLaneDetailsKey(key: string): { type: string; name: string } {
  const [type = "", name = ""] = key.split(SEP);
  return { type, name };
}

/** Child slices of a chapter, in model order. */
export function slicesOfChapter(state: ModelState, chapterId: string): SliceState[] {
  const chapter = state.chapters.get(chapterId);
  if (!chapter) return [];
  return chapter.sliceOrder
    .map((id) => state.slices.get(id))
    .filter((s): s is SliceState => s !== undefined);
}

/** Child lanes of a chapter, in model order. */
export function lanesOfChapter(state: ModelState, chapterId: string): LaneState[] {
  const chapter = state.chapters.get(chapterId);
  if (!chapter) return [];
  return chapter.laneOrder
    .map((id) => state.lanes.get(id))
    .filter((l): l is LaneState => l !== undefined);
}

/** Elements in a specific lane×slice cell, in `index` order. */
export function elementsInCell(
  state: ModelState,
  laneId: string,
  sliceId: string,
): ElementState[] {
  const out: ElementState[] = [];
  for (const el of state.elements.values()) {
    if (el.laneId === laneId && el.sliceId === sliceId) out.push(el);
  }
  out.sort((a, b) => a.index - b.index);
  return out;
}
