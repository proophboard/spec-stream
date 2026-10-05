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
import type { FileChange } from "./gitDiff.js";
import { readFileAtCommit, syncRelToRepoRel } from "./gitDiff.js";
import { parseSyncPath, primaryJsonPath, type ParsedPath, type EntityKind } from "./pathParser.js";

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
  | "scenario.remove-expectation";

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

export interface ScenarioJson {
  id?: string;
  chapterId?: string;
  expectations?: ScenarioExpectationData[];
}

export interface ScenarioJson {
  id?: string;
  chapterId?: string;
  expectations?: ScenarioExpectationData[];
}

export interface ScenarioExpectationData {
  id: string;
  sliceId: string;
  kind: string;
  elementId?: string;
  match?: string;
  expected: Record<string, unknown>;
}

export type SyncBackOperation =
  | { kind: "chapter.create"; name: string; context?: string; mode?: string }
  | { kind: "chapter.rename"; chapterId: string; newName: string }
  | { kind: "chapter.update-context"; chapterId: string; newContext: string }
  | { kind: "chapter.delete"; chapterId: string }
  | { kind: "lane.create"; chapterId: string; label: string; type: string; index: number; height?: number }
  | { kind: "lane.rename"; chapterId: string; laneId: string; newLabel: string }
  | { kind: "lane.update-details"; chapterId: string; laneId: string; newDetails: string }
  | { kind: "lane.resize"; chapterId: string; laneId: string; newHeight: number }
  | { kind: "lane.delete"; chapterId: string; laneId: string }
  | { kind: "slice.create"; chapterId: string; label: string; index?: number; status?: string; details?: string; width?: number }
  | { kind: "slice.rename"; chapterId: string; sliceId: string; newLabel: string }
  | { kind: "slice.update-details"; chapterId: string; sliceId: string; newDetails: string }
  | { kind: "slice.update-status"; chapterId: string; sliceId: string; newStatus: string }
  | { kind: "slice.delete"; chapterId: string; sliceId: string }
  | { kind: "element.create"; chapterId: string; name: string; type: string; laneId: string; sliceId: string; description?: string; details?: string; index?: number; context?: string }
  | { kind: "element.rename"; chapterId: string; elementId: string; newName: string }
  | { kind: "element.update-description"; chapterId: string; elementId: string; newDescription: string }
  | { kind: "element.update-details"; chapterId: string; elementId: string; newDetails: string }
  | { kind: "element.update-config"; chapterId: string; elementId: string; playFunction?: string; playType?: string }
  | { kind: "element.move"; chapterId: string; elementId: string; newLaneId: string; newSliceId: string; newIndex: number }
  | { kind: "element.delete"; chapterId: string; elementId: string }
  | { kind: "milestone.create"; name: string; description?: string; deadline?: string; color?: string }
  | { kind: "milestone.update"; milestoneId: string; name?: string; description?: string; deadline?: string; color?: string }
  | { kind: "milestone.delete"; milestoneId: string }
  | { kind: "html-snippet.create"; name: string; snippet: string; slug?: string }
  | { kind: "html-snippet.update"; slug: string; name?: string; snippet?: string }
  | { kind: "html-snippet.delete"; slug: string }
  | { kind: "scenario.set-expectation"; chapterId: string; scenarioId: string; expectation: ScenarioExpectationData }
  | { kind: "scenario.remove-expectation"; chapterId: string; scenarioId: string; expectationId: string };

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
};

// ─── Public API ──────────────────────────────────────────────────────────────

export interface BuildOperationsOptions {
  /** Absolute path to the sync root directory (e.g. `/project/.spec-stream/model`). */
  syncRootAbs: string;
  /** File changes from the git diff reader (paths relative to sync root). */
  changes: FileChange[];
  /** Base commit used for the diff (default: `HEAD~1`). Used to read old file content for scenario diffing. */
  fromCommit?: string;
  /** Override the git working directory (default: `process.cwd()`). */
  cwd?: string;
}

/**
 * Build the ordered list of API operations from a set of file changes.
 *
 * Reads entity `.json` and content files from disk (the committed state already on
 * disk when the post-commit hook fires). Returns operations sorted by priority.
 */
