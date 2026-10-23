/**
 * Operation builder for the sync-back command.
 *
 * Takes a list of {@link FileChange}s (from the git diff reader) and the local sync
 * root directory, reads the relevant `.json` files and markdown files from disk, and
 * produces an ordered list of {@link SyncBackOperation}s that the executor will call
 * against the prooph board REST API.
 *
 * The builder is a pure transformation: given file changes + disk reads → operations.
 * No API calls are made here.
 *
 * ## Processing order (within a single batch of changes)
 *
 * To correctly handle a commit that contains both creates and content updates in the
 * same entity, operations are emitted in this priority order:
 *
 *   1. Chapter creates
 *   2. Lane creates
 *   3. Slice creates
 *   4. Element deletes (vacate cells — see note below)
 *   5. Element moves (vacate the source cell; may target a lane/slice created above)
 *   6. Element creates (occupy cells — must run after vacating ops)
 *   7. Content updates (description, details, play-function, play-type, slice details,
 *      lane details/rename/resize, chapter rename/context, milestone updates)
 *   8. Structural deletes (reverse dependency order: slices → lanes → chapters → milestones)
 *
 * Cell-occupancy note: the API rejects an element.create (and an element.move)
 * into a lane/slice cell that is still occupied (400). Operations that vacate a
 * cell — element.delete first, then element.move — therefore run before any
 * element.create, but after lane/slice creates because a move may target a cell
 * in a lane/slice created in the same run (resolved via the create's localId).
 *
 * ## UUID resolution
 *
 * Entity IDs are NOT in paths. They are read from the `.json` file in the entity
 * directory. The `uuid-index.json` file at the root is used for reverse-lookup when
 * we need the chapter ID from a slice path (we walk up to the chapter dir and look
 * up its JSON).
 *
 * For newly created entities (the `.json` doesn't exist yet on disk at the committed
 * state — we read from the working tree), we use the content of the committed `.json`
 * if it exists; the ID in element.json for new elements will be empty/missing, which
 * is fine since we POST to create and get the ID back from the API.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { EntityDiff } from "./manifestDiff.js";
import type { EntityKind } from "./pathParser.js";
import { hashContent } from "./manifest.js";

// ─── Operation types ─────────────────────────────────────────────────────────

export type OperationKind =
  // Chapter
  | "chapter.create"
  | "chapter.rename"
  | "chapter.update-context"
  | "chapter.delete"
  // Lane
  | "lane.create"
  | "lane.rename"
  | "lane.update-details"
  | "lane.resize"
  | "lane.delete"
  // Slice
  | "slice.create"
  | "slice.rename"
  | "slice.update-details"
  | "slice.update-status"
  | "slice.reorder"
  | "slice.delete"
  // Element
  | "element.create"
  | "element.rename"
  | "element.update-description"
  | "element.update-details"
  | "element.update-config"
  | "element.move"
  | "element.delete"
  // Milestone
  | "milestone.create"
  | "milestone.update"
  | "milestone.delete"
  // HTML Snippet
  | "html-snippet.create"
  | "html-snippet.update"
  | "html-snippet.delete"
  // Scenario expectations
  | "scenario.set-expectation"
  | "scenario.remove-expectation"
  // Scenario CRUD + interactions
  | "scenario.create"
  | "scenario.delete"
  | "scenario.update"
  | "scenario.record-interaction"
  | "scenario.clear-interactions";

export interface ChapterJson {
  id?: string;
  name?: string;
  context?: string;
  mode?: string;
  index?: number;
  sliceOrder?: string[];
  laneOrder?: string[];
}

export interface SliceJson {
  id?: string;
  label?: string;
  index?: number;
  status?: string;
  width?: number;
}

export interface LaneJson {
  id?: string;
  label?: string;
  type?: string;
  index?: number;
  height?: number;
}

export interface ElementJson {
  id?: string;
  type?: string;
  name?: string;
  context?: string;
  laneId?: string;
  sliceId?: string;
  index?: number;
}

export interface MilestoneJson {
  id?: string;
  name?: string;
  description?: string;
  deadline?: string;
  color?: string;
}

export interface HtmlSnippetJson {
  slug?: string;
  name?: string;
}

export interface ScenarioExpectationData {
  id: string;
  sliceId: string;
  kind: string;
  elementId?: string;
  match?: string;
  expected: Record<string, unknown>;
}

export interface ScenarioSeededEvent {
  name: string;
  context: string;
  payload: Record<string, unknown>;
  timestamp?: string;
}

export interface ScenarioJson {
  id?: string;
  chapterId?: string;
  name?: string;
  clock?: string | null;
  initialState?: Record<string, unknown>;
  seededEvents?: ScenarioSeededEvent[];
  interactions?: Array<{ uiElementId: string; storage: Record<string, unknown> }>;
  expectations?: ScenarioExpectationData[];
}

export type SyncBackOperation =
  | { kind: "chapter.create"; name: string; context?: string; mode?: string; skipDefaultContent?: boolean; entityDir: string; localId?: string }
  | { kind: "chapter.rename"; chapterId: string; newName: string; entityDir: string }
  | { kind: "chapter.update-context"; chapterId: string; newContext: string; entityDir: string }
  | { kind: "chapter.delete"; chapterId: string; entityDir: string }
  | { kind: "lane.create"; chapterId: string; label: string; type: string; index: number; height?: number; entityDir: string; localId?: string }
  | { kind: "lane.rename"; chapterId: string; laneId: string; newLabel: string; entityDir: string }
  | { kind: "lane.update-details"; chapterId: string; laneId: string; newDetails: string; entityDir: string }
  | { kind: "lane.resize"; chapterId: string; laneId: string; newHeight: number; entityDir: string }
  | { kind: "lane.delete"; chapterId: string; laneId: string; entityDir: string }
  | { kind: "slice.create"; chapterId: string; label: string; index?: number; status?: string; details?: string; width?: number; entityDir: string; localId?: string }
  | { kind: "slice.rename"; chapterId: string; sliceId: string; newLabel: string; entityDir: string }
  | { kind: "slice.update-details"; chapterId: string; sliceId: string; newDetails: string; entityDir: string }
  | { kind: "slice.update-status"; chapterId: string; sliceId: string; newStatus: string; entityDir: string }
  | { kind: "slice.reorder"; chapterId: string; newSliceIds: string[]; entityDir: string }
  | { kind: "slice.delete"; chapterId: string; sliceId: string; entityDir: string }
  | { kind: "element.create"; chapterId: string; name: string; type: string; laneId: string; sliceId: string; description?: string; details?: string; index?: number; context?: string; entityDir: string; localId?: string }
  | { kind: "element.rename"; chapterId: string; elementId: string; newName: string; entityDir: string }
  | { kind: "element.update-description"; chapterId: string; elementId: string; newDescription: string; entityDir: string }
  | { kind: "element.update-details"; chapterId: string; elementId: string; newDetails: string; entityDir: string }
  | { kind: "element.update-config"; chapterId: string; elementId: string; playFunction?: string; playType?: string; entityDir: string }
  | { kind: "element.move"; chapterId: string; elementId: string; newLaneId: string; newSliceId: string; newIndex: number; elementType?: string; entityDir: string }
  | { kind: "element.delete"; chapterId: string; elementId: string; entityDir: string }
  | { kind: "milestone.create"; name: string; description?: string; deadline?: string; color?: string; entityDir: string }
  | { kind: "milestone.update"; milestoneId: string; name?: string; description?: string; deadline?: string; color?: string; entityDir: string }
  | { kind: "milestone.delete"; milestoneId: string; entityDir: string }
  | { kind: "html-snippet.create"; name: string; snippet: string; slug?: string; entityDir: string }
  | { kind: "html-snippet.update"; slug: string; name?: string; snippet?: string; entityDir: string }
  | { kind: "html-snippet.delete"; slug: string; entityDir: string }
  | { kind: "scenario.set-expectation"; chapterId: string; scenarioId: string; expectation: ScenarioExpectationData; entityDir: string }
  | { kind: "scenario.remove-expectation"; chapterId: string; scenarioId: string; expectationId: string; entityDir: string }
  | { kind: "scenario.create"; chapterId: string; name: string; clock?: string; initialState?: Record<string, unknown>; seededEvents?: ScenarioSeededEvent[]; entityDir: string }
  | { kind: "scenario.delete"; chapterId: string; scenarioId: string; entityDir: string }
  | { kind: "scenario.update"; chapterId: string; scenarioId: string; name?: string; clock?: string | null; initialState?: Record<string, unknown>; seededEvents?: ScenarioSeededEvent[]; entityDir: string }
  | { kind: "scenario.record-interaction"; chapterId: string; scenarioId: string; uiElementId: string; storage: Record<string, unknown>; entityDir: string }
  | { kind: "scenario.clear-interactions"; chapterId: string; scenarioId: string; entityDir: string };

// ─── Sentinel for newly-created scenario IDs ─────────────────────────────────

/**
 * Placeholder scenarioId used in interaction/expectation operations that are emitted
 * alongside a `scenario.create` in the same sync-back run. The executor substitutes
 * the real ID returned by the POST before executing those follow-up operations.
 */
