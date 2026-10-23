/**
 * sync-back command.
 *
 * Walks the local model directory, diffs it against the last-known manifest state
 * (sync-manifest.json written by sync, sync-back-ids.json written by previous
 * sync-back runs), builds API operations from the diff, and executes them against
 * the prooph board REST API.
 *
 * No git dependency — works whether or not the model directory is tracked by git,
 * gitignored, or git is not installed.
 *
 * Can be called from a git pre-commit hook (optional) or run manually at any time:
 *
 *   spec-stream sync-back [--dry-run] [--verbose]
 */

import { resolve } from "node:path";
import { loadConfig, resolveApiKey } from "../config/load.js";
import { loadDotenv } from "../config/dotenv.js";
import { ConfigError } from "../config/schema.js";
import { RestClient } from "../sync/restClient.js";
import { computeManifestDiff, computeDiskHash, kindFromEntityDir } from "./manifestDiff.js";
import { buildOperations } from "./operationBuilder.js";
import { executeOperations } from "./executor.js";
import type { Scenario } from "@proophboard/exploration-runtime";
import {
  loadManifest,
  saveManifest,
  syncBackIdsPath,
  syncManifestPath,
  readEntityFields,
  readEntityContentHashes,
  type ManifestEntry,
  type ScenarioExpectationSnapshot,
  type ScenarioInteractionSnapshot,
} from "./manifest.js";
import { resolvePaths, createSyncBackLock, removeSyncBackLock } from "../lifecycle/paths.js";

export interface SyncBackOptions {
  /** Path to the config file (optional, defaults to discovery). */
  configPath?: string;
  /** When true, log operations but do not call the API. */
  dryRun?: boolean;
  /** Enable verbose output. */
  verbose?: boolean;
  /** Working directory (defaults to process.cwd()). */
  cwd?: string;
  /** Override fetch implementation (for testing). */
  fetchImpl?: typeof fetch;
  /** When true, skip pre-sync validation/typecheck/scenario-test checks. */
  omitChecks?: boolean;
}

export interface SyncBackResult {
  /** Number of operations that were executed (or would be, in dry-run). */
  operationCount: number;
  /** Number of successfully executed operations. */
  executed: number;
  /** Number of skipped operations (dry-run). */
  skipped: number;
  /** Number of failed operations. */
  failed: number;
  errors: Array<{ operation: unknown; error: string }>;
}

/**
 * Run the sync-back command.
 *
 * Loads config, computes manifest diff, builds operations, executes them.
 * After execution, persists new entity ids to sync-back-ids.json so the next
 * run can identify those entities without needing the sync process to have
 * processed the corresponding changelog events yet.
 *
 * Returns a result summary. Throws on fatal errors (bad config, etc.).
 */
