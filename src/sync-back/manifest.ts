/**
 * Manifest types and helpers for sync-back.
 *
 * Two separate files avoid concurrent write conflicts between the sync process
 * (which writes frequently as board events arrive) and sync-back (which writes
 * only the ids returned from create operations):
 *
 *   .spec-stream/sync-manifest.json
 *     Written exclusively by the sync/projection pass after each successful
 *     write to the model directory. Contains every entity the board knows about.
 *
 *   .spec-stream/sync-back-ids.json
 *     Written exclusively by sync-back after successful create operations,
 *     recording the new ids returned by the API. Acts as a bridge until the
 *     next sync pass absorbs those entities and updates sync-manifest.json.
 *
 * Both files use the same SyncManifest shape. sync-back reads both and merges
 * them to determine the full set of known entities.
 *
 * For scenario expectations sync-back needs the old expectations array to diff
 * against. These are stored in the manifest under the scenario entity entry.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────────────

/** One entry in the manifest for a known entity. */
export interface ManifestEntry {
  /** The prooph board UUID for this entity. */
  id: string;
  /**
   * A cheap content hash of the entity's files at the time of last successful sync-back
   * (or last sync write). Used by manifestDiff to skip entities whose content hasn't
   * changed, avoiding spurious update operations.
   */
  hash?: string;
  /**
   * Snapshot of the key mutable fields from the entity's primary json at the time
   * the manifest was last written. Used by operationBuilder to detect which specific
   * fields changed so it only emits the ops that are actually needed.
   *
   * For elements: name, laneId, sliceId, index
   * For slices:   label, status, width
   * For lanes:    label, height
   * For chapters: name, context
   * For scenarios: name, clock
   */
  fields?: Record<string, unknown>;
  /**
   * Per-file content hashes for the entity's content files (description.md, details.md,
   * play-function.ts, etc.). Used by operationBuilder to only emit content-update ops
   * for files that actually changed, not all content files whenever any file changes.
   * Keys are file basenames relative to the entity directory.
   */
  contentHashes?: Record<string, string>;
  /** Extra per-kind data needed for structural diffing. Currently only used for scenarios. */
  extra?: {
    /** Last-known scenario expectations (for diffing on next sync-back run). */
    expectations?: ScenarioExpectationSnapshot[];
  };
}

export interface ScenarioExpectationSnapshot {
  id: string;
  sliceId: string;
  kind: string;
  elementId?: string;
  match?: string;
  expected: Record<string, unknown>;
}