export const PENDING_SCENARIO_ID = "__pending_scenario_id__";

/**
 * Placeholder elementId used in element.update-config operations emitted alongside
 * an element.create in the same sync-back run when element.json carries no id.
 * The executor substitutes the real id returned by the create call before
 * executing the follow-up op — same mechanism as {@link PENDING_SCENARIO_ID}.
 */
export const PENDING_ELEMENT_ID = "__pending_element_id__";

// ─── Priority buckets ─────────────────────────────────────────────────────────

const PRIORITY: Record<OperationKind, number> = {
  "chapter.create": 0,
  "lane.create": 1,
  "slice.create": 2,
  // Vacate cells before occupying them: element.delete frees a cell (a move's
  // target cell may be freed by a delete), element.move frees its source cell.
  // Both run after slice/lane creates — a move may target a just-created cell.
  "element.delete": 3,
  "element.move": 4,
  "element.create": 5,
  // scenario.create must run before its follow-up interaction/expectation ops (priority 6)
  "scenario.create": 5,
  "chapter.rename": 6,
  "chapter.update-context": 6,
  "lane.rename": 6,
  "lane.update-details": 6,
  "lane.resize": 6,
  "slice.rename": 6,
  "slice.update-details": 6,
  "slice.update-status": 6,
  "slice.reorder": 6,
  "element.rename": 6,
  "element.update-description": 6,
  "element.update-details": 6,
  "element.update-config": 6,
  "milestone.create": 6,
  "milestone.update": 6,
  "slice.delete": 7,
  "lane.delete": 8,
  "chapter.delete": 9,
  "milestone.delete": 9,
  "html-snippet.create": 6,
  "html-snippet.update": 6,
  "html-snippet.delete": 9,
  "scenario.set-expectation": 6,
  "scenario.remove-expectation": 6,
  "scenario.delete": 9,
  "scenario.update": 6,
  "scenario.record-interaction": 6,
  "scenario.clear-interactions": 6,
};

