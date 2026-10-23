/**
 * Manifest-based diff for sync-back.
 *
 * Replaces the git-diff approach. Instead of asking git what changed, we:
 *   1. Walk the model directory on disk to find all current entity directories.
 *   2. Compare against the last-known state in sync-manifest.json (written by sync)
 *      and sync-back-ids.json (written by sync-back after creates).
 *   3. Classify each entity as: create / update / delete.
 *
 * This works correctly regardless of whether the model directory is tracked by git,
 * gitignored, or git is not installed at all.
 *
 * ## Directory structure
 *
 * All entity directories are UUID-keyed. Because a UUID dir is named after the entity
 * id, the directory path never changes when an entity is renamed or moved — renames
 * and moves surface purely as content changes inside the primary .json file and are
 * handled as "update" diffs by operationBuilder.
 *
 * The "rename" status is therefore never emitted by this function.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  loadManifest,
  mergeManifests,
  syncManifestPath,
  syncBackIdsPath,
  hashContent,
  type ManifestEntry,
  type ScenarioExpectationSnapshot,
  type ScenarioInteractionSnapshot,
} from "./manifest.js";
import { parseSyncPath } from "./pathParser.js";
import type { EntityKind } from "./pathParser.js";

// ─── Output types ─────────────────────────────────────────────────────────────

export type DiffStatus = "create" | "update" | "delete";

export interface EntityDiff {
  status: DiffStatus;
  /** Entity directory relative to model root (forward-slash). */
  entityDir: string;
  /** Entity kind. */
  kind: EntityKind;
  /**
   * The entity id.
   * - create: undefined (not yet known)
   * - update/delete: the existing id from the manifest
   */
  id?: string;
  /**
   * For scenario entities: the previous expectations array from the manifest.
   * Used by operationBuilder to diff and emit set/remove-expectation ops.
   */
  oldExpectations?: ScenarioExpectationSnapshot[];
  /**
   * For scenario entities: the previous interactions array from the manifest.
   * Used by operationBuilder to diff and only emit record-interaction for changed steps.
   */
  oldInteractions?: ScenarioInteractionSnapshot[];
  /**
   * Snapshot of key mutable fields from the manifest at the time of last sync.
   * Used by operationBuilder to compare against current json and only emit ops
   * for fields that actually changed (avoids spurious rename/move/resize/status ops).
   */
  oldFields?: Record<string, unknown>;
  /**
   * Per-file content hashes from the manifest. Used by operationBuilder to skip
   * individual content-update ops (description, details, play-function, etc.) when
   * only other files in the entity changed.
   */
  oldContentHashes?: Record<string, string>;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface ManifestDiffOptions {
  /** Absolute path to the model root directory (e.g. `/project/.spec-stream/model`). */
  syncRootAbs: string;
}

/**
 * Compute the diff between the current disk state and the last-known manifest state.
 *
 * Returns one EntityDiff per entity that needs attention. Entities that are identical
 * in both the manifest and on disk (no file content changes) are still returned as
 * "update" — the operationBuilder is responsible for reading the actual files and
 * deciding which specific API calls to make. The diff only determines
 * create / update / delete at the entity-directory level.
 */
