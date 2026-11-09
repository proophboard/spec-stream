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
  readEntityCommentSnapshots,
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

  // ─── Heal alias dirs from earlier runs ────────────────────────────────────
  // Older versions left the local dir under the client-generated id after a
  // create that the board re-ided (scenario/milestone creates ignore the client
  // id).  sync-back-ids records those dirs as `<local-uuid> → <board-id>`; if
  // such a dir still exists on disk, reconcile it to the board id now — rename
  // the dir (or drop it when the canonical board-id dir was already rendered
  // by sync) and rewrite the primary json's id.  Without this, the stale dir
  // produces ops that reference an id the board never had (404/500).
  if (!dryRun) {
    healAliasDirs(syncDirAbs, { log, debug });
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

  // ─── Reconcile board-assigned ids with local dirs ─────────────────────────
  // Some create endpoints ignore client-supplied ids and assign their own
  // (verified: POST /chapters/{id}/scenarios returns a different UUID than the
  // one in scenario.json).  Leaving the local dir under the client-generated id
  // makes the next sync pull render a second `<board-uuid>` dir for the same
  // entity — the entity then exists twice in the model, and the manifest entry
  // for the alias dir (id = client uuid) later produces a DELETE for an id
  // that never existed on the board.  Rename the local dir to the
  // board-assigned id — or drop it when a live sync already rendered the
  // canonical dir — and rewrite the primary json's id field so local and
  // board state converge on one id.
  const dirRenames = new Map<string, string>();
  if (!dryRun) {
    for (const diff of diffs) {
      if (diff.status !== "create") continue;
      // Chapters contain child entity dirs keyed by their own ids; html
      // snippets are flat files — neither is a simple leaf-dir rename.
      if (diff.kind === "chapter" || diff.kind === "html-snippet") continue;
      // Leave failed entities untouched so the next run can retry them.
      if (execResult.failedEntityDirs.has(diff.entityDir)) continue;
      const newId = execResult.newIds.get(diff.entityDir);
      if (!newId) continue;
      const base = diff.entityDir.slice(diff.entityDir.lastIndexOf("/") + 1);
      if (base === newId) continue;
      try {
        const newDir = reconcileAliasDir(syncDirAbs, diff.entityDir, newId, diff.kind);
        if (newDir === null) continue;
        dirRenames.set(diff.entityDir, newDir);
        debug(`Reconciled ${diff.entityDir} → ${newDir} (board-assigned id)`);
      } catch (err) {
        log(`Warning: could not reconcile ${diff.entityDir} to board id ${newId}: ${(err as Error).message}`);
      }
    }
    if (dirRenames.size > 0) updateUuidIndex(syncDirAbs, dirRenames);
  }

  // ─── Persist state to sync-back-ids.json ─────────────────────────────────
  // Write new ids from creates AND updated content hashes for updates/renames.
  // This allows the next sync-back run to skip entities whose content hasn't
  // changed, rather than emitting update operations for every entity on disk.
  // Not written in dry-run mode.
  if (!dryRun) {
    const idsPath = syncBackIdsPath(syncDirAbs);
    const existing = loadManifest(idsPath);
    // Loaded once up-front: used to record `baseHash` on each written entry (the
    // sync-manifest hash this push supersedes) and for the GC pass below.
    const syncManifest = loadManifest(syncManifestPath(syncDirAbs));
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

      // If the create was reconciled to a board-assigned id, the entity now lives
      // under the renamed dir — record the entry there.
      const finalDir = dirRenames.get(diff.entityDir) ?? diff.entityDir;

      // Compute current disk hash and fields snapshot for next-run change detection.
      const hash = computeDiskHash(syncDirAbs, finalDir, diff.kind);
      const fields = readEntityFields(syncDirAbs, finalDir, diff.kind);
      const contentHashes = readEntityContentHashes(syncDirAbs, finalDir);

      const entry: ManifestEntry = {
        id,
        hash,
        // Record the sync-manifest hash this entry supersedes so mergeManifests can
        // tell whether sync has since pulled newer board state (hash advanced → the
        // sync-manifest entry wins again) or is still stale (hash unchanged → this
        // entry wins). `null` marks that no hashed sync-manifest entry existed —
        // e.g. fresh creates or manifests written before the hash feature.
        baseHash: syncManifest.entities[finalDir]?.hash ?? null,
        ...(Object.keys(fields).length > 0 && { fields }),
        ...(Object.keys(contentHashes).length > 0 && { contentHashes }),
      };

      // For scenarios, persist the current expectations and interactions arrays so the
      // next sync-back run can diff against them.
      if (diff.kind === "scenario") {
        const scenarioJson = readScenarioJson(syncDirAbs, finalDir);
        if (scenarioJson !== null) {
          const extra: ManifestEntry["extra"] = {};
          if (scenarioJson.expectations !== null) extra.expectations = scenarioJson.expectations;
          if (scenarioJson.interactions !== null) extra.interactions = scenarioJson.interactions;
          if (Object.keys(extra).length > 0) entry.extra = extra;
        }
      }

      // For slices and elements, persist the current comment snapshots so the next
      // sync-back run can detect removed task comments without re-resolving the ones
      // already resolved this run.
      if (diff.kind === "slice" || diff.kind === "element") {
        const comments = readEntityCommentSnapshots(syncDirAbs, finalDir);
        if (comments.length > 0) {
          entry.extra = { ...(entry.extra ?? {}), comments };
        }
      }

      existing.entities[finalDir] = entry;
      wrote++;

      if (finalDir !== diff.entityDir) {
        // Alias stub: records that the pre-rename dir was pushed as `id`.
        // A stale sync-manifest entry for the old dir can outlive the rename
        // (the sync daemon may still hold the client-id entity in memory and
        // re-emit it into sync-manifest.json); this stub is what lets
        // computeManifestDiff recognise that entry as an alias instead of
        // emitting a DELETE for a never-on-board id.
        existing.entities[diff.entityDir] = { id };
      }
    }

    // ── GC: remove stale sync-back-ids entries ──────────────────────────────────
    // An entry is stale only when BOTH:
    //   - its entityDir is gone from disk (the entity was deleted externally,
    //     or sync renamed/absorbed the dir), AND
    //   - sync-manifest records nothing for that dir.
    //
    // While the dir still exists, the entry is what prevents the diff from
    // treating it as a fresh create (dropping it would re-push a duplicate —
    // e.g. a local alias dir whose entity the board re-ided on create).  And
    // while sync-manifest still records an entry for the same dir, this ids
    // entry may be the only record that the manifest's id is a superseded
    // client-side alias — removing it would unguard a bogus DELETE for an id
    // the board never had.
    //
    // HTML snippets have a flat layout — html-snippets/<slug>.json (+ .html) —
    // so their entityDir is a virtual path with no backing directory. Check for
    // the primary .json file (which is also what identifies the entity to
    // walkDiskEntities) instead of the directory.
    let gcCount = 0;
    for (const dir of Object.keys(existing.entities)) {
      const exists =
        kindFromEntityDir(dir) === "html-snippet"
          ? existsSync(join(syncDirAbs, `${dir}.json`))
          : existsSync(join(syncDirAbs, dir));
      if (!exists && syncManifest.entities[dir] === undefined) {
        delete existing.entities[dir];
        gcCount++;
        debug(`GC: removed stale sync-back-ids entry @ ${dir}`);
      }
    }
    if (gcCount > 0) {
      wrote += gcCount; // ensure we save
      debug(`GC: removed ${gcCount} stale sync-back-ids entr${gcCount === 1 ? "y" : "ies"}`);
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

import { readFileSync, writeFileSync, renameSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Primary json filename per leaf entity kind (uuid-keyed dirs). */
const PRIMARY_JSON_FILE: Record<string, string> = {
  slice: "slice.json",
  lane: "lane.json",
  element: "element.json",
  milestone: "milestone.json",
  scenario: "scenario.json",
};

/**
 * Rename an entity dir whose local (client-generated) uuid differs from the
 * board-assigned id to the canonical `<parent>/<board-id>` dir, and rewrite
 * the `id` field in its primary json.  When the canonical dir already exists
 * (a live sync already rendered the board entity) the local alias dir is a
 * redundant copy and is removed instead — the pushed content is on the board.
 *
 * Returns the new entityDir, or null when the local dir does not exist.
 */
function reconcileAliasDir(
  syncRootAbs: string,
  entityDir: string,
  boardId: string,
  kind: string,
): string | null {
  const oldAbs = join(syncRootAbs, entityDir);
  if (!existsSync(oldAbs)) return null;
  const newDir = `${entityDir.slice(0, entityDir.lastIndexOf("/"))}/${boardId}`;
  const newAbs = join(syncRootAbs, newDir);
  if (existsSync(newAbs)) {
    rmSync(oldAbs, { recursive: true, force: true });
    return newDir;
  }
  renameSync(oldAbs, newAbs);
  const primaryFile = PRIMARY_JSON_FILE[kind];
  if (primaryFile) {
    const jsonAbs = join(newAbs, primaryFile);
    const parsed = JSON.parse(readFileSync(jsonAbs, "utf8")) as Record<string, unknown>;
    parsed.id = boardId;
    writeFileSync(jsonAbs, JSON.stringify(parsed, null, 2) + "\n", "utf8");
  }
  return newDir;
}

/**
 * Reconcile on-disk alias dirs recorded in sync-back-ids.json (dir basename is
 * the client-generated uuid, entry id is the board-assigned one).  Each healed
 * dir gets its ids entry re-keyed to the canonical dir and keeps a stub under
 * the old dir so stale sync-manifest records are still recognised as aliases.
 */
function healAliasDirs(
  syncRootAbs: string,
  ctx: { log: (msg: string) => void; debug: (msg: string) => void },
): void {
  const idsPath = syncBackIdsPath(syncRootAbs);
  const ids = loadManifest(idsPath);
  const renames = new Map<string, string>();

  for (const [dir, entry] of Object.entries(ids.entities)) {
    const kind = kindFromEntityDir(dir);
    if (!kind || kind === "chapter" || kind === "html-snippet") continue;
    if (!entry.id) continue;
    const base = dir.slice(dir.lastIndexOf("/") + 1);
    if (entry.id === base) continue; // already canonical
    try {
      const newDir = reconcileAliasDir(syncRootAbs, dir, entry.id, kind);
      if (newDir === null) continue;
      delete ids.entities[dir];
      ids.entities[newDir] = {
        ...entry,
        hash: computeDiskHash(syncRootAbs, newDir, kind),
      };
      ids.entities[dir] = { id: entry.id };
      renames.set(dir, newDir);
      ctx.debug(`Reconciled alias dir ${dir} → ${newDir} (board-assigned id)`);
    } catch (err) {
      ctx.log(`Warning: could not reconcile alias dir ${dir}: ${(err as Error).message}`);
    }
  }

  if (renames.size === 0) return;
  ids.updatedAt = new Date().toISOString();
  try {
    saveManifest(idsPath, ids);
  } catch (err) {
    ctx.log(`Warning: could not write sync-back-ids.json: ${(err as Error).message}`);
  }
  updateUuidIndex(syncRootAbs, renames);
}

/**
 * Update uuid-index.json after entity dirs were renamed to board-assigned ids:
 * drop the stale uuid→dir entry and record the new id → dir mapping.
 * Best-effort — the sync process regenerates the index on every write anyway.
 */
function updateUuidIndex(syncRootAbs: string, renames: Map<string, string>): void {
  const indexPath = join(syncRootAbs, "uuid-index.json");
  try {
    if (!existsSync(indexPath)) return;
    const index = JSON.parse(readFileSync(indexPath, "utf8")) as Record<string, string>;
    for (const [oldDir, newDir] of renames) {
      const oldId = oldDir.slice(oldDir.lastIndexOf("/") + 1);
      const newId = newDir.slice(newDir.lastIndexOf("/") + 1);
      if (index[oldId] === oldDir) delete index[oldId];
      index[newId] = newDir;
    }
    writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n", "utf8");
  } catch { /* regenerate-on-next-sync is the fallback */ }
}

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