// ─── Public API ──────────────────────────────────────────────────────────────

export interface BuildOperationsOptions {
  /** Absolute path to the sync root directory (e.g. `/project/.spec-stream/model`). */
  syncRootAbs: string;
  /** Entity diffs from the manifest diff (replaces the old FileChange[] from git). */
  diffs: EntityDiff[];
}

/**
 * Build the ordered list of API operations from a set of entity diffs.
 *
 * Reads entity `.json` and content files from disk (the current state on disk).
 * Returns operations sorted by priority.
 */
export async function buildOperations(opts: BuildOperationsOptions): Promise<SyncBackOperation[]> {
  const { syncRootAbs, diffs } = opts;
  const ops: SyncBackOperation[] = [];

  const seen = new Set<string>();

  for (const diff of diffs) {
    await processDiff(syncRootAbs, diff, ops, seen);
  }

  // Sort by priority. Within the same op kind, creates are ordered by their
  // `index`: the API treats `index` on create endpoints as an insertion
  // position (clamped to the end of the list), so creating entities in any
  // other order produces a wrong order on the board.
  ops.sort((a, b) => {
    const p = PRIORITY[a.kind] - PRIORITY[b.kind];
    if (p !== 0 || a.kind !== b.kind) return p;
    const ia = "index" in a ? (a.index ?? 0) : 0;
    const ib = "index" in b ? (b.index ?? 0) : 0;
    return ia - ib;
  });
  return ops;
}