export function computeManifestDiff(opts: ManifestDiffOptions): EntityDiff[] {
  const { syncRootAbs } = opts;

  // Load both manifests and merge.
  const syncManifest = loadManifest(syncManifestPath(syncRootAbs));
  const syncBackIds  = loadManifest(syncBackIdsPath(syncRootAbs));
  const known        = mergeManifests(syncManifest, syncBackIds);

  // Walk disk to find all current entity dirs.
  const diskEntities = walkDiskEntities(syncRootAbs);

  const diffs: EntityDiff[] = [];
  const handledManifestDirs = new Set<string>();

  for (const { entityDir, kind } of diskEntities) {
    const manifestEntry: ManifestEntry | undefined = known[entityDir];

    if (!manifestEntry) {
      // Dir not in manifest → genuine create.
      diffs.push({ status: "create", entityDir, kind });
    } else {
      // Dir is in the manifest — only emit an update if content has changed.
      handledManifestDirs.add(entityDir);

      // Compute current disk hash and compare against the manifest hash.
      // If the manifest has no hash (older manifest written before this feature),
      // conservatively treat it as changed so we don't silently skip updates.
      const diskHash = computeDiskHash(syncRootAbs, entityDir, kind);
      if (manifestEntry.hash && diskHash === manifestEntry.hash) {
        // Content unchanged — skip. No API call needed.
        continue;
      }

      diffs.push({
        status: "update",
        entityDir,
        kind,
        id: manifestEntry.id,
        oldExpectations: manifestEntry.extra?.expectations,
        oldInteractions: manifestEntry.extra?.interactions,
        oldFields: manifestEntry.fields,
        oldContentHashes: manifestEntry.contentHashes,
      });
    }
  }

  // Build a set of ids that were successfully handled (found on disk, matched to a
  // manifest entry). Used below to skip stale sync-back-ids entries whose entity was
  // renamed by the sync process (old dir in sync-back-ids, new dir in sync-manifest).
  const handledIds = new Set<string>();
  for (const dir of handledManifestDirs) {
    const entry = known[dir];
    if (entry?.id) handledIds.add(entry.id);
  }

  // Any manifest dir that wasn't found on disk (and not already handled as a rename
  // source) is a delete.
  //
  // Exception 1: if the same entity id is already tracked under a *different* dir that
  // was handled (found on disk), this entry is a stale record — not a real delete. This
  // happens when sync-back writes an entry for a directory (e.g. `0000_Lead-Created`)
  // and then the sync process renames the directory to match a board-side rename
  // (`0000_Lead-Registered`), updating sync-manifest.json but leaving the old
  // sync-back-ids.json entry in place. On the next sync-back run, both dirs appear in
  // the merged manifest, but only the new one exists on disk.  Without this guard the
  // old entry would produce a spurious `element.delete`.
  //
  // Exception 2: if the entry exists only in sync-back-ids (absent from sync-manifest)
  // AND the entity directory is missing from disk, the entity was deleted externally —
  // either on the board (sync processed the deletion event and removed the local file
  // and its sync-manifest entry) or by a manual local delete that sync has already
  // reconciled.  Emitting a delete op in this case would send a redundant API call for
  // an entity that no longer exists, producing 404/500 errors on every run.
  const syncManifestEntityIds = new Set(
    Object.values(syncManifest.entities).map((e) => e.id),
  );
  for (const [entityDir, entry] of Object.entries(known)) {
    if (handledManifestDirs.has(entityDir)) continue;
    // Skip stale entries: same id already handled under the new directory name.
    if (entry.id && handledIds.has(entry.id)) continue;
    // Skip externally-deleted entities: only in sync-back-ids, absent from
    // sync-manifest, and directory no longer on disk.
    if (entry.id && !syncManifestEntityIds.has(entry.id)) continue;
    // Determine kind from the entityDir path.
    const kind = kindFromEntityDir(entityDir);
    if (!kind) continue;
    diffs.push({
      status: "delete",
      entityDir,
      kind,
      id: entry.id,
      oldExpectations: entry.extra?.expectations,
      oldInteractions: entry.extra?.interactions,
    });
  }

  return diffs;
}

// ─── Disk walker ──────────────────────────────────────────────────────────────

interface DiskEntity {
  entityDir: string;
  kind: EntityKind;
}

/**
 * Walk the model directory on disk and return every entity directory that contains
 * a recognised primary json file. Paths are relative to syncRoot, forward-slash.
 */
function walkDiskEntities(syncRoot: string): DiskEntity[] {
  const results: DiskEntity[] = [];
  walkDir(syncRoot, syncRoot, results);
  return results;
}

