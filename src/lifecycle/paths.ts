/**
 * Path resolution for logs and the PID file. See docs/paths.md.
 *
 * Two modes:
 *   - project (default): state lives with the project at <configDir>/.spec-stream/
 *   - user/daemon: ${XDG_STATE_HOME:-~/.local/state}/spec-stream/ (or %LOCALAPPDATA% on win)
 *
 * Overridable via config `logDir`/`stateDir` or CLI `--log-dir`/`--state-dir`.
 */

import { homedir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";

export interface PathInputs {
  /** Directory of the resolved config file. */
  configDir: string;
  /** config.logDir or --log-dir (relative resolved against configDir). */
  logDirOverride?: string;
  /** config.stateDir or --state-dir. */
  stateDirOverride?: string;
  /** Use the XDG/user daemon location instead of project-local. */
  userMode?: boolean;
  /** Injectable env for testing. */
  env?: NodeJS.ProcessEnv;
  /** Injectable platform for testing. */
  platform?: NodeJS.Platform;
  /** Injectable home dir for testing. */
  home?: string;
}

export interface ResolvedPaths {
  /** Base directory containing logs and pid. */
  baseDir: string;
  logDir: string;
  pidFile: string;
  logFile: string;
  commandsDir: string;
}

const APP = "spec-stream";

function userStateDir(inputs: PathInputs): string {
  const env = inputs.env ?? process.env;
  const platform = inputs.platform ?? process.platform;
  const home = inputs.home ?? homedir();

  if (platform === "win32") {
    const local = env.LOCALAPPDATA || join(home, "AppData", "Local");
    return join(local, APP);
  }
  const xdg = env.XDG_STATE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(home, ".local", "state");
  return join(base, APP);
}

function resolveMaybe(base: string, p: string): string {
  return isAbsolute(p) ? p : resolve(base, p);
}

/** Resolve all runtime paths from inputs. */
export function resolvePaths(inputs: PathInputs): ResolvedPaths {
  const projectBase = join(inputs.configDir, ".spec-stream");
  const base = inputs.userMode ? userStateDir(inputs) : projectBase;

  const logDir = inputs.logDirOverride
    ? resolveMaybe(inputs.configDir, inputs.logDirOverride)
    : join(base, "logs");

  const stateBase = inputs.stateDirOverride
    ? resolveMaybe(inputs.configDir, inputs.stateDirOverride)
    : base;

  return {
    baseDir: base,
    logDir,
    pidFile: join(stateBase, `${APP}.pid`),
    logFile: join(logDir, `${APP}.jsonl`),
    commandsDir: join(logDir, "commands"),
  };
}