/** The on-disk format for both manifest files. */
export interface SyncManifest {
  /**
   * Schema version — bump when the shape changes incompatibly.
   * Readers should silently ignore files with unknown versions.
   */
  version: 1;
  /** ISO timestamp of the last write. */
  updatedAt: string;
  /**
   * Map of entityDir (relative to sync model root, forward-slash) → entry.
   * Example key: "chapters/App/My-Chapter/slices/0001_Foo"
   */
  entities: Record<string, ManifestEntry>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Load a manifest file. Returns an empty manifest if the file doesn't exist or is invalid. */
export function loadManifest(absPath: string): SyncManifest {
  try {
    if (!existsSync(absPath)) return emptyManifest();
    const raw = readFileSync(absPath, "utf8");
    const parsed = JSON.parse(raw) as SyncManifest;
    if (parsed.version !== 1 || typeof parsed.entities !== "object") {
      // File exists but is not a valid manifest — warn so users don't silently lose ids.
      process.stderr.write(
        `Warning: ${absPath} exists but failed schema check ` +
        `(expected version=1 and entities object). Treating as empty manifest.\n`,
      );
      return emptyManifest();
    }
    return parsed;
  } catch {
    return emptyManifest();
  }
}

/** Write a manifest file atomically (write to .tmp then rename). */
export function saveManifest(absPath: string, manifest: SyncManifest): void {
  mkdirSync(dirname(absPath), { recursive: true });
  const tmp = absPath + ".tmp";
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  renameSync(tmp, absPath);
}

/** Merge sync-manifest and sync-back-ids into a single entity lookup. */
export function mergeManifests(
  syncManifest: SyncManifest,
  syncBackIds: SyncManifest,
): Record<string, ManifestEntry> {
  // sync-manifest is authoritative for structural fields (id, hash, fields, contentHashes).
  // sync-back-ids fills gaps for entities not yet in the sync-manifest.
  // However, sync-manifest may lag behind sync-back on `extra` data (e.g. expectations
  // written by sync-back after the last sync pass) — so we forward-merge `extra` from
  // sync-back-ids when the sync-manifest entry has no `extra` of its own.
  const merged: Record<string, ManifestEntry> = {
    ...syncBackIds.entities,
    ...syncManifest.entities,
  };
  for (const [dir, syncBackEntry] of Object.entries(syncBackIds.entities)) {
    if (syncBackEntry.extra && merged[dir] && !merged[dir].extra) {
      merged[dir] = { ...merged[dir], extra: syncBackEntry.extra };
    }
  }
  return merged;
}

export function emptyManifest(): SyncManifest {
  return { version: 1, updatedAt: new Date().toISOString(), entities: {} };
}

// ─── Path helpers ─────────────────────────────────────────────────────────────

/**
 * Build the absolute path to sync-manifest.json given the model directory.
 * The manifest lives one level above the model dir, alongside sync-state.json.
 */
export function syncManifestPath(modelDirAbs: string): string {
  return join(dirname(modelDirAbs), "sync-manifest.json");
}

/** Build the absolute path to sync-back-ids.json. */
export function syncBackIdsPath(modelDirAbs: string): string {
  return join(dirname(modelDirAbs), "sync-back-ids.json");
}

/**
 * Read the key mutable fields from an entity's primary json on disk.
 * Returns an empty object if the file doesn't exist or can't be parsed.
 */
export function readEntityFields(modelDirAbs: string, entityDir: string, kind: string): Record<string, unknown> {
  const isHtmlSnippet = kind === "html-snippet";
  const relPath = isHtmlSnippet ? `${entityDir}.json` : (() => {
    const suffixMap: Record<string, string> = {
      chapter: "chapter.json", slice: "slice.json", lane: "lane.json",
      element: "element.json", milestone: "milestone.json", scenario: "scenario.json",
    };
    return suffixMap[kind] ? `${entityDir}/${suffixMap[kind]}` : null;
  })();
  if (!relPath) return {};
  try {
    const abs = join(modelDirAbs, relPath);
    if (!existsSync(abs)) return {};
    const parsed = JSON.parse(readFileSync(abs, "utf8")) as Record<string, unknown>;
    const snap: Record<string, unknown> = {};
    for (const f of ["name","label","context","mode","status","width","height","laneId","sliceId","index","clock","slug"]) {
      if (parsed[f] !== undefined) snap[f] = parsed[f];
    }
    return snap;
  } catch {
    return {};
  }
}

// ─── Content hashing ──────────────────────────────────────────────────────────

/**
 * Compute a cheap content hash over a set of file/field contents.
 *
 * Uses djb2 — fast, deterministic, collision-resistant enough to distinguish
 * changed vs unchanged entity files. Not cryptographic.
 */
export function hashContent(...contents: (string | undefined)[]): string {
  let h = 5381;
  for (const s of contents) {
    if (!s) continue;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    }
    h = (h ^ 0xdeadbeef) >>> 0; // separator between fields
  }
  return h.toString(16);
}

/**
 * Read per-file content hashes for an entity's content files from disk.
 * Mirrors what buildManifestFromTree stores in contentHashes.
 */
export function readEntityContentHashes(modelDirAbs: string, entityDir: string): Record<string, string> {
  const CONTENT_FILES = ["description.md", "details.md", "play-function.ts", "play-type.ts"];
  const result: Record<string, string> = {};
  for (const cf of CONTENT_FILES) {
    try {
      const abs = join(modelDirAbs, entityDir, cf);
      if (existsSync(abs)) {
        result[cf] = hashContent(readFileSync(abs, "utf8"));
      }
    } catch { /* skip */ }
  }
  return result;
}

// ─── Manifest builder (used by sync/projection) ───────────────────────────────

