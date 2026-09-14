/**
 * Build a dual-sink Logger (pretty terminal + rotating JSONL file) from resolved paths.
 * Kept separate from Logger so the core logger stays free of fs concerns and testable.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import type { LogLevel } from "../config/schema.js";
import { Logger, JsonlSink, PrettySink, type LogRecord } from "./logger.js";
import { rotateIfNeeded } from "./rotate.js";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_FILES = 5;

export interface LoggerSetup {
  logFile: string;
  level: LogLevel;
  /** Whether the terminal sink should use color (TTY). */
  color: boolean;
  /** Include the terminal sink (false in background mode where stdout is the file). */
  terminal: boolean;
}

/** A JSONL sink that appends to a file with size-based rotation. */
export function createFileSink(logFile: string): JsonlSink {
  return new JsonlSink((line: string) => {
    try {
      rotateIfNeeded(logFile, { maxBytes: MAX_BYTES, maxFiles: MAX_FILES });
      appendFileSync(logFile, line + "\n");
    } catch {
      // Never let a logging failure break the app.
    }
  });
}

export function createLogger(setup: LoggerSetup): Logger {
  try {
    mkdirSync(dirnameOf(setup.logFile), { recursive: true });
  } catch {
    /* ignore */
  }

  const sinks = [createFileSink(setup.logFile)];
  if (setup.terminal) {
    const write = (line: string) => process.stdout.write(line + "\n");
    sinks.push(new PrettySink(write, setup.color) as unknown as JsonlSink);
  }
  return new Logger({ level: setup.level, sinks: sinks as unknown as { write(r: LogRecord): void }[] });
}

function dirnameOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : ".";
}
