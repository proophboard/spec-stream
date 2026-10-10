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
 *   4. Element creates
 *   5. Content updates (description, details, play-function, play-type, slice details,
 *      lane details/rename/resize, chapter rename/context, milestone updates)
 *   6. Element moves (new_lane_id / new_slice_id differ from element.json values)
 *   7. Renames (entity dir changed, but same chapter/slice/lane parent)
 *   8. Deletes (reverse dependency order: elements → slices → lanes → chapters → milestones)
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
  | { kind: "chapter.create"; name: string; context?: string; mode?: string; entityDir?: string }
  | { kind: "chapter.rename"; chapterId: string; newName: string }
  | { kind: "chapter.update-context"; chapterId: string; newContext: string }
  | { kind: "chapter.delete"; chapterId: string }
  | { kind: "lane.create"; chapterId: string; label: string; type: string; index: number; height?: number; entityDir?: string }
  | { kind: "lane.rename"; chapterId: string; laneId: string; newLabel: string }
  | { kind: "lane.update-details"; chapterId: string; laneId: string; newDetails: string }
  | { kind: "lane.resize"; chapterId: string; laneId: string; newHeight: number }
  | { kind: "lane.delete"; chapterId: string; laneId: string }
  | { kind: "slice.create"; chapterId: string; label: string; index?: number; status?: string; details?: string; width?: number; entityDir?: string }
  | { kind: "slice.rename"; chapterId: string; sliceId: string; newLabel: string }
  | { kind: "slice.update-details"; chapterId: string; sliceId: string; newDetails: string }
  | { kind: "slice.update-status"; chapterId: string; sliceId: string; newStatus: string }
  | { kind: "slice.delete"; chapterId: string; sliceId: string }
  | { kind: "element.create"; chapterId: string; name: string; type: string; laneId: string; sliceId: string; description?: string; details?: string; index?: number; context?: string; entityDir?: string }
  | { kind: "element.rename"; chapterId: string; elementId: string; newName: string }
  | { kind: "element.update-description"; chapterId: string; elementId: string; newDescription: string }
  | { kind: "element.update-details"; chapterId: string; elementId: string; newDetails: string }
  | { kind: "element.update-config"; chapterId: string; elementId: string; playFunction?: string; playType?: string }
  | { kind: "element.move"; chapterId: string; elementId: string; newLaneId: string; newSliceId: string; newIndex: number }
  | { kind: "element.delete"; chapterId: string; elementId: string }
  | { kind: "milestone.create"; name: string; description?: string; deadline?: string; color?: string; entityDir?: string }
  | { kind: "milestone.update"; milestoneId: string; name?: string; description?: string; deadline?: string; color?: string }
  | { kind: "milestone.delete"; milestoneId: string }
  | { kind: "html-snippet.create"; name: string; snippet: string; slug?: string; entityDir?: string }
  | { kind: "html-snippet.update"; slug: string; name?: string; snippet?: string }
  | { kind: "html-snippet.delete"; slug: string }
  | { kind: "scenario.set-expectation"; chapterId: string; scenarioId: string; expectation: ScenarioExpectationData }
  | { kind: "scenario.remove-expectation"; chapterId: string; scenarioId: string; expectationId: string }
  | { kind: "scenario.create"; chapterId: string; name: string; clock?: string; initialState?: Record<string, unknown>; seededEvents?: ScenarioSeededEvent[]; entityDir?: string }
  | { kind: "scenario.delete"; chapterId: string; scenarioId: string }
  | { kind: "scenario.update"; chapterId: string; scenarioId: string; name?: string; clock?: string | null; initialState?: Record<string, unknown>; seededEvents?: ScenarioSeededEvent[] }
  | { kind: "scenario.record-interaction"; chapterId: string; scenarioId: string; stepIndex: number; storage: Record<string, unknown> }
  | { kind: "scenario.clear-interactions"; chapterId: string; scenarioId: string };

// ─── Priority buckets ─────────────────────────────────────────────────────────

