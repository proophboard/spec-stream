/**
 * sync-back command.
 *
 * Reads git diff output for the local sync directory, builds API operations from the
 * changed files, and executes them against the prooph board REST API.
 *
 * Intended to be called from a git pre-commit hook so that API errors abort the commit:
 *
 *   #!/bin/sh
 *   npx spec-stream sync-back
 *
 * Or directly for manual runs:
 *
 *   spec-stream sync-back [--dry-run] [--from-commit <sha>] [--verbose]
 */

import { resolve } from "node:path";
import { loadConfig, resolveApiKey } from "../config/load.js";
import { loadDotenv } from "../config/dotenv.js";
import { ConfigError } from "../config/schema.js";
import { RestClient } from "../sync/restClient.js";
import { readGitDiff } from "./gitDiff.js";
import { buildOperations } from "./operationBuilder.js";
import { executeOperations } from "./executor.js";

export interface SyncBackOptions {
  /** Path to the config file (optional, defaults to discovery). */
  configPath?: string;
  /** When true, log operations but do not call the API. */
  dryRun?: boolean;
  /** Base commit for the diff (defaults to HEAD — the index is compared to HEAD in pre-commit mode). */
  fromCommit?: string;
  /** Target commit for the diff (defaults to HEAD). */
  toCommit?: string;
  /** Enable verbose output. */
  verbose?: boolean;
  /** Working directory (defaults to process.cwd()). */
  cwd?: string;
  /** Override fetch implementation (for testing). */
  fetchImpl?: typeof fetch;
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
 * Loads config, reads git diff, builds operations, executes them.
 * Returns a result summary. Throws on fatal errors (bad config, no git, etc.).
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

  const syncDir = config.localSync.dir ?? ".spec-stream/model";
  const syncDirAbs = resolve(cwd, syncDir);

  debug(`Sync root: ${syncDirAbs}`);
  const toLabel = opts.toCommit ?? "(staged)";
  debug(`Diff range: ${opts.fromCommit ?? "HEAD"}..${toLabel}`);

  // ─── API key ─────────────────────────────────────────────────────────────
  let apiKey: string;
  try {
    apiKey = resolveApiKey();
  } catch (err) {
    if (err instanceof ConfigError) throw new Error(`Config error: ${err.message}`);
    throw err;
  }

  // ─── Read git diff ────────────────────────────────────────────────────────
  let changes;
  try {
    changes = await readGitDiff({
      syncDir: syncDirAbs,
      fromCommit: opts.fromCommit,
      toCommit: opts.toCommit,
      cwd,
    });
  } catch (err) {
    throw new Error(`Failed to read git diff: ${(err as Error).message}`);
  }

  debug(`Found ${changes.length} changed file(s) in sync dir`);

  if (changes.length === 0) {
    log("No changes in sync dir — nothing to sync back.");
    return { operationCount: 0, executed: 0, skipped: 0, failed: 0, errors: [] };
  }

  if (verbose) {
    for (const c of changes) {
      const label = c.newPath ? `${c.path} → ${c.newPath}` : c.path;
      debug(`  ${c.status} ${label}`);
    }
  }

  // ─── Build operations ─────────────────────────────────────────────────────
  const operations = await buildOperations({ syncRootAbs: syncDirAbs, changes, fromCommit: opts.fromCommit, cwd });

  if (operations.length === 0) {
    log("No sync-back operations to perform.");
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

  // ─── Summary ──────────────────────────────────────────────────────────────
  const total = operations.length;
  if (dryRun) {
    log(`Done (dry-run): ${total} operation(s) would be executed.`);
  } else {
    const parts: string[] = [];
    if (execResult.executed > 0) parts.push(`${execResult.executed} succeeded`);
    if (execResult.failed > 0) parts.push(`${execResult.failed} failed`);
    log(`Done: ${parts.join(", ")}.`);
  }

  return {
    operationCount: total,
    executed: execResult.executed,
    skipped: execResult.skipped,
    failed: execResult.failed,
    errors: execResult.errors,
  };
}