// ─── Internal ─────────────────────────────────────────────────────────────────

async function processDiff(
  root: string,
  diff: EntityDiff,
  ops: SyncBackOperation[],
  seen: Set<string>,
): Promise<void> {
  switch (diff.status) {
    case "create":
      handleCreate(root, diff.entityDir, diff.kind, ops, seen);
      break;
    case "delete":
      handleDelete(root, diff, ops, seen);
      break;
    case "update":
      await handleUpdate(root, diff, ops, seen);
      break;
  }
}

function handleDelete(
  root: string,
  diff: EntityDiff,
  ops: SyncBackOperation[],
  seen: Set<string>,
): void {
  const { entityDir, kind, id } = diff;
  if (!id) return; // no id means we never successfully created it — nothing to delete

  const key = `delete:${entityDir}`;
  if (seen.has(key)) return;
  seen.add(key);

  switch (kind) {
    case "chapter":
      ops.push({ kind: "chapter.delete", chapterId: id, entityDir });
      break;
    case "slice": {
      const chapterId = resolveChapterId(root, entityDir);
      if (chapterId) ops.push({ kind: "slice.delete", chapterId, sliceId: id, entityDir });
      break;
    }
    case "lane": {
      const chapterId = resolveChapterId(root, entityDir);
      if (chapterId) ops.push({ kind: "lane.delete", chapterId, laneId: id, entityDir });
      break;
    }
    case "element": {
      const chapterId = resolveChapterId(root, entityDir);
      if (chapterId) ops.push({ kind: "element.delete", chapterId, elementId: id, entityDir });
      break;
    }
    case "milestone":
      ops.push({ kind: "milestone.delete", milestoneId: id, entityDir });
      break;
    case "html-snippet": {
      const slug = extractSlugFromEntityDir(entityDir);
      if (slug) ops.push({ kind: "html-snippet.delete", slug, entityDir });
      break;
    }
    case "scenario": {
      // scenario.json carries chapterId — read it from the manifest entry's entityDir
      // since the file is gone from disk. We stored chapterId in scenario.json at sync
      // time, but can also derive it from the entityDir path:
      // chapters/[Context]/[Chapter]/scenarios/[Scenario]
      const chapterId = resolveChapterId(root, entityDir);
      if (chapterId) ops.push({ kind: "scenario.delete", chapterId, scenarioId: id, entityDir });
      break;
    }
  }
}

