/**
 * Filesystem writer for the local model projection.
 *
 * Takes a {@link DesiredTree} (relative POSIX path -> content, from the renderer) and
 * makes the target directory match it exactly. The directory is treated as
 * **exclusively owned** by spec-stream: any file under it that is not in the desired tree
 * is deleted, and empty directories are pruned. This makes the tree a faithful mirror —
 * renames and removals clean up after themselves.
 *
 * Writes are diff-based: a file is only rewritten when its content actually changed, so an
 * unchanged projection touches nothing on disk (clean git history, no needless churn).
 *
 * All paths in the desired tree are relative POSIX paths; they are resolved under `rootDir`
 * using the host path separator. The writer never writes outside `rootDir` (the renderer
 * already sanitizes segments; the writer additionally rejects any path that escapes root).
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  readdirSync,
  statSync,
  existsSync,
} from "node:fs";
import { join, resolve, dirname, relative, sep } from "node:path";
import type { DesiredTree } from "./render.js";
import type { ModelState } from "./model.js";
import { buildWorkspaceModelDts } from "./modelDts.js";

/** Breakdown of what files were changed by type */
export interface ChangeBreakdown {
  chapters: number;
  slices: number;
  lanes: number;
  elements: number;
  milestones: number;
  scenarios: number;
  htmlSnippets: number;
  contentFiles: number; // description.md, details.md, play-function.ts, play-type.ts
  manifests: number;    // sync-manifest.json, sync-back-ids.json
  stateFiles: number;   // sync-state.json
  other: number;
}

export interface WriteResult {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
  /** Detailed breakdown of what was created/updated/deleted */
  byType: ChangeBreakdown;
  /**
   * Files that were actually changed (created or updated). 
   * Used to determine if a write pass had meaningful changes.
   */
  changedFiles: string[];
  /**
   * Git-style file list for verbose output.
   */
  filesAdded: string[];
  filesModified: string[];
  filesDeleted: string[];
}

/**
 * Make `rootDir` exactly match `tree`. Creates/updates changed files, deletes files not in
 * the tree, and prunes empty directories. Returns counts for logging.
 */