const PRIORITY: Record<OperationKind, number> = {
  "chapter.create": 0,
  "lane.create": 1,
  "slice.create": 2,
  "element.create": 3,
  "chapter.rename": 4,
  "chapter.update-context": 4,
  "lane.rename": 4,
  "lane.update-details": 4,
  "lane.resize": 4,
  "slice.rename": 4,
  "slice.update-details": 4,
  "slice.update-status": 4,
  "element.rename": 4,
  "element.update-description": 4,
  "element.update-details": 4,
  "element.update-config": 4,
  "milestone.create": 4,
  "milestone.update": 4,
  "element.move": 5,
  "element.delete": 6,
  "slice.delete": 7,
  "lane.delete": 8,
  "chapter.delete": 9,
  "milestone.delete": 9,
  "html-snippet.create": 4,
  "html-snippet.update": 4,
  "html-snippet.delete": 9,
  "scenario.set-expectation": 4,
  "scenario.remove-expectation": 4,
  "scenario.create": 4,
  "scenario.delete": 9,
  "scenario.update": 4,
  "scenario.record-interaction": 4,
  "scenario.clear-interactions": 4,
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

  // Sort by priority.
  ops.sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind]);
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
    case "rename":
      handleRename(root, diff, ops, seen);
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
      ops.push({ kind: "chapter.delete", chapterId: id });
      break;
    case "slice": {
      const chapterId = resolveChapterId(root, entityDir);
      if (chapterId) ops.push({ kind: "slice.delete", chapterId, sliceId: id });
      break;
    }
    case "lane": {
      const chapterId = resolveChapterId(root, entityDir);
      if (chapterId) ops.push({ kind: "lane.delete", chapterId, laneId: id });
      break;
    }
    case "element": {
      const chapterId = resolveChapterId(root, entityDir);
      if (chapterId) ops.push({ kind: "element.delete", chapterId, elementId: id });
      break;
    }
    case "milestone":
      ops.push({ kind: "milestone.delete", milestoneId: id });
      break;
    case "html-snippet": {
      const slug = extractSlugFromEntityDir(entityDir);
      if (slug) ops.push({ kind: "html-snippet.delete", slug });
      break;
    }
    case "scenario": {
      // scenario.json carries chapterId — read it from the manifest entry's entityDir
      // since the file is gone from disk. We stored chapterId in scenario.json at sync
      // time, but can also derive it from the entityDir path:
      // chapters/[Context]/[Chapter]/scenarios/[Scenario]
      const chapterId = resolveChapterId(root, entityDir);
      if (chapterId) ops.push({ kind: "scenario.delete", chapterId, scenarioId: id });
      break;
    }
  }
}