function walkDir(syncRoot: string, absDir: string, out: DiskEntity[]): void {
  if (!existsSync(absDir)) return;

  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(absDir, { withFileTypes: true }) as import("node:fs").Dirent[];
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isFile()) continue;
    const absChild = join(absDir, entry.name);

    if (entry.isFile()) {
      // Check if this file is a primary json for a known entity kind.
      const relPath = toRelPath(syncRoot, absChild);
      const parsed = parseSyncPath(relPath);
      if (!parsed || parsed.generated) continue;

      // Only primary json files identify an entity.
      const isPrimary =
        parsed.role === "chapter.json"  ||
        parsed.role === "slice.json"    ||
        parsed.role === "lane.json"     ||
        parsed.role === "element.json"  ||
        parsed.role === "milestone.json"||
        parsed.role === "html-snippet.json" ||
        parsed.role === "scenario.json";

      if (isPrimary) {
        out.push({ entityDir: parsed.entityDir, kind: parsed.kind });
      }
    } else {
      // Recurse into subdirectories.
      walkDir(syncRoot, absChild, out);
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Compute the same content hash for an entity as buildManifestFromTree does,
 * but reading files from disk instead of from a DesiredTree.
 *
 * Only hashes files that belong directly to this entity — NOT files in child
 * entity subdirectories (those are separate entities with their own hashes).
 */
export function computeDiskHash(syncRoot: string, entityDir: string, kind: EntityKind): string {
  if (kind === "html-snippet") {
    const jsonAbs = join(syncRoot, `${entityDir}.json`);
    const htmlAbs = join(syncRoot, `${entityDir}.html`);
    const parts: string[] = [];
    for (const abs of [jsonAbs, htmlAbs]) {
      try { if (existsSync(abs)) parts.push(readFileSync(abs, "utf8")); } catch { /* skip */ }
    }
    return hashContent(...parts);
  }

  // For all other entity kinds, only include files in the immediate directory
  // that belong to this entity — skipping known child-entity subdirectory names.
  const CHILD_ENTITY_DIRS = new Set(["slices", "lanes", "elements", "scenarios", "comments"]);
  const absDir = join(syncRoot, entityDir);
  const files = listOwnFiles(absDir, CHILD_ENTITY_DIRS);
  files.sort();
  const contents: string[] = [];
  for (const abs of files) {
    try { contents.push(readFileSync(abs, "utf8")); } catch { /* skip */ }
  }
  return hashContent(...contents);
}

/**
 * List all files under `dir` that are NOT inside child-entity subdirectories.
 * Recurses into non-entity subdirectories (e.g. `comments/`) only shallowly.
 */
function listOwnFiles(dir: string, skipTopLevel: Set<string>): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as import("node:fs").Dirent[];
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (skipTopLevel.has(entry.name)) continue; // skip child entity dirs
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Recurse into non-entity subdirs (e.g. nothing at this level for most entities)
      out.push(...listFilesUnder(abs));
    } else if (entry.isFile()) {
      out.push(abs);
    }
  }
  return out;
}

/** Recursively list all file paths (absolute) under a directory. */
function listFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as import("node:fs").Dirent[];
  } catch {
    return [];
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesUnder(abs));
    } else if (entry.isFile()) {
      out.push(abs);
    }
  }
  return out;
}

/** Infer entity kind from an entityDir path. Returns null for unrecognised paths. */
export function kindFromEntityDir(entityDir: string): EntityKind | null {
  // Use parseSyncPath on the primary json path to get the kind.
  const candidates: Array<[string, EntityKind]> = [
    [`${entityDir}/chapter.json`,   "chapter"],
    [`${entityDir}/slice.json`,     "slice"],
    [`${entityDir}/lane.json`,      "lane"],
    [`${entityDir}/element.json`,   "element"],
    [`${entityDir}/milestone.json`, "milestone"],
    [`${entityDir}/scenario.json`,  "scenario"],
    [`${entityDir}.json`,           "html-snippet"],
  ];
  for (const [testPath, kind] of candidates) {
    const parsed = parseSyncPath(testPath);
    if (parsed && parsed.kind === kind) return kind;
  }
  return null;
}

/** Convert an absolute path to a forward-slash relative path under syncRoot. */
function toRelPath(syncRoot: string, absPath: string): string {
  const rel = absPath.startsWith(syncRoot)
    ? absPath.slice(syncRoot.length)
    : absPath;
  return rel.replace(/\\/g, "/").replace(/^\//, "");
}