export function writeTree(rootDir: string, tree: DesiredTree): WriteResult {
  const root = resolve(rootDir);
  mkdirSync(root, { recursive: true });

  const result: WriteResult = { 
    created: 0, 
    updated: 0, 
    deleted: 0, 
    unchanged: 0,
    byType: {
      chapters: 0, slices: 0, lanes: 0, elements: 0,
      milestones: 0, scenarios: 0, htmlSnippets: 0,
      contentFiles: 0, manifests: 0, stateFiles: 0, other: 0,
    },
    changedFiles: [],
    filesAdded: [],
    filesModified: [],
    filesDeleted: [],
  };

  // Track files to delete (we'll do this after processing desired files to catch renames)
  const existingFiles = new Set(listFiles(root));
  const desiredPaths = new Set<string>();

  // Desired absolute paths, validated to stay within root.
  // sync-state.json is managed separately by the projection (not by the renderer),
  // so we must preserve it rather than let writeTree delete it as an "unknown" file.
  const PRESERVED_FILES = new Set(["sync-state.json"]);

  const desired = new Map<string, string>();
  for (const [rel, content] of tree) {
    const abs = resolve(root, rel);
    if (!isInside(root, abs)) {
      // Defensive: skip anything that would escape the owned directory.
      continue;
    }
    desired.set(abs, content);
    desiredPaths.add(abs);
    existingFiles.delete(abs); // This file is in the tree, don't delete it
  }

  // Also preserve special meta-files that are not in the rendered tree.
  for (const name of PRESERVED_FILES) {
    const abs = resolve(root, name);
    existingFiles.delete(abs);
  }

  // 1. Delete files on disk that are not desired.
  for (const abs of existingFiles) {
    rmSync(abs, { force: true });
    result.deleted++;
    result.byType.other++; // deleted files tracked as "other"
  }

  // 2. Create/update desired files (diff-based).
  for (const [abs, content] of desired) {
    const existing = readIfExists(abs);
    if (existing === content) {
      result.unchanged++;
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
    
    const rel = relative(root, abs);
    if (existing === undefined) {
      result.created++;
      result.changedFiles.push(rel);
      result.filesAdded.push(rel);
      trackChangeByType(result.byType, rel);
    } else {
      result.updated++;
      result.changedFiles.push(rel);
      result.filesModified.push(rel);
      trackChangeByType(result.byType, rel);
    }
  }

  // 3. Prune empty directories (bottom-up), but keep root itself.
  pruneEmptyDirs(root, root);

  return result;
}

/** Categorize a file path into its type for the breakdown. */
function trackChangeByType(byType: ChangeBreakdown, relPath: string): void {
  // Sync files (special case - these are meta-files, not model files)
  if (relPath === "sync-state.json" || relPath === "sync-manifest.json" || relPath === "sync-back-ids.json") {
    byType.manifests++;
    return;
  }
  if (relPath.startsWith("sync-state.json") || relPath.includes("/sync-state.json")) {
    byType.stateFiles++;
    return;
  }

  // Check for model.d.ts (workspace-wide type definitions)
  if (relPath === "model.d.ts") {
    byType.other++;
    return;
  }

  // Check for content files
  const contentFilePatterns = [
    /description\.md$/,
    /details\.md$/,
    /play-function\.ts$/,
    /play-type\.ts$/,
  ];
  if (contentFilePatterns.some(p => p.test(relPath))) {
    byType.contentFiles++;
    return;
  }

  // Check for entity JSON files
  if (relPath.includes("/chapter.json")) {
    byType.chapters++;
  } else if (relPath.includes("/slice.json")) {
    byType.slices++;
  } else if (relPath.includes("/lane.json")) {
    byType.lanes++;
  } else if (relPath.includes("/element.json")) {
    byType.elements++;
  } else if (relPath.includes("/milestone.json")) {
    byType.milestones++;
  } else if (relPath.includes("/scenario.json")) {
    byType.scenarios++;
  } else if (relPath.startsWith("html-snippets/") && relPath.endsWith(".json")) {
    byType.htmlSnippets++;
  } else {
    byType.other++;
  }
}

/** Recursively collect all file paths under `dir` (absolute). */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(abs));
    } else if (entry.isFile()) {
      out.push(abs);
    }
    // symlinks and other special files are ignored (owned dir should contain none)
  }
  return out;
}

/** Remove empty directories under `dir`, bottom-up. Never removes `keep` (the root). */
function pruneEmptyDirs(dir: string, keep: string): boolean {
  let empty = true;
  if (!existsSync(dir)) return true;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      const childEmpty = pruneEmptyDirs(abs, keep);
      if (childEmpty) {
        rmSync(abs, { recursive: true, force: true });
      } else {
        empty = false;
      }
    } else {
      empty = false;
    }
  }
  return empty && dir !== keep;
}

export function readIfExists(abs: string): string | undefined {
  try {
    if (!existsSync(abs) || !statSync(abs).isFile()) return undefined;
    return readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
}

/** True if `abs` is `root` or inside it (no escape via `..`). */
function isInside(root: string, abs: string): boolean {
  if (abs === root) return true;
  const rel = relative(root, abs);
  return rel.length > 0 && !rel.startsWith("..") && !rel.startsWith(`..${sep}`);
}

/**
 * Write workspace-wide model.d.ts for TypeScript IDE support.
 * This generates a single file at `.spec-stream/model.d.ts` that aggregates
 * all chapters' type definitions, enabling autocomplete and type checking in the IDE.
 */
export function writeModelDts(rootDir: string, state: ModelState): void {
  const modelDtsPath = join(rootDir, "model.d.ts");
  const content = buildWorkspaceModelDts(state);
  
  // Check if content actually changed before writing (diff-based)
  const existing = readIfExists(modelDtsPath);
  if (existing === content) {
    return; // No change, skip write
  }
  
  writeFileSync(modelDtsPath, content, "utf8");
}
