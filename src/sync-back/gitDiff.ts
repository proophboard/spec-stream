/**
 * Git diff reader for the sync-back command.
 *
 * Runs `git diff --cached --name-status -M` to compare the index (staged files) against
 * a base commit (default: HEAD). This is the correct diff for a pre-commit hook, where
 * files are staged but not yet committed.
 *
 * Pass `toCommit` to diff two commits instead of comparing against the index (useful for
 * manual runs or testing: `fromCommit=HEAD~1 toCommit=HEAD` to diff the last commit).
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
  /**
   * Base commit to diff against. Defaults to `"HEAD"`.
   *
   * In the default (staged) mode this is the commit the index is compared to.
   * When `toCommit` is also set, both are treated as commit refs and `--cached` is not used.
   */
  fromCommit?: string;
  /**
   * Target commit. When omitted (default), the diff compares the index (staged files)
   * against `fromCommit` using `git diff --cached`. When set, both `fromCommit` and
   * `toCommit` are passed as positional refs without `--cached`.
   */
  toCommit?: string;
  /** Override the git working directory. Defaults to process.cwd(). */
  cwd?: string;
}

/**
 * Read changed files in `syncDir` using `git diff --name-status -M`.
 *
 * Default behaviour (pre-commit hook): compares the index (staged files) against
 * `fromCommit` (default `HEAD`) using `git diff --cached`. This is what you want in a
 * pre-commit hook where files are staged but not yet committed.
 *
 * When `toCommit` is provided the diff is between two commits (`fromCommit..toCommit`)
 * without `--cached`, which is useful for manual runs or testing.
 *
 * Returns only files that are under `syncDir` (relative to the repo root), with paths
 * converted to be relative to `syncDir` using forward slashes.
 *
 * Throws if git is not available or the diff fails.
 */
export async function readGitDiff(opts: GitDiffOptions): Promise<FileChange[]> {
  const cwd = opts.cwd ?? process.cwd();
  const fromCommit = opts.fromCommit ?? "HEAD";
  const stagedMode = opts.toCommit === undefined;

  // Get the repository root so we can compute paths relative to sync dir.
  const { stdout: rootOut } = await execFileAsync(
    "git",
    ["rev-parse", "--show-toplevel"],
    { cwd },
  );
  const repoRoot = rootOut.trim();

  // Build the git diff arguments.
  // Staged mode: `git diff --cached --name-status -M --diff-filter=AMDR <fromCommit> --`
  // Commit range: `git diff --name-status -M --diff-filter=AMDR <fromCommit> <toCommit> --`
  const diffArgs: string[] = ["diff", "--name-status", "-M", "--diff-filter=AMDR"];
  if (stagedMode) {
    diffArgs.push("--cached");
  }
  diffArgs.push(fromCommit);
  if (!stagedMode) {
    diffArgs.push(opts.toCommit!);
  }
  diffArgs.push("--");

  const { stdout } = await execFileAsync("git", diffArgs, { cwd });

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