export async function runSyncBack(opts: SyncBackOptions = {}): Promise<SyncBackResult> {
  const cwd = opts.cwd ?? process.cwd();
  const dryRun = opts.dryRun ?? false;
  const verbose = opts.verbose ?? false;

  const log = (msg: string) => {
    process.stdout.write(msg + "\n");
  };
  const debug = verbose ? log : (_msg: string) => {};

  // ─── Load config ────────────────────────────────────────────────────────
  loadDotenv(cwd);
  if (opts.configPath) loadDotenv(resolve(cwd, opts.configPath, ".."));

  let loaded;
  try {
    loaded = loadConfig({ configPath: opts.configPath });
  } catch (err) {
    if (err instanceof ConfigError) throw new Error(`Config error: ${err.message}`);
    throw err;
  }
  const { config } = loaded;

  // ─── Validate localSync config ───────────────────────────────────────────
  if (!config.localSync?.enabled) {
    throw new Error(
      "sync-back requires localSync to be enabled in proophboard.spec-stream.json. " +
      "Add: { \"localSync\": { \"enabled\": true, \"dir\": \".spec-stream/model\" } }",
    );
  }

  // ─── Create lock file FIRST (before anything else, except dry-run) ───────
  // The lock file is the first operation sync-back does.
  // It stays in place if sync-back fails, preventing sync from running.
  const syncDir = config.localSync.dir ?? ".spec-stream/model";
  const syncDirAbs = resolve(cwd, syncDir);
  const paths = resolvePaths({
    configDir: config.configDir,
    logDirOverride: config.logDir,
    stateDirOverride: config.stateDir,
  });

  if (!dryRun) {
    createSyncBackLock(paths);
    debug(`Lock file created: ${paths.syncBackLockFile}`);
  }

  debug(`Sync root: ${syncDirAbs}`);

  // ─── Pre-sync checks (unless omitted) ─────────────────────────────────────
  if (!opts.omitChecks) {
    await runPreSyncChecks(syncDirAbs, { verbose, log, dryRun });
  } else {
    debug("Skipping pre-sync checks (--omit-checks)");
  }

  // ─── API key ─────────────────────────────────────────────────────────────
  let apiKey: string;
  try {
    apiKey = resolveApiKey();
  } catch (err) {
    if (err instanceof ConfigError) throw new Error(`Config error: ${err.message}`);
    throw err;
  }

  // ─── Compute manifest diff ────────────────────────────────────────────────
  const diffs = computeManifestDiff({ syncRootAbs: syncDirAbs });

  debug(`Found ${diffs.length} changed entity/entities`);

  if (diffs.length === 0) {
    log("No changes detected — nothing to sync back.");
    // No changes - remove lock and return early
    if (!dryRun) {
      removeSyncBackLock(paths);
      debug(`Lock file removed (no changes): ${paths.syncBackLockFile}`);
    }
    return { operationCount: 0, executed: 0, skipped: 0, failed: 0, errors: [] };
  }

  if (verbose) {
    for (const d of diffs) {
      debug(`  ${d.status.toUpperCase().padEnd(6)} ${d.kind} @ ${d.entityDir}`);
    }
  }

  // ─── Build operations ─────────────────────────────────────────────────────
  const operations = await buildOperations({ syncRootAbs: syncDirAbs, diffs });

  if (operations.length === 0) {
    log("No sync-back operations to perform.");
    // No operations - remove lock and return early
    if (!dryRun) {
      removeSyncBackLock(paths);
      debug(`Lock file removed (no operations): ${paths.syncBackLockFile}`);
    }
    return { operationCount: 0, executed: 0, skipped: 0, failed: 0, errors: [] };
  }

  log(`${dryRun ? "[dry-run] " : ""}Syncing ${operations.length} operation(s) back to prooph board…`);

  // ─── Execute ──────────────────────────────────────────────────────────────
  const client = new RestClient({
    endpoint: config.endpoint,
    apiKey,
    fetchImpl: opts.fetchImpl,
  });

  const execResult = await executeOperations(client, operations, { dryRun, log });

  // ─── Persist state to sync-back-ids.json ─────────────────────────────────
  // Write new ids from creates AND updated content hashes for updates/renames.
  // This allows the next sync-back run to skip entities whose content hasn't
  // changed, rather than emitting update operations for every entity on disk.
  // Not written in dry-run mode.
  if (!dryRun) {
    const idsPath = syncBackIdsPath(syncDirAbs);
    const existing = loadManifest(idsPath);
    let wrote = 0;

    for (const diff of diffs) {
      if (diff.status === "delete") continue; // deletes remove from manifest — sync handles this

      // Skip if any operation for this entity failed. This ensures the next sync-back
      // run retries the failed operations rather than silently treating the entity as
      // up-to-date (which would happen if we advanced the content hash here).
      if (execResult.failedEntityDirs.has(diff.entityDir)) {
        debug(`Skipping manifest update for ${diff.entityDir} (operation failed — will retry next run)`);
        continue;
      }

      const id = diff.id ?? execResult.newIds.get(diff.entityDir);
      if (!id) continue; // create failed — no id returned, skip

      // Compute current disk hash and fields snapshot for next-run change detection.
      const hash = computeDiskHash(syncDirAbs, diff.entityDir, diff.kind);
      const fields = readEntityFields(syncDirAbs, diff.entityDir, diff.kind);
      const contentHashes = readEntityContentHashes(syncDirAbs, diff.entityDir);

      const entry: ManifestEntry = {
        id,
        hash,
        ...(Object.keys(fields).length > 0 && { fields }),
        ...(Object.keys(contentHashes).length > 0 && { contentHashes }),
      };

      // For scenarios, persist the current expectations and interactions arrays so the
      // next sync-back run can diff against them.
      if (diff.kind === "scenario") {
        const scenarioJson = readScenarioJson(syncDirAbs, diff.entityDir);
        if (scenarioJson !== null) {
          const extra: ManifestEntry["extra"] = {};
          if (scenarioJson.expectations !== null) extra.expectations = scenarioJson.expectations;
          if (scenarioJson.interactions !== null) extra.interactions = scenarioJson.interactions;
          if (Object.keys(extra).length > 0) entry.extra = extra;
        }
      }

      existing.entities[diff.entityDir] = entry;
      wrote++;
    }

    // ── GC: remove stale sync-back-ids entries superseded by sync-manifest ──────
    // When the sync process renames an entity directory on disk (because the board
    // sent back an element-renamed / chapter-renamed / etc. event after sync-back
    // pushed the rename), it updates sync-manifest.json to the new dir but leaves
    // the old entry in sync-back-ids.json.  On the next run, both dirs appear in the
    // merged manifest while only the new dir exists on disk — causing a spurious
    // delete.  computeManifestDiff already guards against this, but we also GC here
    // so the stale entry doesn't accumulate forever.
    //
    // We also handle the case where an entity was deleted externally (on the board or
    // via the local model being updated by sync): sync removes the entry from
    // sync-manifest.json and deletes the local file.  sync-back-ids.json still holds
    // the old entry, causing a spurious delete operation on every subsequent run (the
    // API returns 404/500 since the entity is already gone).  If an id is absent from
    // sync-manifest AND its directory no longer exists on disk, the entity is gone —
    // clean up the stale sync-back-ids entry so we stop retrying.
    const syncManifest = loadManifest(syncManifestPath(syncDirAbs));
    // Build a map from id → canonical dir according to sync-manifest.
    const manifestIdToDir = new Map<string, string>();
    for (const [dir, entry] of Object.entries(syncManifest.entities)) {
      manifestIdToDir.set(entry.id, dir);
    }
    let gcCount = 0;
    for (const [dir, entry] of Object.entries(existing.entities)) {
      const canonicalDir = manifestIdToDir.get(entry.id);
      if (canonicalDir !== undefined && canonicalDir !== dir) {
        // sync-manifest tracks this id under a different (newer) directory —
        // this sync-back-ids entry is stale; remove it.
        delete existing.entities[dir];
        gcCount++;
        continue;
      }
      if (canonicalDir === undefined) {
        // This id is not in sync-manifest at all. Check whether the entity
        // still exists on disk. If it doesn't, the entity was deleted externally
        // (board-side deletion processed by sync) — the sync-back-ids entry is stale.
        //
        // HTML snippets have a flat layout — html-snippets/<slug>.json (+ .html) —
        // so their entityDir is a virtual path with no backing directory. Check for
        // the primary .json file (which is also what identifies the entity to
        // walkDiskEntities) instead of the directory.
        const exists =
          kindFromEntityDir(dir) === "html-snippet"
            ? existsSync(join(syncDirAbs, `${dir}.json`))
            : existsSync(join(syncDirAbs, dir));
        if (!exists) {
          delete existing.entities[dir];
          gcCount++;
          debug(`GC: removed stale sync-back-ids entry for externally deleted entity @ ${dir}`);
        }
      }
    }
    if (gcCount > 0) {
      wrote += gcCount; // ensure we save
      debug(`GC: removed ${gcCount} stale sync-back-ids entr${gcCount === 1 ? "y" : "ies"} superseded by sync-manifest`);
    }

    if (wrote > 0) {
      existing.updatedAt = new Date().toISOString();
      try {
        saveManifest(idsPath, existing);
        debug(`Updated sync-back-ids.json: ${wrote} entry/entries`);
      } catch (err) {
        log(`Warning: could not write sync-back-ids.json: ${(err as Error).message}`);
      }
    }
  }

  // ─── Summary ──────────────────────────────────────────────────────────────
  const total = operations.length;
  let success = false;
  if (dryRun) {
    log(`Done (dry-run): ${total} operation(s) would be executed.`);
    success = true; // dry-run always succeeds
  } else {
    const parts: string[] = [];
    if (execResult.executed > 0) parts.push(`${execResult.executed} succeeded`);
    if (execResult.failed > 0) parts.push(`${execResult.failed} failed`);
    log(`Done: ${parts.join(", ")}.`);
    success = execResult.failed === 0;
  }

  // Remove lock file only if successful (not dry-run and no failures)
  if (!dryRun && success) {
    removeSyncBackLock(paths);
    debug(`Lock file removed: ${paths.syncBackLockFile}`);
  } else if (!dryRun && !success) {
    log(`Lock file remains at ${paths.syncBackLockFile} - sync-back did not complete successfully.`);
  }

  return {
    operationCount: total,
    executed: execResult.executed,
    skipped: execResult.skipped,
    failed: execResult.failed,
    errors: execResult.errors,
  };
}

