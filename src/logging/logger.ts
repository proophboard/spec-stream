/**
 * Dual-sink logger: human-readable to the terminal (colorized on a TTY) and structured
 * JSON Lines to a rotating log file. All output is redacted (see redact.ts).
 *
 * The sinks are injectable so the logger is fully unit-testable without touching a TTY
 * or the filesystem.
 */

import type { LogLevel } from "../config/schema.js";
import { redactString, redactValue } from "./redact.js";

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

export interface LogRecord {
  ts: string;
  level: LogLevel;
  /** Machine-readable event kind, e.g. "command.done", "conn.state". */
  kind: string;
  msg?: string;
  [field: string]: unknown;
}

/** A sink receives an already-redacted record. */
export interface Sink {
  write(record: LogRecord): void;
}

export interface LoggerOptions {
  level: LogLevel;
  sinks: Sink[];
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

export class Logger {
  private level: number;
  private sinks: Sink[];
  private now: () => Date;

  constructor(opts: LoggerOptions) {
    this.level = LEVEL_ORDER[opts.level];
    this.sinks = opts.sinks;
    this.now = opts.now ?? (() => new Date());
  }

  setLevel(level: LogLevel): void {
    this.level = LEVEL_ORDER[level];
  }

  isEnabled(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= this.level;
  }

  log(level: LogLevel, kind: string, fields: Record<string, unknown> = {}): void {
    if (!this.isEnabled(level)) return;
    const base: LogRecord = {
      ts: this.now().toISOString(),
      level,
      kind,
      ...fields,
    };
    const redacted = redactValue(base);
    for (const sink of this.sinks) {
      try {
        sink.write(redacted);
      } catch {
        // A failing sink must never break the app.
      }
    }
  }

  trace(kind: string, fields?: Record<string, unknown>): void {
    this.log("trace", kind, fields);
  }
  debug(kind: string, fields?: Record<string, unknown>): void {
    this.log("debug", kind, fields);
  }
  info(kind: string, fields?: Record<string, unknown>): void {
    this.log("info", kind, fields);
  }
  warn(kind: string, fields?: Record<string, unknown>): void {
    this.log("warn", kind, fields);
  }
  error(kind: string, fields?: Record<string, unknown>): void {
    this.log("error", kind, fields);
  }
}

/** JSONL sink: one redacted JSON object per line, via an injected line-writer. */
export class JsonlSink implements Sink {
  constructor(private readonly writeLine: (line: string) => void) {}
  write(record: LogRecord): void {
    this.writeLine(JSON.stringify(record));
  }
}

const LEVEL_LABEL: Record<LogLevel, string> = {
  trace: "trace",
  debug: "debug",
  info: "info ",
  warn: "warn ",
  error: "error",
};

const LEVEL_COLOR: Record<LogLevel, string> = {
  trace: "\x1b[90m", // gray
  debug: "\x1b[36m", // cyan
  info: "\x1b[32m", // green
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
};
const RESET = "\x1b[0m";

/**
 * Pretty terminal sink. Colorizes when `color` is true. Formats a compact one-line
 * summary: `HH:MM:SS  level  kind  key=value …`.
 */
export class PrettySink implements Sink {
  constructor(
    private readonly writeLine: (line: string) => void,
    private readonly color: boolean,
  ) {}

  write(record: LogRecord): void {
    const { ts, level, kind, msg, ...rest } = record;
    const time = formatTime(ts);
    const label = LEVEL_LABEL[level];
    const levelStr = this.color ? `${LEVEL_COLOR[level]}${label}${RESET}` : label;

    const parts: string[] = [];
    if (msg) parts.push(String(msg));
    for (const [k, v] of Object.entries(rest)) {
      if (v === undefined || v === null) continue;
      parts.push(`${k}=${formatVal(v)}`);
    }
    // record is already redacted; formatVal handles types.
    this.writeLine(`${time}  ${levelStr}  ${kind}  ${parts.join("  ")}`.trimEnd());
  }
}

function formatTime(iso: string): string {
  // HH:MM:SS from an ISO timestamp; fall back to the raw string.
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return m ? m[1] : iso;
}

function formatVal(v: unknown): string {
  if (typeof v === "string") {
    const s = redactString(v);
    return /\s/.test(s) ? JSON.stringify(s) : s;
  }
  if (typeof v === "object") return JSON.stringify(redactValue(v));
  return String(v);
}