const PRIMARY_JSON_SUFFIX = [
  "/chapter.json",
  "/slice.json",
  "/lane.json",
  "/element.json",
  "/milestone.json",
  "/scenario.json",
] as const;

// html-snippets have a flat path: html-snippets/[slug].json
// (no subdirectory — entityDir is "html-snippets/[slug]", file is entityDir + ".json")
const HTML_SNIPPET_JSON_REGEX = /^html-snippets\/[^/]+\.json$/;

/**
 * Build a SyncManifest from a DesiredTree (the output of render()).
 *
 * Walks all paths in the tree that end in a primary .json filename, parses the
 * content, and extracts the entity id. Also computes a content hash over all files
 * belonging to the entity so that manifestDiff can skip entities that haven't changed.
 *
 * Scenario entries additionally capture the expectations array for diffing.
 */
export function buildManifestFromTree(
  tree: Map<string, string>,
): SyncManifest {
  const entities: Record<string, ManifestEntry> = {};

  for (const [relPath, content] of tree) {
    const suffix = PRIMARY_JSON_SUFFIX.find((s) => relPath.endsWith(s));
    const isHtmlSnippet = !suffix && HTML_SNIPPET_JSON_REGEX.test(relPath);
    if (!suffix && !isHtmlSnippet) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content) as Record<string, unknown>;
    } catch {
      continue;
    }

    const id = typeof parsed.id === "string" ? parsed.id
      // html-snippets use slug as their identity (no UUID id field)
      : typeof parsed.slug === "string" ? parsed.slug
      : undefined;
    if (!id) continue;

    // For normal entities: entityDir is the directory (path minus "/filename.json").
    // For html-snippets: entityDir is "html-snippets/[slug]" (path minus ".json").
    const entityDir = isHtmlSnippet
      ? relPath.slice(0, -".json".length)
      : relPath.slice(0, relPath.length - suffix!.length);

    // Collect only files that belong directly to this entity (not child entity dirs).
    // Child entity dirs (slices/, lanes/, elements/, scenarios/) have their own hashes.
    const CHILD_ENTITY_DIRS = ["slices/", "lanes/", "elements/", "scenarios/", "comments/"];
    const entityFiles = isHtmlSnippet
      ? [content, tree.get(`${entityDir}.html`) ?? ""]
      : [...tree.entries()]
          .filter(([p]) => {
            if (!p.startsWith(entityDir + "/") && p !== relPath) return false;
            // Exclude paths that are inside a child entity subdirectory.
            const afterDir = p.slice(entityDir.length + 1); // path relative to entity dir
            return !CHILD_ENTITY_DIRS.some((c) => afterDir.startsWith(c));
          })
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, v]) => v);
    const hash = hashContent(...entityFiles);

    const entry: ManifestEntry = { id, hash };

    // Snapshot key mutable structural fields for op-level change detection.
    const fields: Record<string, unknown> = {};
    for (const f of ["name","label","context","mode","status","width","height","laneId","sliceId","index","clock","slug"]) {
      if (parsed[f] !== undefined) fields[f] = parsed[f];
    }
    if (Object.keys(fields).length > 0) entry.fields = fields;

    // Store per-file content hashes for content files so operationBuilder can skip
    // individual content ops (e.g. update-description) when only details changed.
    const CONTENT_FILES = ["description.md", "details.md", "play-function.ts", "play-type.ts"];
    const contentHashes: Record<string, string> = {};
    for (const cf of CONTENT_FILES) {
      const cfContent = tree.get(`${entityDir}/${cf}`);
      if (cfContent !== undefined) {
        contentHashes[cf] = hashContent(cfContent);
      }
    }
    if (Object.keys(contentHashes).length > 0) entry.contentHashes = contentHashes;

    // Store scenario expectations for next sync-back diff.
    if (relPath.endsWith("/scenario.json") && Array.isArray(parsed.expectations)) {
      entry.extra = {
        expectations: parsed.expectations as ScenarioExpectationSnapshot[],
      };
    }

    entities[entityDir] = entry;
  }

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    entities,
  };
}
