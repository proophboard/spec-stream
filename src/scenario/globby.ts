/**
 * Minimal glob helper using Node.js built-ins. No external dependency.
 *
 * Supports `*` (any single segment) and `**` (zero-or-more segments) wildcards.
 * Returns absolute paths.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Find all files under `root` whose path (relative to `root`) matches `pattern`.
 *
 * @param pattern Glob pattern with `*` / `**` / literal segments (POSIX-style).
 * @param root    Absolute root directory to search from.
 * @returns Sorted absolute paths of matching files.
 */
export async function globby(pattern: string, root: string): Promise<string[]> {
  const segments = pattern.split("/");
  const results: string[] = [];
  await walk(root, segments, 0, results);
  return results.sort();
}

async function walk(
  dir: string,
  segments: string[],
  segIdx: number,
  out: string[],
): Promise<void> {
  if (segIdx >= segments.length) return;

  const seg = segments[segIdx]!;
  const isLast = segIdx === segments.length - 1;

  if (seg === "**") {
    // Match zero segments: continue from the same dir with the rest of the pattern.
    await walk(dir, segments, segIdx + 1, out);
    // Recurse into every subdirectory.
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry);
      try {
        const s = await stat(abs);
        if (s.isDirectory()) {
          await walk(abs, segments, segIdx, out); // stay at ** level
        }
      } catch {
        /* skip */
      }
    }
    return;
  }

  // Literal or `*` segment.
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!matchSeg(seg, entry)) continue;
    const abs = join(dir, entry);
    if (isLast) {
      // The last segment must be a file (we're looking for files, not dirs).
      try {
        const s = await stat(abs);
        if (s.isFile()) out.push(abs);
      } catch {
        /* skip */
      }
    } else {
      // Intermediate segment — descend into directory.
      try {
        const s = await stat(abs);
        if (s.isDirectory()) {
          await walk(abs, segments, segIdx + 1, out);
        }
      } catch {
        /* skip */
      }
    }
  }
}

function matchSeg(pattern: string, name: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === name;
  // Simple wildcard: convert * to regex.
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  return re.test(name);
}