async function handleUpdate(
  root: string,
  diff: EntityDiff,
  ops: SyncBackOperation[],
  seen: Set<string>,
): Promise<void> {
  const { entityDir, kind, id } = diff;

  const key = `update:${entityDir}`;
  if (seen.has(key)) return;
  seen.add(key);

  // oldFields is a snapshot of the primary json fields at the time the manifest was
  // last written. We use it to skip ops for fields that haven't changed.
  const old = diff.oldFields ?? {};
  // Helper: returns true if field value has changed (or old value is unknown)
  const changed = (field: string, current: unknown): boolean =>
    !(field in old) || old[field] !== current;

  switch (kind) {
    case "chapter": {
      const data = readJsonFile(root, `${entityDir}/chapter.json`) as ChapterJson | null;
      const entityId = data?.id ?? id;
      if (!entityId) return;
      if (data?.name !== undefined && changed("name", data.name))
        ops.push({ kind: "chapter.rename", chapterId: entityId, newName: data.name, entityDir });
      if (data?.context !== undefined && changed("context", data.context))
        ops.push({ kind: "chapter.update-context", chapterId: entityId, newContext: data.context, entityDir });
      // Slice reorder: emit when sliceOrder array changed.
      if (Array.isArray(data?.sliceOrder)) {
        const oldOrder = Array.isArray(old["sliceOrder"]) ? (old["sliceOrder"] as string[]) : undefined;
        const newOrder = data.sliceOrder as string[];
        const orderChanged = !oldOrder || JSON.stringify(oldOrder) !== JSON.stringify(newOrder);
        if (orderChanged && newOrder.length > 0)
          ops.push({ kind: "slice.reorder", chapterId: entityId, newSliceIds: newOrder, entityDir });
      }
      break;
    }
    case "slice": {
      const data = readJsonFile(root, `${entityDir}/slice.json`) as SliceJson | null;
      const entityId = data?.id ?? id;
      const chapterId = resolveChapterId(root, entityDir);
      if (!entityId || !chapterId) return;
      if (data?.label !== undefined && changed("label", data.label))
        ops.push({ kind: "slice.rename", chapterId, sliceId: entityId, newLabel: data.label, entityDir });
      if (data?.status !== undefined && changed("status", data.status))
        ops.push({ kind: "slice.update-status", chapterId, sliceId: entityId, newStatus: data.status, entityDir });
      // Slice details — only emit if details.md actually changed.
      const detailsContent = readMarkdownIfExists(root, `${entityDir}/details.md`);
      const oldSliceCH = diff.oldContentHashes ?? {};
      if (detailsContent !== null) {
        const oldH = oldSliceCH["details.md"];
        if (!oldH || hashContent(detailsContent) !== oldH)
          ops.push({ kind: "slice.update-details", chapterId, sliceId: entityId, newDetails: detailsContent, entityDir });
      }
      break;
    }
    case "lane": {
      const data = readJsonFile(root, `${entityDir}/lane.json`) as LaneJson | null;
      const entityId = data?.id ?? id;
      const chapterId = resolveChapterId(root, entityDir);
      if (!entityId || !chapterId) return;
      if (data?.label !== undefined && changed("label", data.label))
        ops.push({ kind: "lane.rename", chapterId, laneId: entityId, newLabel: data.label, entityDir });
      if (data?.height !== undefined && changed("height", data.height))
        ops.push({ kind: "lane.resize", chapterId, laneId: entityId, newHeight: data.height, entityDir });
      break;
    }
    case "element": {
      const data = readJsonFile(root, `${entityDir}/element.json`) as ElementJson | null;
      const entityId = data?.id ?? id;
      const chapterId = resolveChapterId(root, entityDir);
      if (!entityId || !chapterId) return;
      if (data?.name !== undefined && changed("name", data.name))
        ops.push({ kind: "element.rename", chapterId, elementId: entityId, newName: data.name, entityDir });
      if (data?.laneId && data?.sliceId && (changed("laneId", data.laneId) || changed("sliceId", data.sliceId) || changed("index", data.index ?? 0)))
        ops.push({ kind: "element.move", chapterId, elementId: entityId, newLaneId: data.laneId, newSliceId: data.sliceId, newIndex: data.index ?? 0, elementType: data.type, entityDir });

      // Content files — only emit if the specific file changed.
      const oldCH = diff.oldContentHashes ?? {};
      const contentChanged = (file: string, content: string | null): boolean => {
        if (content === null) return false; // file doesn't exist
        const oldH = oldCH[file];
        if (!oldH) return true; // no prior hash → assume changed
        return hashContent(content) !== oldH;
      };

      const desc = readMarkdownIfExists(root, `${entityDir}/description.md`);
      if (contentChanged("description.md", desc))
        ops.push({ kind: "element.update-description", chapterId, elementId: entityId, newDescription: desc!, entityDir });
      const details = readMarkdownIfExists(root, `${entityDir}/details.md`);
      if (contentChanged("details.md", details))
        ops.push({ kind: "element.update-details", chapterId, elementId: entityId, newDetails: details!, entityDir });
      const pf = readFileIfExists(root, `${entityDir}/play-function.ts`);
      const ptRaw = readFileIfExists(root, `${entityDir}/play-type.ts`);
      const pt = ptRaw ? stripPlayTypeWrapper(ptRaw) : null;
      if (contentChanged("play-function.ts", pf) || contentChanged("play-type.ts", ptRaw))
        ops.push({ kind: "element.update-config", chapterId, elementId: entityId, playFunction: pf ?? undefined, playType: pt ?? undefined, entityDir });
      break;
    }
    case "milestone": {
      const data = readJsonFile(root, `${entityDir}/milestone.json`) as MilestoneJson | null;
      const entityId = data?.id ?? id;
      if (!entityId) return;
      const desc = readMarkdownIfExists(root, `${entityDir}/description.md`);
      // Only emit update if any field changed
      const nameChanged     = data?.name     !== undefined && changed("name",     data.name);
      const deadlineChanged = data?.deadline !== undefined && changed("deadline", data.deadline);
      const colorChanged    = data?.color    !== undefined && changed("color",    data.color);
      const descChanged     = desc !== null; // description is a file — covered by hash
      if (nameChanged || deadlineChanged || colorChanged || descChanged)
        ops.push({ kind: "milestone.update", milestoneId: entityId, name: data?.name, description: desc ?? data?.description, deadline: data?.deadline, color: data?.color, entityDir });
      break;
    }
    case "html-snippet": {
      const jsonData = readJsonFile(root, `${entityDir}.json`) as HtmlSnippetJson | null;
      const slug = jsonData?.slug ?? extractSlugFromEntityDir(entityDir);
      if (!slug) return;
      const htmlContent = readFileIfExists(root, `${entityDir}.html`);
      const nameChanged = jsonData?.name !== undefined && changed("name", jsonData.name);
      if (nameChanged || htmlContent !== null)
        ops.push({
          kind: "html-snippet.update",
          slug,
          ...(nameChanged && { name: jsonData!.name }),
          ...(htmlContent !== null && { snippet: htmlContent }),
          entityDir,
        });
      break;
    }
    case "scenario": {
      const newData = readJsonFile(root, `${entityDir}/scenario.json`) as ScenarioJson | null;
      if (!newData?.id || !newData?.chapterId) return;

      const { id: scenarioId, chapterId } = newData;

      // ── Name, clock, initial state, seeded events — one PATCH ────────────
      ops.push({
        kind: "scenario.update",
        chapterId,
        scenarioId,
        name: newData.name,
        clock: newData.clock !== undefined ? newData.clock : null,
        initialState: newData.initialState ?? {},
        seededEvents: Array.isArray(newData.seededEvents)
          ? (newData.seededEvents as ScenarioSeededEvent[])
          : [],
        entityDir,
      });

      // ── Interactions ──────────────────────────────────────────────────────
      // Diff against the old interactions from the manifest.
      // - Interactions added or changed → record-interaction (upsert per uiElementId)
      // - Interactions removed → clear + re-record all (no per-element delete in the API)
      // - No change → emit nothing
      const interactions = Array.isArray(newData.interactions) ? newData.interactions : [];
      const oldInteractions = Array.isArray(diff.oldInteractions) ? diff.oldInteractions : [];

      // Detect whether any interactions were removed. If so, we need clear + full
      // re-record since the API has no per-element delete.
      const interactionRemoved = oldInteractions.length > interactions.length;

      if (interactionRemoved) {
        // An interaction was removed — must clear and re-record all.
        ops.push({ kind: "scenario.clear-interactions", chapterId, scenarioId, entityDir });
        for (const interaction of interactions) {
          ops.push({
            kind: "scenario.record-interaction",
            chapterId,
            scenarioId,
            uiElementId: interaction.uiElementId,
            storage: interaction.storage,
            entityDir,
          });
        }
      } else {
        // No steps removed — upsert only changed/new steps.
        for (let i = 0; i < interactions.length; i++) {
          const oldStep = oldInteractions[i];
          const newStep = interactions[i]!;
          const unchanged =
            oldStep !== undefined &&
            oldStep.uiElementId === newStep.uiElementId &&
            JSON.stringify(oldStep.storage) === JSON.stringify(newStep.storage);
          if (!unchanged) {
            ops.push({
              kind: "scenario.record-interaction",
              chapterId,
              scenarioId,
              uiElementId: newStep.uiElementId,
              storage: newStep.storage,
              entityDir,
            });
          }
        }
      }

      // ── Expectations ──────────────────────────────────────────────────────
      const newExpectations: ScenarioExpectationData[] = Array.isArray(newData.expectations)
        ? (newData.expectations as ScenarioExpectationData[])
        : [];
      const oldExpectations: ScenarioExpectationData[] =
        (diff.oldExpectations as ScenarioExpectationData[] | undefined) ?? [];

      const newById = new Map(newExpectations.map((e) => [e.id, e]));
      const oldById = new Map(oldExpectations.map((e) => [e.id, e]));

      for (const exp of newExpectations) {
        const old = oldById.get(exp.id);
        if (!old || JSON.stringify(old) !== JSON.stringify(exp)) {
          ops.push({ kind: "scenario.set-expectation", chapterId, scenarioId, expectation: exp, entityDir });
        }
      }
      for (const old of oldExpectations) {
        if (!newById.has(old.id)) {
          ops.push({ kind: "scenario.remove-expectation", chapterId, scenarioId, expectationId: old.id, entityDir });
        }
      }
      break;
    }
  }
}