function handleRename(
  root: string,
  diff: EntityDiff,
  ops: SyncBackOperation[],
  seen: Set<string>,
): void {
  const { entityDir, kind, id, oldEntityDir } = diff;
  if (!id || !oldEntityDir) return;

  const key = `rename:${oldEntityDir}→${entityDir}`;
  if (seen.has(key)) return;
  seen.add(key);

  // Mark the update key as seen so handleUpdate won't duplicate work on the new dir.
  seen.add(`update:${entityDir}`);

  switch (kind) {
    case "chapter": {
      const data = readJsonFile(root, `${entityDir}/chapter.json`) as ChapterJson | null;
      if (!data) return;
      const oldCtx = extractContextFromChapterDir(oldEntityDir);
      const newCtx = extractContextFromChapterDir(entityDir);
      if (oldCtx !== newCtx && newCtx) {
        ops.push({ kind: "chapter.update-context", chapterId: id, newContext: data.context ?? newCtx });
      }
      const oldNameSeg = oldEntityDir.split("/").pop();
      const newNameSeg = entityDir.split("/").pop();
      if (oldNameSeg !== newNameSeg && data.name) {
        ops.push({ kind: "chapter.rename", chapterId: id, newName: data.name });
      }
      break;
    }
    case "slice": {
      const data = readJsonFile(root, `${entityDir}/slice.json`) as SliceJson | null;
      const chapterId = resolveChapterId(root, entityDir);
      if (data?.label && chapterId) {
        ops.push({ kind: "slice.rename", chapterId, sliceId: id, newLabel: data.label });
      }
      break;
    }
    case "lane": {
      const data = readJsonFile(root, `${entityDir}/lane.json`) as LaneJson | null;
      const chapterId = resolveChapterId(root, entityDir);
      if (data?.label && chapterId) {
        ops.push({ kind: "lane.rename", chapterId, laneId: id, newLabel: data.label });
      }
      break;
    }
    case "element": {
      const data = readJsonFile(root, `${entityDir}/element.json`) as ElementJson | null;
      const chapterId = resolveChapterId(root, entityDir);
      if (!data || !chapterId) return;

      const oldSliceLanePath = extractSliceLanePath(oldEntityDir);
      const newSliceLanePath = extractSliceLanePath(entityDir);

      if (oldSliceLanePath !== newSliceLanePath) {
        // Move (parent slice/lane changed).
        if (data.laneId && data.sliceId) {
          ops.push({
            kind: "element.move",
            chapterId,
            elementId: id,
            newLaneId: data.laneId,
            newSliceId: data.sliceId,
            newIndex: data.index ?? 0,
          });
        }
      } else if (data.name) {
        ops.push({ kind: "element.rename", chapterId, elementId: id, newName: data.name });
      }
      break;
    }
    case "milestone": {
      const data = readJsonFile(root, `${entityDir}/milestone.json`) as MilestoneJson | null;
      if (data) {
        ops.push({ kind: "milestone.update", milestoneId: id, name: data.name, description: data.description, deadline: data.deadline, color: data.color });
      }
      break;
    }
  }

  // Also process content updates for the new location.
  void handleUpdate(root, { ...diff, status: "update" }, ops, seen);
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
        ops.push({ kind: "chapter.rename", chapterId: entityId, newName: data.name });
      if (data?.context !== undefined && changed("context", data.context))
        ops.push({ kind: "chapter.update-context", chapterId: entityId, newContext: data.context });
      break;
    }
    case "slice": {
      const data = readJsonFile(root, `${entityDir}/slice.json`) as SliceJson | null;
      const entityId = data?.id ?? id;
      const chapterId = resolveChapterId(root, entityDir);
      if (!entityId || !chapterId) return;
      if (data?.label !== undefined && changed("label", data.label))
        ops.push({ kind: "slice.rename", chapterId, sliceId: entityId, newLabel: data.label });
      if (data?.status !== undefined && changed("status", data.status))
        ops.push({ kind: "slice.update-status", chapterId, sliceId: entityId, newStatus: data.status });
      // Slice details — only emit if details.md actually changed.
      const detailsContent = readMarkdownIfExists(root, `${entityDir}/details.md`);
      const oldSliceCH = diff.oldContentHashes ?? {};
      if (detailsContent !== null) {
        const oldH = oldSliceCH["details.md"];
        if (!oldH || hashContent(detailsContent) !== oldH)
          ops.push({ kind: "slice.update-details", chapterId, sliceId: entityId, newDetails: detailsContent });
      }
      break;
    }
    case "lane": {
      const data = readJsonFile(root, `${entityDir}/lane.json`) as LaneJson | null;
      const entityId = data?.id ?? id;
      const chapterId = resolveChapterId(root, entityDir);
      if (!entityId || !chapterId) return;
      if (data?.label !== undefined && changed("label", data.label))
        ops.push({ kind: "lane.rename", chapterId, laneId: entityId, newLabel: data.label });
      if (data?.height !== undefined && changed("height", data.height))
        ops.push({ kind: "lane.resize", chapterId, laneId: entityId, newHeight: data.height });
      break;
    }
    case "element": {
      const data = readJsonFile(root, `${entityDir}/element.json`) as ElementJson | null;
      const entityId = data?.id ?? id;
      const chapterId = resolveChapterId(root, entityDir);
      if (!entityId || !chapterId) return;
      if (data?.name !== undefined && changed("name", data.name))
        ops.push({ kind: "element.rename", chapterId, elementId: entityId, newName: data.name });
      if (data?.laneId && data?.sliceId && (changed("laneId", data.laneId) || changed("sliceId", data.sliceId) || changed("index", data.index ?? 0)))
        ops.push({ kind: "element.move", chapterId, elementId: entityId, newLaneId: data.laneId, newSliceId: data.sliceId, newIndex: data.index ?? 0 });

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
        ops.push({ kind: "element.update-description", chapterId, elementId: entityId, newDescription: desc! });
      const details = readMarkdownIfExists(root, `${entityDir}/details.md`);
      if (contentChanged("details.md", details))
        ops.push({ kind: "element.update-details", chapterId, elementId: entityId, newDetails: details! });
      const pf = readFileIfExists(root, `${entityDir}/play-function.ts`);
      const ptRaw = readFileIfExists(root, `${entityDir}/play-type.ts`);
      const pt = ptRaw ? stripPlayTypeWrapper(ptRaw) : null;
      if (contentChanged("play-function.ts", pf) || contentChanged("play-type.ts", ptRaw))
        ops.push({ kind: "element.update-config", chapterId, elementId: entityId, playFunction: pf ?? undefined, playType: pt ?? undefined });
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
        ops.push({ kind: "milestone.update", milestoneId: entityId, name: data?.name, description: desc ?? data?.description, deadline: data?.deadline, color: data?.color });
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
      });

      // ── Interactions ──────────────────────────────────────────────────────
      // Replace all: clear then re-record each one in order.
      const interactions = Array.isArray(newData.interactions) ? newData.interactions : [];
      ops.push({ kind: "scenario.clear-interactions", chapterId, scenarioId });
      for (let i = 0; i < interactions.length; i++) {
        ops.push({
          kind: "scenario.record-interaction",
          chapterId,
          scenarioId,
          stepIndex: i,
          storage: interactions[i]!.storage,
        });
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
          ops.push({ kind: "scenario.set-expectation", chapterId, scenarioId, expectation: exp });
        }
      }
      for (const old of oldExpectations) {
        if (!newById.has(old.id)) {
          ops.push({ kind: "scenario.remove-expectation", chapterId, scenarioId, expectationId: old.id });
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
      if (data?.name) ops.push({ kind: "chapter.create", name: data.name, context: data.context, mode: data.mode, entityDir });
      break;
    }
    case "lane": {
      const data = readJsonFile(root, `${entityDir}/lane.json`) as LaneJson | null;
      const chapterId = resolveChapterId(root, entityDir);
      if (data?.label && data.type && chapterId) {
        ops.push({ kind: "lane.create", chapterId, label: data.label, type: data.type, index: data.index ?? 0, height: data.height, entityDir });
      }
      break;
    }
    case "slice": {
      const data = readJsonFile(root, `${entityDir}/slice.json`) as SliceJson | null;
      const chapterId = resolveChapterId(root, entityDir);
      const details = readMarkdownIfExists(root, `${entityDir}/details.md`);
      if (data?.label && chapterId) {
        ops.push({ kind: "slice.create", chapterId, label: data.label, index: data.index, status: data.status, width: data.width, details: details || undefined, entityDir });
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
        });
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
      ops.push({
        kind: "scenario.create",
        chapterId: data.chapterId,
        name: data.name,
        clock: data.clock ?? undefined,
        initialState: data.initialState,
        seededEvents: Array.isArray(data.seededEvents) ? (data.seededEvents as ScenarioSeededEvent[]) : undefined,
        entityDir,
      });
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
  return content.replace(/^type Payload = /, "").trim();
}

