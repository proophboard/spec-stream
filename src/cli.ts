#!/usr/bin/env node
/**
 * spec-stream CLI entry point. Parses args, dispatches subcommands, and wires the App
 * for `run`. Deployment/process concerns (PID file, signals, daemon) live here; the
 * streaming logic lives in App.
 */

import { readFileSync, existsSync, createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs, HELP_TEXT, type CliOptions } from "./cli/args.js";
import { loadConfig, resolveApiKey } from "./config/load.js";
import { ConfigError } from "./config/schema.js";
import { resolvePaths } from "./lifecycle/paths.js";
import { PidFile } from "./lifecycle/pidfile.js";
import { daemonize } from "./lifecycle/daemon.js";
import { createLogger } from "./logging/setup.js";
import { App } from "./app.js";

function readVersion(): string {
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function fail(message: string): never {
  process.stderr.write(`spec-stream: ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.error) fail(opts.error);
  if (opts.command === "help") {
    process.stdout.write(HELP_TEXT);
    return;
  }
  if (opts.command === "version") {
    process.stdout.write(readVersion() + "\n");
    return;
  }

  // Load config (needed by all remaining commands to resolve paths).
  let loaded;
  try {
    loaded = loadConfig({ configPath: opts.configPath });
  } catch (err) {
    if (err instanceof ConfigError) fail(err.message);
    throw err;
  }
  const { config } = loaded;
  const paths = resolvePaths({
    configDir: config.configDir,
    logDirOverride: opts.logDir ?? config.logDir,
    stateDirOverride: opts.stateDir ?? config.stateDir,
    userMode: opts.userMode,
  });
  const pidFile = new PidFile(paths.pidFile);

  switch (opts.command) {
    case "status":
      return cmdStatus(pidFile);
    case "logs":
      return cmdLogs(paths.logFile, opts.follow);
    case "stop":
      return cmdStop(pidFile);
    case "start":
      return cmdStart(pidFile, paths.logFile, opts);
    case "run":
      return cmdRun(config, opts, paths, pidFile);
    default:
      fail(`Unsupported command: ${opts.command}`);
  }
}

function cmdStatus(pidFile: PidFile): void {
  const pid = pidFile.readLive();
  if (pid === null) {
    process.stdout.write("spec-stream: not running\n");
    process.exit(1);
  }
  process.stdout.write(`spec-stream: running (pid ${pid})\n`);
}

function cmdStop(pidFile: PidFile): void {
  const pid = pidFile.readLive();
  if (pid === null) {
    process.stdout.write("spec-stream: not running\n");
    return;
  }
  process.stdout.write(`spec-stream: stopping (pid ${pid})…\n`);
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    fail(`could not signal pid ${pid}: ${(err as Error).message}`);
  }
}

function cmdLogs(logFile: string, follow: boolean): void {
  if (!existsSync(logFile)) {
    process.stdout.write(`spec-stream: no log file at ${logFile}\n`);
    process.exit(1);
  }
  if (!follow) {
    process.stdout.write(readFileSync(logFile, "utf8"));
    return;
  }
  // Follow mode: stream existing content, then tail. Simple polling-free approach:
  // print current content and keep the process attached reading appended bytes.
  const stream = createReadStream(logFile, { encoding: "utf8" });
  stream.pipe(process.stdout);
  // Note: a full `tail -f` is intentionally minimal here; documented in docs.
}

function cmdStart(pidFile: PidFile, logFile: string, opts: CliOptions): void {
  const existing = pidFile.readLive();
  if (existing !== null) {
    fail(`already running (pid ${existing})`);
  }
  // Rebuild args for the detached `run` (strip start/detach; keep config/log/etc).
  const passthrough: string[] = [];
  if (opts.configPath) passthrough.push("--config", opts.configPath);
  if (opts.logDir) passthrough.push("--log-dir", opts.logDir);
  if (opts.stateDir) passthrough.push("--state-dir", opts.stateDir);
  if (opts.userMode) passthrough.push("--user");
  if (opts.dryRun) passthrough.push("--dry-run");
  if (opts.verbose) passthrough.push("--verbose");
  if (opts.quiet) passthrough.push("--quiet");

  const scriptPath = fileURLToPath(import.meta.url);
  const { pid } = daemonize({ args: passthrough, logFile, scriptPath });
  pidFile.write(pid);
  process.stdout.write(`spec-stream started (pid ${pid})\nlogs: ${logFile}\n`);
}

async function cmdRun(
  config: ReturnType<typeof loadConfig>["config"],
  opts: CliOptions,
  paths: ReturnType<typeof resolvePaths>,
  pidFile: PidFile,
): Promise<void> {
  let apiKey: string;
  try {
    apiKey = resolveApiKey();
  } catch (err) {
    if (err instanceof ConfigError) fail(err.message);
    throw err;
  }

  const level = opts.verbose ? "debug" : opts.quiet ? "warn" : config.logLevel;
  const logger = createLogger({
    logFile: paths.logFile,
    level,
    color: process.stdout.isTTY ?? false,
    terminal: true,
  });

  const app = new App({ config, apiKey, logger, dryRun: opts.dryRun });

  // If launched detached, we own the PID file for our own lifetime.
  const ownsPidFile = opts.detach || pidFile.read() === process.pid;
  if (ownsPidFile) pidFile.write(process.pid);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutdown", { signal });
    await app.stop();
    if (ownsPidFile) pidFile.clear();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await app.start();
  } catch (err) {
    logger.error("startup_failed", { message: (err as Error).message });
    if (ownsPidFile) pidFile.clear();
    fail((err as Error).message);
  }

  // Keep the event loop alive until a signal triggers shutdown.
  await new Promise<never>(() => {});
}

main().catch((err) => {
  process.stderr.write(`spec-stream: unexpected error: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