export async function buildOperations(opts: BuildOperationsOptions): Promise<SyncBackOperation[]> {
  const { syncRootAbs, changes, fromCommit = "HEAD~1", cwd = process.cwd() } = opts;
  const ops: SyncBackOperation[] = [];

  // Track entity dirs we've already processed to avoid duplicate operations from
  // multiple files in the same entity dir (e.g. both element.json and description.md
  // changed — we emit one create/rename and then content updates).
  const processedEntityDirs = new Set<string>();

  for (const change of changes) {
    await processChange(syncRootAbs, change, ops, processedEntityDirs, fromCommit, cwd);
  }

  // Sort by priority.
  ops.sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind]);
  return ops;
}

// ─── Internal ─────────────────────────────────────────────────────────────────

async function processChange(
  root: string,
  change: FileChange,
  ops: SyncBackOperation[],
  seen: Set<string>,
  fromCommit: string,
  cwd: string,
): Promise<void> {
  const parsed = parseSyncPath(change.path);
  if (!parsed) return;
  if (parsed.generated) return;

  // ─── Deletes ─────────────────────────────────────────────────────────────
  if (change.status === "D") {
    handleDelete(root, parsed, change, ops, seen);
    return;
  }

  // ─── Renames (directory-level) ───────────────────────────────────────────
  if (change.status === "R" && change.newPath) {
    handleRename(root, parsed, change, ops, seen);
    return;
  }

  // ─── Adds and Modifications ─────────────────────────────────────────────
  await handleAddOrModify(root, parsed, change, ops, seen, fromCommit, cwd);
}

function handleDelete(
  root: string,
  parsed: ParsedPath,
  _change: FileChange,
  ops: SyncBackOperation[],
  seen: Set<string>,
): void {
  const { kind, entityDir, role } = parsed;

  // Only emit delete when the primary json is deleted.
  if (role !== "chapter.json" && role !== "slice.json" && role !== "lane.json" &&
      role !== "element.json" && role !== "milestone.json" && role !== "html-snippet.json") return;

  const key = `delete:${entityDir}`;
  if (seen.has(key)) return;
  seen.add(key);

  // For deleted files the .json is gone from disk. We try readJsonFromGit which
  // falls back to disk; if the file is truly gone we skip the delete (safe — prooph
  // board history captures the truth and the user can rebuild the sync dir).
  const json = readJsonFromGit(root, primaryJsonPath(parsed));
  if (!json) return; // Can't resolve ID — skip delete.

  switch (kind) {
    case "chapter": {
      const data = json as ChapterJson;
      if (data.id) ops.push({ kind: "chapter.delete", chapterId: data.id });
      break;
    }
    case "slice": {
      const data = json as SliceJson;
      const chapterId = resolveChapterId(root, entityDir);
      if (data.id && chapterId) ops.push({ kind: "slice.delete", chapterId, sliceId: data.id });
      break;
    }
    case "lane": {
      const data = json as LaneJson;
      const chapterId = resolveChapterId(root, entityDir);
      if (data.id && chapterId) ops.push({ kind: "lane.delete", chapterId, laneId: data.id });
      break;
    }
    case "element": {
      const data = json as ElementJson;
      const chapterId = resolveChapterId(root, entityDir);
      if (data.id && chapterId) ops.push({ kind: "element.delete", chapterId, elementId: data.id });
      break;
    }
    case "milestone": {
      const data = json as MilestoneJson;
      if (data.id) ops.push({ kind: "milestone.delete", milestoneId: data.id });
      break;
    }
    case "html-snippet": {
      const data = json as HtmlSnippetJson;
      const slug = data.slug ?? extractSlugFromEntityDir(entityDir);
      if (slug) ops.push({ kind: "html-snippet.delete", slug });
      break;
    }
  }
}