function handleCreate(
  root: string,
  entityDir: string,
  kind: EntityKind,
  ops: SyncBackOperation[],
  seen: Set<string>,
): void {
  const key = `create:${entityDir}`;
  if (seen.has(key)) return;
  seen.add(key);

  switch (kind) {
    case "chapter": {
      const data = readJsonFile(root, `${entityDir}/chapter.json`) as ChapterJson | null;
      if (data?.name) ops.push({ kind: "chapter.create", name: data.name, context: data.context, mode: data.mode, skipDefaultContent: true, entityDir, localId: data.id || undefined });
      break;
    }
    case "lane": {
      const data = readJsonFile(root, `${entityDir}/lane.json`) as LaneJson | null;
      const chapterId = resolveChapterId(root, entityDir);
      if (data?.label && data.type && chapterId) {
        ops.push({ kind: "lane.create", chapterId, label: data.label, type: data.type, index: data.index ?? 0, height: data.height, entityDir, localId: data.id || undefined });
      }
      break;
    }
    case "slice": {
      const data = readJsonFile(root, `${entityDir}/slice.json`) as SliceJson | null;
      const chapterId = resolveChapterId(root, entityDir);
      const details = readMarkdownIfExists(root, `${entityDir}/details.md`);
      if (data?.label && chapterId) {
        ops.push({ kind: "slice.create", chapterId, label: data.label, index: data.index, status: data.status, width: data.width, details: details || undefined, entityDir, localId: data.id || undefined });
      }
      break;
    }
    case "element": {
      const data = readJsonFile(root, `${entityDir}/element.json`) as ElementJson | null;
      const chapterId = resolveChapterId(root, entityDir);
      const description = readMarkdownIfExists(root, `${entityDir}/description.md`);
      const details = readMarkdownIfExists(root, `${entityDir}/details.md`);
      if (data?.name && data.type && data.laneId && data.sliceId && chapterId) {
        ops.push({
          kind: "element.create",
          chapterId,
          name: data.name,
          type: data.type,
          laneId: data.laneId,
          sliceId: data.sliceId,
          description: description || undefined,
          details: details || undefined,
          index: data.index,
          context: data.context,
          entityDir,
          localId: data.id || undefined,
        });

        // The create endpoints (POST /elements, POST /event-reactions) do not
        // accept play_type/play_function — push them via a follow-up config op.
        // Priority ordering guarantees the create runs first. When element.json
        // has no id the API assigns one on create; the executor substitutes
        // PENDING_ELEMENT_ID with the returned id.
        const pf = readFileIfExists(root, `${entityDir}/play-function.ts`);
        const ptRaw = readFileIfExists(root, `${entityDir}/play-type.ts`);
        if (pf !== null || ptRaw !== null) {
          ops.push({
            kind: "element.update-config",
            chapterId,
            elementId: data.id || PENDING_ELEMENT_ID,
            playFunction: pf ?? undefined,
            playType: ptRaw !== null ? stripPlayTypeWrapper(ptRaw) : undefined,
            entityDir,
          });
        }
      }
      break;
    }
    case "milestone": {
      const data = readJsonFile(root, `${entityDir}/milestone.json`) as MilestoneJson | null;
      const description = readMarkdownIfExists(root, `${entityDir}/description.md`);
      if (data?.name) {
        ops.push({ kind: "milestone.create", name: data.name, description: description || data.description, deadline: data.deadline, color: data.color, entityDir });
      }
      break;
    }
    case "html-snippet": {
      const jsonData = readJsonFile(root, `${entityDir}.json`) as HtmlSnippetJson | null;
      const slug = jsonData?.slug ?? extractSlugFromEntityDir(entityDir);
      const snippetContent = readFileIfExists(root, `${entityDir}.html`) ?? "";
      if (jsonData?.name && snippetContent) {
        ops.push({ kind: "html-snippet.create", name: jsonData.name, snippet: snippetContent, slug: slug || undefined, entityDir });
      }
      break;
    }
    case "scenario": {
      const data = readJsonFile(root, `${entityDir}/scenario.json`) as ScenarioJson | null;
      // chapterId is required to create a scenario; it's stored in scenario.json by sync.
      if (!data?.name || !data?.chapterId) break;
      const { chapterId } = data;
      ops.push({
        kind: "scenario.create",
        chapterId,
        name: data.name,
        clock: data.clock ?? undefined,
        initialState: data.initialState,
        seededEvents: Array.isArray(data.seededEvents) ? (data.seededEvents as ScenarioSeededEvent[]) : undefined,
        entityDir,
      });

      // Emit interaction ops using the PENDING_SCENARIO_ID sentinel. The executor
      // will substitute the real ID returned by scenario.create before executing them.
      // record-interaction is an upsert per uiElementId — no clear needed for a new scenario.
      const interactions = Array.isArray(data.interactions) ? data.interactions : [];
      for (const interaction of interactions) {
        ops.push({
          kind: "scenario.record-interaction",
          chapterId,
          scenarioId: PENDING_SCENARIO_ID,
          uiElementId: interaction.uiElementId,
          storage: interaction.storage,
          entityDir,
        });
      }

      // Emit expectation ops — all are new since the scenario didn't exist before.
      const expectations: ScenarioExpectationData[] = Array.isArray(data.expectations)
        ? (data.expectations as ScenarioExpectationData[])
        : [];
      for (const exp of expectations) {
        ops.push({
          kind: "scenario.set-expectation",
          chapterId,
          scenarioId: PENDING_SCENARIO_ID,
          expectation: exp,
          entityDir,
        });
      }
      break;
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Read a JSON file from the sync root. Returns null if not found or invalid. */
function readJsonFile(root: string, relPath: string): Record<string, unknown> | null {
  try {
    const abs = join(root, relPath);
    if (!existsSync(abs)) return null;
    return JSON.parse(readFileSync(abs, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Like readMarkdown but returns null if the file doesn't exist. */
function readMarkdownIfExists(root: string, relPath: string): string | null {
  try {
    const abs = join(root, relPath);
    if (!existsSync(abs)) return null;
    return readFileSync(abs, "utf8").trimEnd();
  } catch {
    return null;
  }
}

function readFileIfExists(root: string, relPath: string): string | null {
  try {
    const abs = join(root, relPath);
    if (!existsSync(abs)) return null;
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

/** Strip the `type Payload = ` wrapper that render.ts adds to play-type.ts. */
function stripPlayTypeWrapper(content: string): string {
  return content.replace(/^type Payload = /, "").trim().replace(/;$/, "");
}

/**
 * Resolve the chapter ID by walking up the entity dir to the chapter dir and reading
 * chapter.json.
 *
 * entityDir is like:
 *   chapters/[chapter-uuid]/slices/[slice-uuid]
 *   chapters/[chapter-uuid]/lanes/[lane-uuid]
 *   chapters/[chapter-uuid]/elements/[element-uuid]
 *
 * We find the `chapters/[uuid]` prefix and read its chapter.json.
 */
export function resolveChapterId(root: string, entityDir: string): string | null {
  // Match chapters/[uuid]
  const m = entityDir.match(/^(chapters\/[^/]+)/);
  if (!m) return null;
  const chapterDir = m[1];
  const chapterJson = readJsonFile(root, `${chapterDir}/chapter.json`) as ChapterJson | null;
  return chapterJson?.id ?? null;
}

/**
 * Extract the slug from an html-snippet entityDir.
 * entityDir for html-snippets is `html-snippets/[slug]` (no extension).
 */
function extractSlugFromEntityDir(entityDir: string): string | null {
  const m = entityDir.match(/^html-snippets\/(.+)$/);
  return m?.[1] ?? null;
}
