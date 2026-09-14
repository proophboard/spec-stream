/**
 * PID file management for background mode. Injectable fs + signal for testability.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

export interface PidFileDeps {
  readFile: (p: string) => string;
  writeFile: (p: string, data: string) => void;
  exists: (p: string) => boolean;
  remove: (p: string) => void;
  mkdirp: (dir: string) => void;
  /** Return true if a process with `pid` is alive. */
  isAlive: (pid: number) => boolean;
}

const defaultDeps: PidFileDeps = {
  readFile: (p) => readFileSync(p, "utf8"),
  writeFile: (p, data) => writeFileSync(p, data),
  exists: existsSync,
  remove: (p) => unlinkSync(p),
  mkdirp: (dir) => mkdirSync(dir, { recursive: true }),
  isAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // ESRCH = no such process; EPERM = exists but not ours (still alive).
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  },
};

export class PidFile {
  constructor(
    private readonly path: string,
    private readonly deps: PidFileDeps = defaultDeps,
  ) {}

  /** Read the stored PID, or null if absent/invalid. */
  read(): number | null {
    if (!this.deps.exists(this.path)) return null;
    const raw = this.deps.readFile(this.path).trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  }

  /** Return the PID if a live process is recorded; clears stale files. */
  readLive(): number | null {
    const pid = this.read();
    if (pid === null) return null;
    if (this.deps.isAlive(pid)) return pid;
    // Stale file — clean it up.
    this.clear();
    return null;
  }

  /** Write the current (or given) PID, creating the directory as needed. */
  write(pid: number = process.pid): void {
    this.deps.mkdirp(dirname(this.path));
    this.deps.writeFile(this.path, String(pid));
  }

  clear(): void {
    if (this.deps.exists(this.path)) this.deps.remove(this.path);
  }
}