/**
 * Resolve the chapter ID by walking up the entity dir to the chapter dir and reading
 * chapter.json.
 *
 * entityDir is like:
 *   chapters/App/MyChapter/slices/0001_Foo/lanes/information-flow/Bar/elements/0001_Baz
 *
 * We find the `chapters/[Context]/[Name]` prefix and read its chapter.json.
 */
export function resolveChapterId(root: string, entityDir: string): string | null {
  // Match chapters/[Context]/[Chapter name]
  const m = entityDir.match(/^(chapters\/[^/]+\/[^/]+)/);
  if (!m) return null;
  const chapterDir = m[1];
  const chapterJson = readJsonFile(root, `${chapterDir}/chapter.json`) as ChapterJson | null;
  return chapterJson?.id ?? null;
}

/** Extract the Context segment from a chapter dir like `chapters/App/MyChapter`. */
function extractContextFromChapterDir(chapterDir: string): string | null {
  const m = chapterDir.match(/^chapters\/([^/]+)\/[^/]+$/);
  return m?.[1] ?? null;
}

/**
 * Extract the slice+lane path from an element dir, to detect moves vs renames.
 * e.g. `chapters/App/Ch/slices/0001_Foo/lanes/information-flow/Bar` from
 * `chapters/App/Ch/slices/0001_Foo/lanes/information-flow/Bar/elements/0001_El`
 */
function extractSliceLanePath(elementDir: string): string {
  const m = elementDir.match(/^(.+)\/elements\/[^/]+$/);
  return m?.[1] ?? elementDir;
}

/**
 * Extract the slug from an html-snippet entityDir.
 * entityDir for html-snippets is `html-snippets/[slug]` (no extension).
 */
function extractSlugFromEntityDir(entityDir: string): string | null {
  const m = entityDir.match(/^html-snippets\/(.+)$/);
  return m?.[1] ?? null;
}
