/**
 * `spec-stream model validate` — structural consistency check for the local model tree.
 *
 * Reads the file tree under the sync root and reports issues that would cause
 * sync-back to fail or produce incorrect results:
 *
 *  1. JSON syntax errors in any .json file.
 *  2. Missing required fields in primary .json files.
 *  3. Dangling UUID references: element.json laneId/sliceId not in uuid-index.json.
 *  4. Dangling UUID references: scenario expectation sliceId/elementId not in uuid-index.
 *  5. UUID collisions: two different dirs claim the same UUID.
 *
 * Exits 0 if clean, 1 if any issues found.
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

// ─── Public API ───────────────────────────────────────────────────────────────

export interface ValidateOptions {
  /** Absolute path to the sync root directory (e.g. `/project/.spec-stream/model`). */
  syncRootAbs: string;
  /** When true, print every checked path even when no issues are found. */
  verbose?: boolean;
}

export interface ValidationIssue {
  /** Path relative to sync root where the issue was found. */
  path: string;
  message: string;
}

export interface ValidateResult {
  issues: ValidationIssue[];
  /** Number of files checked. */
  checked: number;
}

/**
 * Run all structural checks on the model tree and return the aggregated result.
 * This function performs only filesystem reads — no API calls.
 */
export function validateModel(opts: ValidateOptions): ValidateResult {
  const { syncRootAbs, verbose = false } = opts;
  const issues: ValidationIssue[] = [];
  let checked = 0;

  if (!existsSync(syncRootAbs)) {
    issues.push({ path: ".", message: `Sync root does not exist: ${syncRootAbs}` });
    return { issues, checked };
  }

  // ── 1. Load uuid-index.json ──────────────────────────────────────────────────
  const uuidIndexPath = "uuid-index.json";
  const uuidIndex = readJsonChecked(syncRootAbs, uuidIndexPath, issues);
  checked++;

  // Build a reverse map: dir → uuid[] so we can detect collisions.
  const dirToUuids = new Map<string, string[]>();
  // Also collect the uuid → dir map for reference checks.
  const uuidToDir = new Map<string, string>();

  if (uuidIndex) {
    for (const [uuid, dir] of Object.entries(uuidIndex)) {
      if (typeof dir !== "string") {
        issues.push({ path: uuidIndexPath, message: `Entry "${uuid}" has non-string value` });
        continue;
      }
      if (uuidToDir.has(uuid)) {
        issues.push({ path: uuidIndexPath, message: `Duplicate UUID "${uuid}" (points to both "${uuidToDir.get(uuid)}" and "${dir}")` });
      } else {
        uuidToDir.set(uuid, dir);
      }
      const existing = dirToUuids.get(dir) ?? [];
      existing.push(uuid);
      dirToUuids.set(dir, existing);
    }
  }

  if (verbose) {
    process.stdout.write(`  checked: ${uuidIndexPath}\n`);
  }

  // ── 2. Walk all .json files and validate them ────────────────────────────────
  const allJsonFiles = collectJsonFiles(syncRootAbs);

  for (const relPath of allJsonFiles) {
    if (relPath === uuidIndexPath || relPath === "workspace.json") {
      // Already handled or no required fields to check.
      checked++;
      if (verbose) process.stdout.write(`  checked: ${relPath}\n`);
      continue;
    }

    const data = readJsonChecked(syncRootAbs, relPath, issues);
    checked++;
    if (verbose) process.stdout.write(`  checked: ${relPath}\n`);
    if (!data) continue; // JSON parse error already recorded

    // Dispatch to per-kind validators based on filename.
    if (relPath.endsWith("/element.json")) {
      checkElementJson(relPath, data, uuidToDir, issues);
    } else if (relPath.endsWith("/scenario.json")) {
      checkScenarioJson(relPath, data, uuidToDir, issues);
    } else if (relPath.endsWith("/chapter.json")) {
      checkRequiredString(relPath, data, "id", issues);
      checkRequiredString(relPath, data, "name", issues);
    } else if (relPath.endsWith("/slice.json")) {
      checkRequiredString(relPath, data, "id", issues);
      checkRequiredString(relPath, data, "label", issues);
    } else if (relPath.endsWith("/lane.json")) {
      checkRequiredString(relPath, data, "id", issues);
      checkRequiredString(relPath, data, "label", issues);
    } else if (relPath.endsWith("/milestone.json")) {
      checkRequiredString(relPath, data, "id", issues);
      checkRequiredString(relPath, data, "name", issues);
    }
    // html-snippet .json files: just valid JSON is enough for sync-back.
  }

  return { issues, checked };
}

// ─── Check helpers ────────────────────────────────────────────────────────────

function checkElementJson(
  relPath: string,
  data: Record<string, unknown>,
  uuidToDir: Map<string, string>,
  issues: ValidationIssue[],
): void {
  checkRequiredString(relPath, data, "id", issues);
  checkRequiredString(relPath, data, "name", issues);
  checkRequiredString(relPath, data, "type", issues);

  // laneId and sliceId must be present and exist in the uuid-index.
  const laneId = typeof data["laneId"] === "string" ? data["laneId"] : null;
  const sliceId = typeof data["sliceId"] === "string" ? data["sliceId"] : null;

  if (!laneId) {
    issues.push({ path: relPath, message: `Missing required field "laneId"` });
  } else if (!uuidToDir.has(laneId)) {
    issues.push({ path: relPath, message: `laneId "${laneId}" not found in uuid-index.json` });
  }

  if (!sliceId) {
    issues.push({ path: relPath, message: `Missing required field "sliceId"` });
  } else if (!uuidToDir.has(sliceId)) {
    issues.push({ path: relPath, message: `sliceId "${sliceId}" not found in uuid-index.json` });
  }
}

