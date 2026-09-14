/**
 * Background (detached) process launch. Re-spawns the CLI in the foreground with stdio
 * redirected to the log file, detached from the terminal, and unref'd so the parent can
 * exit. See docs/background-mode.md.
 */

import { spawn } from "node:child_process";
import { openSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface DaemonizeOptions {
  /** Arguments to pass to the detached `run` invocation (without "start"/"--detach"). */
  args: string[];
  /** File to redirect stdout/stderr to. */
  logFile: string;
  /** The node executable + script path. Defaults to the current process. */
  execPath?: string;
  scriptPath: string;
  env?: NodeJS.ProcessEnv;
}

export interface DaemonHandle {
  pid: number;
}

/**
 * Launch a detached background process. Returns its PID. The caller writes the PID file
 * and exits.
 */
export function daemonize(opts: DaemonizeOptions): DaemonHandle {
  mkdirSync(dirname(opts.logFile), { recursive: true });
  const out = openSync(opts.logFile, "a");

  const child = spawn(opts.execPath ?? process.execPath, [opts.scriptPath, "run", ...opts.args], {
    detached: true,
    stdio: ["ignore", out, out],
    env: opts.env ?? process.env,
  });
  child.unref();

  if (child.pid === undefined) {
    throw new Error("Failed to spawn background process");
  }
  return { pid: child.pid };
}