// ─── Pre-sync checks ──────────────────────────────────────────────────────────

/**
 * Run all pre-sync checks: validate, typecheck, and scenario test.
 * Throws on any failure.
 */
async function runPreSyncChecks(
  syncRootAbs: string,
  ctx: { verbose: boolean; log: (msg: string) => void; dryRun: boolean }
): Promise<void> {
  const { verbose, log, dryRun } = ctx;

  // ─── 1. Model validation ──────────────────────────────────────────────────
  log(`${dryRun ? "[dry-run] " : ""}Running model validation...`);
  const validateResult = import("./validate.js").then(({ validateModel }) =>
    validateModel({ syncRootAbs, verbose })
  );
  const result = await validateResult;
  if (result.issues.length > 0) {
    log("  Issues found:");
    for (const issue of result.issues) {
      log(`    ${issue.path}: ${issue.message}`);
    }
    throw new Error("Model validation failed. Fix issues before syncing back.");
  }
  log(`  ✓ ${result.checked} file(s) checked — no issues found.`);

  // ─── 2. Typecheck ─────────────────────────────────────────────────────────
  log(`${dryRun ? "[dry-run] " : ""}Running typecheck on play functions...`);
  const { typecheckChapter } = await import("./../scenario/typecheck.js");
  const { loadChapterFromDisk } = await import("./../scenario/loadChapter.js");
  const { readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const chaptersRoot = join(syncRootAbs, "chapters");

  let hasTypeErrors = false;
  let chaptersDirs: string[] = [];
  try {
    chaptersDirs = await readdir(chaptersRoot);
    for (const dirName of chaptersDirs) {
      const chapterDir = join(chaptersRoot, dirName);
      const chapterJsonPath = join(chapterDir, "chapter.json");
      if (!existsSync(chapterJsonPath)) continue;

      try {
        const chapter = await loadChapterFromDisk(chapterDir);
        const diags = await typecheckChapter(chapter);
        if (diags.length > 0) {
          hasTypeErrors = true;
          for (const d of diags) {
            log(`  ✗ ${d.elementName} (${d.elementId})`);
            log(`    [${d.kind}] ${d.line}:${d.col}  TS${d.code}: ${d.message}`);
          }
        }
      } catch (err) {
        hasTypeErrors = true;
        log(`  ✗ Error loading chapter ${dirName}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    hasTypeErrors = true;
    log(`  ✗ Error scanning chapters: ${(err as Error).message}`);
  }
  if (hasTypeErrors) {
    throw new Error("Typecheck failed. Fix type errors before syncing back.");
  }
  log(`  ✓ No type errors found.`);

  // ─── 3. Scenario test ─────────────────────────────────────────────────────
  log(`${dryRun ? "[dry-run] " : ""}Running scenario tests...`);
  const { runAllScenarios } = await import("@proophboard/exploration-runtime");
  const { transpileHandlers } = await import("./../scenario/transpile.js");
  const { loadScenarioFromDisk } = await import("./../scenario/loadScenario.js");

  let hasBroken = false;
  let neutralCount = 0;
  let scenarioCount = 0;
  // Capture verbose runtime console.log output per-chapter so we only show it
  // when a scenario is broken — avoids polluting agent context on every run.
  const brokenChapterLogs: Array<{ chapterDir: string; log: string }> = [];
  try {
    for (const dirName of chaptersDirs) {
      const chapterDir = join(chaptersRoot, dirName);
      const chapterJsonPath = join(chapterDir, "chapter.json");
      if (!existsSync(chapterJsonPath)) continue;

      try {
        const chapter = await loadChapterFromDisk(chapterDir);
        const scenariosDir = join(chapterDir, "scenarios");
        if (!existsSync(scenariosDir)) continue;

        const scenarioDirs = await readdir(scenariosDir);
        const scenarios: Scenario[] = [];

        for (const sDir of scenarioDirs) {
          const sPath = join(scenariosDir, sDir, "scenario.json");
          if (!existsSync(sPath)) continue;

          const scenario = await loadScenarioFromDisk(sPath.replace("/scenario.json", ""));
          scenarios.push(scenario);
        }

        if (scenarios.length > 0) {
          const { handlers } = await transpileHandlers(chapter);

          // Capture runtime console.log output for this chapter.
          const captured: string[] = [];
          const origLog = console.log;
          console.log = (...args: unknown[]) => {
            captured.push(args.map(String).join(" "));
          };
          let results: Awaited<ReturnType<typeof runAllScenarios>>;
          try {
            results = runAllScenarios(chapter, scenarios, handlers);
          } finally {
            console.log = origLog;
          }
          scenarioCount += results.length;

          let chapterHasBroken = false;
          for (const r of results) {
            if (r.status === "broken") {
              hasBroken = true;
              chapterHasBroken = true;
            } else if (r.status === "neutral") neutralCount++;
          }

          // Only keep captured output for chapters with broken scenarios.
          if (chapterHasBroken && captured.length > 0) {
            brokenChapterLogs.push({ chapterDir: dirName, log: captured.join("\n") });
          }
        }
      } catch (err) {
        log(`  ✗ Error loading chapter ${dirName}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    log(`  ✗ Error scanning scenarios: ${(err as Error).message}`);
    hasBroken = true;
  }

  if (hasBroken) {
    // Show captured runtime output only for chapters with broken scenarios.
    for (const { chapterDir: dirName, log: captured } of brokenChapterLogs) {
      log(`  ── Runtime output for chapter ${dirName} ──`);
      log(`  ${captured}`);
    }
    throw new Error("Scenario tests failed. Fix broken expectations before syncing back.");
  }
  if (neutralCount > 0) {
    log(`  ${neutralCount} scenario(s) with no pinned expectations.`);
  }
  log(`  ${scenarioCount} scenario(s) checked.`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Read expectations and interactions from a scenario.json on disk.
 * Returns an object with both arrays (possibly empty) if the file exists,
 * or null if the file is missing or unreadable.
 */
function readScenarioJson(
  syncRootAbs: string,
  entityDir: string,
): { expectations: ScenarioExpectationSnapshot[]; interactions: ScenarioInteractionSnapshot[] } | null {
  try {
    const absPath = join(syncRootAbs, entityDir, "scenario.json");
    if (!existsSync(absPath)) return null;
    const parsed = JSON.parse(readFileSync(absPath, "utf8")) as {
      expectations?: unknown[];
      interactions?: unknown[];
    };
    return {
      expectations: Array.isArray(parsed.expectations)
        ? (parsed.expectations as ScenarioExpectationSnapshot[])
        : [],
      interactions: Array.isArray(parsed.interactions)
        ? (parsed.interactions as ScenarioInteractionSnapshot[])
        : [],
    };
  } catch {
    return null;
  }
}