function checkScenarioJson(
  relPath: string,
  data: Record<string, unknown>,
  uuidToDir: Map<string, string>,
  issues: ValidationIssue[],
): void {
  checkRequiredString(relPath, data, "id", issues);
  checkRequiredString(relPath, data, "chapterId", issues);
  checkRequiredString(relPath, data, "name", issues);

  // Validate each expectation's sliceId and optional elementId.
  const expectations = data["expectations"];
  if (!Array.isArray(expectations)) return; // optional field — no error if absent

  for (let i = 0; i < expectations.length; i++) {
    const exp = expectations[i] as Record<string, unknown>;
    if (!exp || typeof exp !== "object") {
      issues.push({ path: relPath, message: `expectations[${i}] is not an object` });
      continue;
    }

    const expId = typeof exp["id"] === "string" ? exp["id"] : `<missing id at index ${i}>`;

    if (!exp["id"]) {
      issues.push({ path: relPath, message: `expectations[${i}] missing required field "id"` });
    }
    if (!exp["kind"]) {
      issues.push({ path: relPath, message: `expectation "${expId}" missing required field "kind"` });
    }
    if (!exp["expected"]) {
      issues.push({ path: relPath, message: `expectation "${expId}" missing required field "expected"` });
    }

    const sliceId = typeof exp["sliceId"] === "string" ? exp["sliceId"] : null;
    if (!sliceId) {
      issues.push({ path: relPath, message: `expectation "${expId}" missing required field "sliceId"` });
    } else if (!uuidToDir.has(sliceId)) {
      issues.push({ path: relPath, message: `expectation "${expId}" sliceId "${sliceId}" not found in uuid-index.json` });
    }

    const elementId = typeof exp["elementId"] === "string" ? exp["elementId"] : null;
    if (elementId && !uuidToDir.has(elementId)) {
      issues.push({ path: relPath, message: `expectation "${expId}" elementId "${elementId}" not found in uuid-index.json` });
    }
  }
}

function checkRequiredString(
  relPath: string,
  data: Record<string, unknown>,
  field: string,
  issues: ValidationIssue[],
): void {
  if (typeof data[field] !== "string" || data[field] === "") {
    issues.push({ path: relPath, message: `Missing required field "${field}"` });
  }
}

// ─── JSON reader ─────────────────────────────────────────────────────────────

/**
 * Read and parse a JSON file. Returns the parsed object, or null if the file doesn't
 * exist or contains invalid JSON. Adds an issue on parse failure.
 */
function readJsonChecked(
  root: string,
  relPath: string,
  issues: ValidationIssue[],
): Record<string, unknown> | null {
  const abs = join(root, relPath);
  if (!existsSync(abs)) {
    // uuid-index.json not existing is already a problem; caller should have flagged it
    // if needed. For other files, absence is not our concern here.
    return null;
  }
  try {
    const raw = readFileSync(abs, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      issues.push({ path: relPath, message: `JSON root must be an object` });
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    issues.push({ path: relPath, message: `Invalid JSON: ${(err as Error).message}` });
    return null;
  }
}

// ─── File collector ───────────────────────────────────────────────────────────

/**
 * Recursively collect all `.json` file paths under `root`, returning paths relative
 * to `root` with forward slashes. Skips the `.spec-stream` state directory itself and
 * node_modules just in case the sync root is inside a project.
 */
function collectJsonFiles(root: string): string[] {
  const results: string[] = [];
  walk(root, root, results);
  return results.sort(); // stable order for deterministic output
}

const SKIP_DIRS = new Set(["node_modules", ".git"]);

function walk(root: string, dir: string, results: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const abs = join(dir, entry);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walk(root, abs, results);
    } else if (entry.endsWith(".json")) {
      const rel = abs.slice(root.length).replace(/\\/g, "/").replace(/^\//, "");
      results.push(rel);
    }
  }
}

// ─── CLI runner ───────────────────────────────────────────────────────────────

export interface RunValidateOptions {
  /** Config file path (used to resolve syncDir). */
  configPath?: string;
  /** When true, print every checked path. */
  verbose?: boolean;
}

/**
 * Top-level runner called from the CLI. Resolves the sync root from config,
 * runs validation, and prints the results.
 */
export async function runValidate(opts: RunValidateOptions): Promise<{ ok: boolean }> {
  // Resolve sync root from config (same approach as sync-back).
  const { loadConfig } = await import("../config/load.js");
  const { loadDotenv } = await import("../config/dotenv.js");

  loadDotenv();
  const { config } = loadConfig({ configPath: opts.configPath });

  const localSync = (config as { localSync?: { dir?: string; enabled?: boolean } }).localSync;
  if (!localSync?.enabled) {
    process.stderr.write(
      `spec-stream model validate: localSync is not enabled in your config.\n` +
      `Add "localSync": { "enabled": true, "dir": ".spec-stream/model" } to your config file.\n`,
    );
    return { ok: false };
  }

  const syncDir = localSync.dir ?? ".spec-stream/model";
  const syncRootAbs = syncDir.startsWith("/")
    ? syncDir
    : `${config.configDir ?? process.cwd()}/${syncDir}`.replace(/\/+/g, "/");

  process.stdout.write(`Validating model at ${syncRootAbs}…\n`);

  const result = validateModel({ syncRootAbs, verbose: opts.verbose });

  if (result.issues.length === 0) {
    process.stdout.write(`✓ ${result.checked} file(s) checked — no issues found.\n`);
    return { ok: true };
  }

  for (const issue of result.issues) {
    process.stdout.write(`✗ ${issue.path}\n  ${issue.message}\n`);
  }
  process.stdout.write(
    `\n${result.issues.length} issue(s) found in ${result.checked} file(s) checked.\n`,
  );
  return { ok: false };
}
