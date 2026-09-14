/**
 * Size-based log rotation, implemented with the Node standard library.
 *
 * When the active log file exceeds `maxBytes`, it is rotated: `file` → `file.1`,
 * `file.1` → `file.2`, … up to `maxFiles` segments (oldest dropped).
 */

import { existsSync, statSync, renameSync, unlinkSync } from "node:fs";

export interface RotationOptions {
  maxBytes: number;
  maxFiles: number;
  /** Injectable fs ops for testing. */
  fs?: {
    existsSync: (p: string) => boolean;
    statSize: (p: string) => number;
    renameSync: (from: string, to: string) => void;
    unlinkSync: (p: string) => void;
  };
}

const defaultFs = {
  existsSync,
  statSize: (p: string) => statSync(p).size,
  renameSync,
  unlinkSync,
};

/**
 * If `file` is at/over the size limit, rotate segments. Returns true if a rotation
 * happened (the caller should reopen the file handle).
 */
export function rotateIfNeeded(file: string, opts: RotationOptions): boolean {
  const fs = opts.fs ?? defaultFs;
  if (!fs.existsSync(file)) return false;
  if (fs.statSize(file) < opts.maxBytes) return false;

  // Drop the oldest, shift the rest up.
  const oldest = `${file}.${opts.maxFiles}`;
  if (fs.existsSync(oldest)) fs.unlinkSync(oldest);

  for (let i = opts.maxFiles - 1; i >= 1; i--) {
    const from = `${file}.${i}`;
    const to = `${file}.${i + 1}`;
    if (fs.existsSync(from)) fs.renameSync(from, to);
  }

  fs.renameSync(file, `${file}.1`);
  return true;
}
