/**
 * Manifest-based diff for sync-back.
 *
 * Replaces the git-diff approach. Instead of asking git what changed, we:
 *   1. Walk the model directory on disk to find all current entity directories.
 *   2. Compare against the last-known state in sync-manifest.json (written by sync)
 *      and sync-back-ids.json (written by sync-back after creates).
 *   3. Classify each entity as: create / update / delete / rename-or-move.
 *
 * This works correctly regardless of whether the model directory is tracked by git,
 * gitignored, or git is not installed at all.
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
} from "./manifest.js";
import { parseSyncPath, primaryJsonPath } from "./pathParser.js";
import type { EntityKind } from "./pathParser.js";

// ─── Output types ─────────────────────────────────────────────────────────────

export type DiffStatus = "create" | "update" | "delete" | "rename";

export interface EntityDiff {
  status: DiffStatus;
  /** Entity directory relative to model root (forward-slash). */
  entityDir: string;
  /** Entity kind. */
  kind: EntityKind;
  /**
   * The entity id.
   * - create: undefined (not yet known)
   * - update/delete/rename: the existing id from the manifest
   */
  id?: string;
  /**
   * For renames/moves: the old entity directory (from the manifest).
   * The new location is `entityDir`.
   */
  oldEntityDir?: string;
  /**
   * For scenario entities: the previous expectations array from the manifest.
   * Used by operationBuilder to diff and emit set/remove-expectation ops.
   */
  oldExpectations?: ScenarioExpectationSnapshot[];
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

// ─── Primary json filenames by kind ──────────────────────────────────────────

const PRIMARY_JSON_BY_KIND: Partial<Record<EntityKind, string>> = {
  chapter:      "chapter.json",
  slice:        "slice.json",
  lane:         "lane.json",
  element:      "element.json",
  milestone:    "milestone.json",
  "html-snippet": "", // html-snippets use entityDir.json, handled separately
  scenario:     "scenario.json",
};

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
 * create / update / delete / rename at the entity-directory level.
 */
export function computeManifestDiff(opts: ManifestDiffOptions): EntityDiff[] {
  const { syncRootAbs } = opts;

  // Load both manifests and merge.
  const syncManifest = loadManifest(syncManifestPath(syncRootAbs));
  const syncBackIds  = loadManifest(syncBackIdsPath(syncRootAbs));
  const known        = mergeManifests(syncManifest, syncBackIds);

  // Build reverse lookups for rename detection.
  // id → entityDir from manifest
  const manifestIdToDir = new Map<string, string>();
  for (const [dir, entry] of Object.entries(known)) {
    manifestIdToDir.set(entry.id, dir);
  }

  // Walk disk to find all current entity dirs.
  const diskEntities = walkDiskEntities(syncRootAbs);

  const diffs: EntityDiff[] = [];
  const handledManifestDirs = new Set<string>();

  for (const { entityDir, kind } of diskEntities) {
    // Read the id from the on-disk json.
    const diskId = readEntityId(syncRootAbs, entityDir, kind);

    const manifestEntry: ManifestEntry | undefined = known[entityDir];

    if (!manifestEntry) {
      // This dir is not in the manifest at all.
      if (diskId) {
        // Has an id on disk — check if the id exists in the manifest under a *different* dir
        // (rename/move): the entity was renamed locally.
        const oldDir = manifestIdToDir.get(diskId);
        if (oldDir && oldDir !== entityDir) {
          diffs.push({
            status: "rename",
            entityDir,
            kind,
            id: diskId,
            oldEntityDir: oldDir,
            oldExpectations: known[oldDir]?.extra?.expectations,
            oldFields: known[oldDir]?.fields,
            oldContentHashes: known[oldDir]?.contentHashes,
          });
          handledManifestDirs.add(oldDir);
          continue;
        }
      }
      // No id on disk, or id not in manifest — genuine create.
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
        oldFields: manifestEntry.fields,
        oldContentHashes: manifestEntry.contentHashes,
      });
    }
  }

  // Any manifest dir that wasn't found on disk (and not already handled as a rename
  // source) is a delete.
  for (const [entityDir, entry] of Object.entries(known)) {
    if (handledManifestDirs.has(entityDir)) continue;
    // Determine kind from the entityDir path.
    const kind = kindFromEntityDir(entityDir);
    if (!kind) continue;
    diffs.push({
      status: "delete",
      entityDir,
      kind,
      id: entry.id,
      oldExpectations: entry.extra?.expectations,
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

/** Read the id field from the entity's primary json on disk. Returns undefined on any failure. */
function readEntityId(syncRoot: string, entityDir: string, kind: EntityKind): string | undefined {
  // Build primary json path using same logic as pathParser.
  const primaryFile = PRIMARY_JSON_BY_KIND[kind];
  if (primaryFile === undefined) return undefined;

  // For html-snippets the json is at entityDir + ".json" (e.g. html-snippets/my-slug.json)
  // but parseSyncPath stores entityDir as "html-snippets/my-slug" (without extension).
  // primaryJsonPath() in pathParser handles this correctly.
  const fakeParsed = {
    kind,
    entityDir,
    role: (kind + ".json") as never,
    generated: false,
  };
  const relJsonPath = primaryJsonPath(fakeParsed);
  const absPath = join(syncRoot, relJsonPath);

  try {
    if (!existsSync(absPath)) return undefined;
    const raw = readFileSync(absPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed.id === "string" && parsed.id ? parsed.id : undefined;
  } catch {
    return undefined;
  }
}

/** Infer entity kind from an entityDir path. Returns null for unrecognised paths. */
function kindFromEntityDir(entityDir: string): EntityKind | null {
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