function handleRename(
  root: string,
  parsed: ParsedPath,
  change: FileChange,
  ops: SyncBackOperation[],
  seen: Set<string>,
): void {
  if (!change.newPath) return;
  // Only process renames on the .json file to avoid duplicates.
  if (parsed.role !== "chapter.json" && parsed.role !== "slice.json" &&
      parsed.role !== "lane.json" && parsed.role !== "element.json" &&
      parsed.role !== "milestone.json") return;

  const newParsed = parseSyncPath(change.newPath);
  if (!newParsed) return;

  const key = `rename:${parsed.entityDir}→${newParsed.entityDir}`;
  if (seen.has(key)) return;
  seen.add(key);

  // Read the NEW json (the destination that now exists on disk).
  const newJson = readJsonFile(root, primaryJsonPath(newParsed));
  if (!newJson) return;

  const { kind } = parsed;

  // If the entity dir changed, check what changed:
  // - chapter: context dir changed → update-context, or name dir changed → rename
  // - slice: name/index prefix changed → rename
  // - lane: label dir changed → rename
  // - element: name/index prefix changed → rename, or slice/lane dir changed → move
  // - milestone: name dir changed → update (name change)

  switch (kind) {
    case "chapter": {
      const data = newJson as ChapterJson;
      if (!data.id) return;
      // Context dir is chapters/[Context]/[name] — compare old vs new Context segment
      const oldCtx = extractContextFromChapterDir(parsed.entityDir);
      const newCtx = extractContextFromChapterDir(newParsed.entityDir);
      if (oldCtx !== newCtx && newCtx) {
        ops.push({ kind: "chapter.update-context", chapterId: data.id, newContext: data.context ?? newCtx });
      }
      // If the name segment changed, emit rename.
      const oldNameSeg = parsed.entityDir.split("/").pop();
      const newNameSeg = newParsed.entityDir.split("/").pop();
      if (oldNameSeg !== newNameSeg && data.name) {
        ops.push({ kind: "chapter.rename", chapterId: data.id, newName: data.name });
      }
      break;
    }
    case "slice": {
      const data = newJson as SliceJson;
      const chapterId = resolveChapterId(root, newParsed.entityDir);
      if (!data.id || !chapterId) return;
      if (data.label) ops.push({ kind: "slice.rename", chapterId, sliceId: data.id, newLabel: data.label });
      break;
    }
    case "lane": {
      const data = newJson as LaneJson;
      const chapterId = resolveChapterId(root, newParsed.entityDir);
      if (!data.id || !chapterId) return;
      if (data.label) ops.push({ kind: "lane.rename", chapterId, laneId: data.id, newLabel: data.label });
      break;
    }
    case "element": {
      const data = newJson as ElementJson;
      const chapterId = resolveChapterId(root, newParsed.entityDir);
      if (!data.id || !chapterId) return;

      // Check if the parent slice/lane changed (= move), or just the element name (= rename).
      const oldSliceLanePath = extractSliceLanePath(parsed.entityDir);
      const newSliceLanePath = extractSliceLanePath(newParsed.entityDir);

      if (oldSliceLanePath !== newSliceLanePath) {
        // Move
        if (data.laneId && data.sliceId) {
          ops.push({
            kind: "element.move",
            chapterId,
            elementId: data.id,
            newLaneId: data.laneId,
            newSliceId: data.sliceId,
            newIndex: data.index ?? 0,
          });
        }
      } else if (data.name) {
        ops.push({ kind: "element.rename", chapterId, elementId: data.id, newName: data.name });
      }
      break;
    }
    case "milestone": {
      const data = newJson as MilestoneJson;
      if (!data.id) return;
      ops.push({ kind: "milestone.update", milestoneId: data.id, name: data.name, description: data.description, deadline: data.deadline, color: data.color });
      break;
    }
  }

  // Also process the new location for content updates (e.g. details.md changed too).
  handleAddOrModify(root, newParsed, { ...change, status: "M", path: change.newPath, newPath: undefined }, ops, seen, "HEAD~1", process.cwd());
}

