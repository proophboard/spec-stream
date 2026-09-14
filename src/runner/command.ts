/**
 * Command Runner: spawn a configured command as a child process for a scheduled task.
 *
 * Guarantees:
 *   - Never throws into the caller — every outcome is returned as a {@link CommandResult}.
 *   - Injects SPEC_STREAM_* env vars and writes the event JSON to stdin.
 *   - Honors an optional timeout (SIGTERM, then SIGKILL).
 */

import { spawn } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import type { SchedulerTask } from "../scheduler/scheduler.js";
import type { SpecStreamConfig } from "../config/schema.js";
import { mergeEnv, serializeStdin, type SelfIdentity } from "./context.js";

export interface CommandResult {
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  /** Set when the process could not be spawned at all. */
  error?: string;
}

export interface RunOptions {
  config: SpecStreamConfig;
  /** Injectable for tests; defaults to process.env. */
  processEnv?: NodeJS.ProcessEnv;
  /** Grace period between SIGTERM and SIGKILL on timeout (ms). */
  killGraceMs?: number;
  /** The API key's user identity, injected as SPEC_STREAM_SELF_*. */
  self?: SelfIdentity;
  /**
   * If set, receives the child's output chunks as they arrive (live streaming), in
   * addition to being captured in the returned result. Chunks are raw (not line-aligned).
   */
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
}

/**
 * Run the command associated with a scheduled task. Resolves (never rejects) with a
 * {@link CommandResult}.
 */
export function runCommand(task: SchedulerTask, opts: RunOptions): Promise<CommandResult> {
  const { config } = opts;
  const rule = task.rule;
  const processEnv = opts.processEnv ?? process.env;
  const killGraceMs = opts.killGraceMs ?? 5000;
  const start = Date.now();

  const env = mergeEnv(processEnv, config.env, rule, task, opts.self);
  const cwd = rule.cwd ? resolvePath(config.configDir, rule.cwd) : config.configDir;
  const stdinData = serializeStdin(task);

  return new Promise<CommandResult>((resolve) => {
    let child;
    try {
      if (config.shell) {
        // shell:true → run the rule.run string via the platform shell.
        child = spawn(rule.run as string, {
          cwd,
          env,
          shell: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } else {
        child = spawn(rule.command as string, rule.args, {
          cwd,
          env,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        });
      }
    } catch (err) {
      resolve({
        ok: false,
        exitCode: null,
        signal: null,
        timedOut: false,
        durationMs: Date.now() - start,
        stdout: "",
        stderr: "",
        error: `Failed to spawn command: ${(err as Error).message}`,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let hardKillTimer: ReturnType<typeof setTimeout> | undefined;

    child.stdout?.on("data", (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      opts.onOutput?.("stdout", s);
    });
    child.stderr?.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      opts.onOutput?.("stderr", s);
    });

    const finish = (result: Omit<CommandResult, "durationMs">) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      resolve({ ...result, durationMs: Date.now() - start });
    };

    // Timeout handling
    if (rule.timeout && rule.timeout > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        hardKillTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
      }, rule.timeout);
    }

    child.on("error", (err) => {
      finish({
        ok: false,
        exitCode: null,
        signal: null,
        timedOut,
        stdout,
        stderr,
        error: `Command process error: ${err.message}`,
      });
    });

    child.on("close", (code, signal) => {
      finish({
        ok: !timedOut && code === 0,
        exitCode: code,
        signal: signal ?? null,
        timedOut,
        stdout,
        stderr,
        error: timedOut ? `Command timed out after ${rule.timeout}ms` : undefined,
      });
    });

    // Write stdin payload and close. Guard against EPIPE if the child already exited.
    // The write error is asynchronous, so attach a handler in addition to try/catch.
    child.stdin?.on("error", () => {
      /* ignore broken pipe / closed stdin when the child exits early */
    });
    try {
      child.stdin?.write(stdinData);
      child.stdin?.end();
    } catch {
      // stdin may already be closed if the child exited immediately; ignore.
    }
  });
}
