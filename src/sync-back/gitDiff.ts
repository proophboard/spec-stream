/**
 * Git diff reader for the sync-back command.
 *
 * Runs `git diff --name-status -M` between two commits (default: HEAD~1..HEAD) and
 * returns a structured list of file changes within the local sync directory.
 *
 * Uses rename detection (`-M`) so moving an element directory is reported as a rename
 * rather than a delete + add, which the operation builder can map to a move API call.
 *
 * The output paths are relative to the git repository root. The caller is responsible
 * for stripping the sync root prefix to get paths relative to the model root.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { relative, sep } from "node:path";

const execFileAsync = promisify(execFile);

export type ChangeStatus = "A" | "M" | "D" | "R";

export interface FileChange {
  status: ChangeStatus;
  /** Path of the file (relative to the sync root directory). For renames, this is the OLD path. */
  path: string;
  /** For renames, the NEW path (relative to sync root). Undefined for A/M/D. */
  newPath?: string;
}

export interface GitDiffOptions {
  /** The local sync directory (absolute or relative to cwd). E.g. `.spec-stream/model`. */
  syncDir: string;
  /** Base commit. Defaults to HEAD~1. */
  fromCommit?: string;
  /** Target commit. Defaults to HEAD. */
  toCommit?: string;
  /** Override the git working directory. Defaults to process.cwd(). */
  cwd?: string;
}

/**
 * Read changed files in `syncDir` between two commits using `git diff --name-status -M`.
 *
 * Returns only files that are under `syncDir` (relative to the repo root), with paths
 * converted to be relative to `syncDir` using forward slashes.
 *
 * Throws if git is not available or the diff fails.
 */
export async function readGitDiff(opts: GitDiffOptions): Promise<FileChange[]> {
  const cwd = opts.cwd ?? process.cwd();
  const fromCommit = opts.fromCommit ?? "HEAD~1";
  const toCommit = opts.toCommit ?? "HEAD";

  // Get the repository root so we can compute paths relative to sync dir.
  const { stdout: rootOut } = await execFileAsync(
    "git",
    ["rev-parse", "--show-toplevel"],
    { cwd },
  );
  const repoRoot = rootOut.trim();

  // Run git diff with rename detection. -M enables rename detection (default threshold 50%).
  // --diff-filter=AMDR limits to Added, Modified, Deleted, Renamed.
  const { stdout } = await execFileAsync(
    "git",
    [
      "diff",
      "--name-status",
      "-M",
      "--diff-filter=AMDR",
      `${fromCommit}`,
      `${toCommit}`,
      "--",
    ],
    { cwd },
  );

  // Compute syncDir relative to repo root (as a posix prefix we can test paths against).
  const syncDirAbs = resolveSyncDir(cwd, opts.syncDir);
  const syncDirRelToRepo = relative(repoRoot, syncDirAbs).replace(/\\/g, "/");
  const prefix = syncDirRelToRepo.endsWith("/") ? syncDirRelToRepo : syncDirRelToRepo + "/";

  const changes: FileChange[] = [];

  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = parts[0]?.trim();

    if (!status) continue;

    if (status === "A" || status === "M" || status === "D") {
      const filePath = parts[1]?.trim();
      if (!filePath) continue;
      const rel = stripPrefix(filePath, prefix);
      if (rel === null) continue;
      changes.push({ status: status as ChangeStatus, path: rel });
    } else if (status.startsWith("R")) {
      // R100\told/path\tnew/path
      const oldPath = parts[1]?.trim();
      const newPath = parts[2]?.trim();
      if (!oldPath || !newPath) continue;
      const oldRel = stripPrefix(oldPath, prefix);
      const newRel = stripPrefix(newPath, prefix);
      // Only include if at least the old or new path is in the sync dir.
      if (oldRel === null && newRel === null) continue;
      changes.push({
        status: "R",
        path: oldRel ?? oldPath,
        newPath: newRel ?? newPath,
      });
    }
  }

  return changes;
}

/** Resolve the sync dir to an absolute path. */
function resolveSyncDir(cwd: string, syncDir: string): string {
  if (syncDir.startsWith("/")) return syncDir;
  // On Windows use native sep, but we normalize with posix in the output.
  return `${cwd}${sep}${syncDir}`.replace(/\\/g, "/").replace(/\/+/g, "/");
}

/** Strip prefix from path; return null if the path doesn't start with prefix. */
function stripPrefix(filePath: string, prefix: string): string | null {
  const normalized = filePath.replace(/\\/g, "/");
  if (!normalized.startsWith(prefix)) return null;
  return normalized.slice(prefix.length);
}

/**
 * Read the content of a file as it existed in a specific commit using `git show`.
 *
 * `repoRelPath` must be relative to the repository root (not the sync dir).
 * Returns `null` if the file did not exist in that commit or git fails.
 */
export async function readFileAtCommit(
  repoRelPath: string,
  commit: string,
  cwd: string = process.cwd(),
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["show", `${commit}:${repoRelPath}`],
      { cwd },
    );
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Resolve a sync-root-relative path to a repo-root-relative path.
 * Returns null if git rev-parse fails.
 */
export async function syncRelToRepoRel(
  syncRootAbs: string,
  syncRelPath: string,
  cwd: string = process.cwd(),
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd });
    const repoRoot = stdout.trim();
    const absPath = `${syncRootAbs}/${syncRelPath}`.replace(/\/+/g, "/");
    const rel = absPath.startsWith(repoRoot)
      ? absPath.slice(repoRoot.length).replace(/^\//, "")
      : null;
    return rel;
  } catch {
    return null;
  }
}