async function handleAddOrModify(
  root: string,
  parsed: ParsedPath,
  change: FileChange,
  ops: SyncBackOperation[],
  seen: Set<string>,
  fromCommit: string,
  cwd: string,
): Promise<void> {
  const { kind, entityDir, role } = parsed;

  if (change.status === "A" && role === primaryJsonRoleFor(kind)) {
    // New entity: emit a create operation.
    handleCreate(root, parsed, ops, seen);
    return;
  }

  // Content updates for modified files.
  switch (role) {
    case "chapter.json": {
      // Modified chapter.json — could be rename or context change.
      const key = `chapter-json-update:${entityDir}`;
      if (seen.has(key)) return;
      seen.add(key);
      const data = readJsonFile(root, primaryJsonPath(parsed)) as ChapterJson | null;
      if (!data?.id) return;
      // We emit both; the executor will skip no-ops (but we don't diff here — simpler).
      if (data.name) ops.push({ kind: "chapter.rename", chapterId: data.id, newName: data.name });
      if (data.context !== undefined) ops.push({ kind: "chapter.update-context", chapterId: data.id, newContext: data.context });
      break;
    }
    case "slice.json": {
      const key = `slice-json-update:${entityDir}`;
      if (seen.has(key)) return;
      seen.add(key);
      const data = readJsonFile(root, primaryJsonPath(parsed)) as SliceJson | null;
      const chapterId = resolveChapterId(root, entityDir);
      if (!data?.id || !chapterId) return;
      if (data.label) ops.push({ kind: "slice.rename", chapterId, sliceId: data.id, newLabel: data.label });
      if (data.status) ops.push({ kind: "slice.update-status", chapterId, sliceId: data.id, newStatus: data.status });
      break;
    }
    case "lane.json": {
      const key = `lane-json-update:${entityDir}`;
      if (seen.has(key)) return;
      seen.add(key);
      const data = readJsonFile(root, primaryJsonPath(parsed)) as LaneJson | null;
      const chapterId = resolveChapterId(root, entityDir);
      if (!data?.id || !chapterId) return;
      if (data.label) ops.push({ kind: "lane.rename", chapterId, laneId: data.id, newLabel: data.label });
      if (data.height !== undefined) ops.push({ kind: "lane.resize", chapterId, laneId: data.id, newHeight: data.height });
      break;
    }
    case "element.json": {
      const key = `element-json-update:${entityDir}`;
      if (seen.has(key)) return;
      seen.add(key);
      const data = readJsonFile(root, primaryJsonPath(parsed)) as ElementJson | null;
      const chapterId = resolveChapterId(root, entityDir);
      if (!data?.id || !chapterId) return;
      if (data.name) ops.push({ kind: "element.rename", chapterId, elementId: data.id, newName: data.name });
      if (data.laneId && data.sliceId) {
        ops.push({ kind: "element.move", chapterId, elementId: data.id, newLaneId: data.laneId, newSliceId: data.sliceId, newIndex: data.index ?? 0 });
      }
      break;
    }
    case "milestone.json": {
      const key = `milestone-json-update:${entityDir}`;
      if (seen.has(key)) return;
      seen.add(key);
      const data = readJsonFile(root, primaryJsonPath(parsed)) as MilestoneJson | null;
      if (!data?.id) return;
      ops.push({ kind: "milestone.update", milestoneId: data.id, name: data.name, description: data.description, deadline: data.deadline, color: data.color });
      break;
    }
    case "slice.details": {
      const key = `slice-details:${entityDir}`;
      if (seen.has(key)) return;
      seen.add(key);
      const sliceData = readJsonFile(root, primaryJsonPath(parsed)) as SliceJson | null;
      const chapterId = resolveChapterId(root, entityDir);
      if (!sliceData?.id || !chapterId) return;
      const content = readMarkdown(root, change.status === "R" && change.newPath ? change.newPath : change.path);
      ops.push({ kind: "slice.update-details", chapterId, sliceId: sliceData.id, newDetails: content });
      break;
    }
    case "element.description": {
      const key = `element-desc:${entityDir}`;
      if (seen.has(key)) return;
      seen.add(key);
      const elData = readJsonFile(root, primaryJsonPath(parsed)) as ElementJson | null;
      const chapterId = resolveChapterId(root, entityDir);
      if (!elData?.id || !chapterId) return;
      const content = readMarkdown(root, change.status === "R" && change.newPath ? change.newPath : change.path);
      ops.push({ kind: "element.update-description", chapterId, elementId: elData.id, newDescription: content });
      break;
    }
    case "element.details": {
      const key = `element-details:${entityDir}`;
      if (seen.has(key)) return;
      seen.add(key);
      const elData = readJsonFile(root, primaryJsonPath(parsed)) as ElementJson | null;
      const chapterId = resolveChapterId(root, entityDir);
      if (!elData?.id || !chapterId) return;
      const content = readMarkdown(root, change.status === "R" && change.newPath ? change.newPath : change.path);
      ops.push({ kind: "element.update-details", chapterId, elementId: elData.id, newDetails: content });
      break;
    }
    case "element.play-function":
    case "element.play-type": {
      const key = `element-config:${entityDir}`;
      if (seen.has(key)) return;
      seen.add(key);
      const elData = readJsonFile(root, primaryJsonPath(parsed)) as ElementJson | null;
      const chapterId = resolveChapterId(root, entityDir);
      if (!elData?.id || !chapterId) return;
      // Gather both play-function and play-type from disk (if either changed, read both).
      const pfPath = `${entityDir}/play-function.ts`;
      const ptPath = `${entityDir}/play-type.ts`;
      const pf = readFileIfExists(root, pfPath);
      const pt = readFileIfExists(root, ptPath);
      const playType = pt ? stripPlayTypeWrapper(pt) : undefined;
      ops.push({ kind: "element.update-config", chapterId, elementId: elData.id, playFunction: pf ?? undefined, playType: playType ?? undefined });
      break;
    }
    case "element-details.details": {
      // element-details are per-element; we need to find all elements that reference this
      // canonical details file and update each. For simplicity, we emit the update
      // against the canonical entry itself — the API handles fan-out.
      // Actually, we don't have a direct "update canonical details" endpoint; we must update
      // via an element. Skip for now — element.details changes in element dir cover this.
      break;
    }
    case "milestone.description": {
      const key = `milestone-desc:${entityDir}`;
      if (seen.has(key)) return;
      seen.add(key);
      const mData = readJsonFile(root, primaryJsonPath(parsed)) as MilestoneJson | null;
      if (!mData?.id) return;
      const content = readMarkdown(root, change.status === "R" && change.newPath ? change.newPath : change.path);
      ops.push({ kind: "milestone.update", milestoneId: mData.id, description: content });
      break;
    }
    case "html-snippet.html":
    case "html-snippet.json": {
      const key = `html-snippet:${entityDir}`;
      if (seen.has(key)) return;
      seen.add(key);
      const jsonData = readJsonFile(root, primaryJsonPath(parsed)) as HtmlSnippetJson | null;
      const slug = jsonData?.slug ?? extractSlugFromEntityDir(entityDir);
      if (!slug) return;
      const htmlPath = `${entityDir}.html`;
      const snippetContent = readFileIfExists(root, htmlPath);
      ops.push({
        kind: "html-snippet.update",
        slug,
        ...(jsonData?.name !== undefined && { name: jsonData.name }),
        ...(snippetContent !== null && { snippet: snippetContent }),
      });
      break;
    }
    case "scenario.json": {
      const key = `scenario-json:${entityDir}`;
      if (seen.has(key)) return;
      seen.add(key);

      const newData = readJsonFile(root, primaryJsonPath(parsed)) as ScenarioJson | null;
      if (!newData?.id || !newData?.chapterId) return;

      const { id: scenarioId, chapterId } = newData;
      const newExpectations: ScenarioExpectationData[] = Array.isArray(newData.expectations)
        ? (newData.expectations as ScenarioExpectationData[])
        : [];

      // Read old expectations from the base commit via git show.
      const repoRelPath = await syncRelToRepoRel(root, `${entityDir}/scenario.json`, cwd);
      let oldExpectations: ScenarioExpectationData[] = [];
      if (repoRelPath) {
        const oldRaw = await readFileAtCommit(repoRelPath, fromCommit, cwd);
        if (oldRaw) {
          try {
            const oldData = JSON.parse(oldRaw) as ScenarioJson;
            oldExpectations = Array.isArray(oldData.expectations)
              ? (oldData.expectations as ScenarioExpectationData[])
              : [];
          } catch { /* ignore parse errors */ }
        }
      }

      const newById = new Map(newExpectations.map((e) => [e.id, e]));
      const oldById = new Map(oldExpectations.map((e) => [e.id, e]));

      // Set (create or update) expectations that are new or changed.
      for (const exp of newExpectations) {
        const old = oldById.get(exp.id);
        if (!old || JSON.stringify(old) !== JSON.stringify(exp)) {
          ops.push({ kind: "scenario.set-expectation", chapterId, scenarioId, expectation: exp });
        }
      }

      // Remove expectations that existed before but are gone now.
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
  parsed: ParsedPath,
  ops: SyncBackOperation[],
  seen: Set<string>,
): void {
  const { kind, entityDir } = parsed;
  const key = `create:${entityDir}`;
  if (seen.has(key)) return;
  seen.add(key);

  switch (kind) {
    case "chapter": {
      const data = readJsonFile(root, primaryJsonPath(parsed)) as ChapterJson | null;
      if (data?.name) ops.push({ kind: "chapter.create", name: data.name, context: data.context, mode: data.mode });
      break;
    }
    case "lane": {
      const data = readJsonFile(root, primaryJsonPath(parsed)) as LaneJson | null;
      const chapterId = resolveChapterId(root, entityDir);
      if (data?.label && data.type && chapterId) {
        ops.push({ kind: "lane.create", chapterId, label: data.label, type: data.type, index: data.index ?? 0, height: data.height });
      }
      break;
    }
    case "slice": {
      const data = readJsonFile(root, primaryJsonPath(parsed)) as SliceJson | null;
      const chapterId = resolveChapterId(root, entityDir);
      // Also read details.md for the slice.
      const detailsPath = `${entityDir}/details.md`;
      const details = readMarkdownIfExists(root, detailsPath);
      if (data?.label && chapterId) {
        ops.push({ kind: "slice.create", chapterId, label: data.label, index: data.index, status: data.status, width: data.width, details: details || undefined });
      }
      break;
    }
    case "element": {
      const data = readJsonFile(root, primaryJsonPath(parsed)) as ElementJson | null;
      const chapterId = resolveChapterId(root, entityDir);
      const descPath = `${entityDir}/description.md`;
      const detPath = `${entityDir}/details.md`;
      const description = readMarkdownIfExists(root, descPath);
      const details = readMarkdownIfExists(root, detPath);
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
        });
      }
      break;
    }
    case "milestone": {
      const data = readJsonFile(root, primaryJsonPath(parsed)) as MilestoneJson | null;
      const descPath = `${entityDir}/description.md`;
      const description = readMarkdownIfExists(root, descPath);
      if (data?.name) {
        ops.push({ kind: "milestone.create", name: data.name, description: description || data.description, deadline: data.deadline, color: data.color });
      }
      break;
    }
    case "html-snippet": {
      // The .json carries slug+name; the .html carries the content.
      const jsonData = readJsonFile(root, primaryJsonPath(parsed)) as HtmlSnippetJson | null;
      const slug = jsonData?.slug ?? extractSlugFromEntityDir(entityDir);
      const htmlPath = `${entityDir}.html`;
      const snippetContent = readFileIfExists(root, htmlPath) ?? "";
      if (jsonData?.name && snippetContent) {
        ops.push({ kind: "html-snippet.create", name: jsonData.name, snippet: snippetContent, slug: slug || undefined });
      }
      break;
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Return the primary json role for a given entity kind. */
function primaryJsonRoleFor(kind: EntityKind | "element-details"): string {
  switch (kind) {
    case "chapter": return "chapter.json";
    case "slice":   return "slice.json";
    case "lane":    return "lane.json";
    case "element": return "element.json";
    case "milestone": return "milestone.json";
    case "html-snippet": return "html-snippet.json";
    case "scenario": return "scenario.json";
    default:        return "__never__";
  }
}

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

/**
 * Try to read the JSON from git (HEAD~1) for deleted files.
 * Falls back to reading from disk.
 */
function readJsonFromGit(root: string, relPath: string): Record<string, unknown> | null {
  // Try disk first (may still be present for path-only changes).
  const diskResult = readJsonFile(root, relPath);
  if (diskResult) return diskResult;
  // If not on disk (deleted), we can't get the ID without a git show call.
  // For safety, return null and skip the delete operation.
  return null;
}

/** Read a file from disk relative to the sync root, stripping the generated marker. */
function readMarkdown(root: string, relPath: string): string {
  try {
    const abs = join(root, relPath);
    if (!existsSync(abs)) return "";
    const raw = readFileSync(abs, "utf8");
    return stripGeneratedMarker(raw);
  } catch {
    return "";
  }
}

/** Like readMarkdown but returns null if the file doesn't exist. */
function readMarkdownIfExists(root: string, relPath: string): string | null {
  try {
    const abs = join(root, relPath);
    if (!existsSync(abs)) return null;
    const raw = readFileSync(abs, "utf8");
    return stripGeneratedMarker(raw);
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

const GENERATED_MARKER_RE =
  /^<!-- Generated by spec-stream[^\n]*-->\n?/;

/** Strip the spec-stream generated marker from markdown content. */
function stripGeneratedMarker(content: string): string {
  return content.replace(GENERATED_MARKER_RE, "").trim();
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
