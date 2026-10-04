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

export interface WriteResult {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
}

/**
 * Make `rootDir` exactly match `tree`. Creates/updates changed files, deletes files not in
 * the tree, and prunes empty directories. Returns counts for logging.
 */
export function writeTree(rootDir: string, tree: DesiredTree): WriteResult {
  const root = resolve(rootDir);
  mkdirSync(root, { recursive: true });

  const result: WriteResult = { created: 0, updated: 0, deleted: 0, unchanged: 0 };

  // Desired absolute paths, validated to stay within root.
  const desired = new Map<string, string>();
  for (const [rel, content] of tree) {
    const abs = resolve(root, rel);
    if (!isInside(root, abs)) {
      // Defensive: skip anything that would escape the owned directory.
      continue;
    }
    desired.set(abs, content);
  }

  // 1. Delete files on disk that are not desired.
  for (const abs of listFiles(root)) {
    if (!desired.has(abs)) {
      rmSync(abs, { force: true });
      result.deleted++;
    }
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
    if (existing === undefined) result.created++;
    else result.updated++;
  }

  // 3. Prune empty directories (bottom-up), but keep root itself.
  pruneEmptyDirs(root, root);

  return result;
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

function readIfExists(abs: string): string | undefined {
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
