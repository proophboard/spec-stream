import { describe, it, expect } from "vitest";
import { Logger, JsonlSink, PrettySink, type LogRecord } from "./logger.js";

function capturingSink() {
  const records: LogRecord[] = [];
  return {
    records,
    sink: { write: (r: LogRecord) => records.push(r) },
  };
}

const fixedNow = () => new Date("2026-09-14T17:42:03.000Z");

describe("Logger levels", () => {
  it("filters records below the configured level", () => {
    const { records, sink } = capturingSink();
    const log = new Logger({ level: "info", sinks: [sink], now: fixedNow });
    log.trace("t");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(records.map((r) => r.kind)).toEqual(["i", "w", "e"]);
  });

  it("setLevel changes filtering", () => {
    const { records, sink } = capturingSink();
    const log = new Logger({ level: "error", sinks: [sink], now: fixedNow });
    log.info("i");
    expect(records).toHaveLength(0);
    log.setLevel("debug");
    log.info("i2");
    expect(records.map((r) => r.kind)).toEqual(["i2"]);
  });

  it("isEnabled reflects the threshold", () => {
    const log = new Logger({ level: "warn", sinks: [] });
    expect(log.isEnabled("info")).toBe(false);
    expect(log.isEnabled("warn")).toBe(true);
    expect(log.isEnabled("error")).toBe(true);
  });
});

describe("Logger fields and redaction", () => {
  it("builds a record with ts/level/kind and extra fields", () => {
    const { records, sink } = capturingSink();
    const log = new Logger({ level: "info", sinks: [sink], now: fixedNow });
    log.info("command.done", { ruleId: "r", exitCode: 0 });
    expect(records[0]).toMatchObject({
      ts: "2026-09-14T17:42:03.000Z",
      level: "info",
      kind: "command.done",
      ruleId: "r",
      exitCode: 0,
    });
  });

  it("redacts secrets in fields before sinks see them", () => {
    const { records, sink } = capturingSink();
    const log = new Logger({ level: "info", sinks: [sink], now: fixedNow });
    log.info("auth", { note: "using pb_secret123", access_token: "eyJa.b.c" });
    expect(records[0].note).toBe("using pb_***");
    expect(records[0].access_token).toBe("***");
  });

  it("writes to all sinks and a failing sink does not break others", () => {
    const { records, sink } = capturingSink();
    const boom = { write: () => { throw new Error("sink down"); } };
    const log = new Logger({ level: "info", sinks: [boom, sink], now: fixedNow });
    expect(() => log.info("ok")).not.toThrow();
    expect(records).toHaveLength(1);
  });
});

describe("JsonlSink", () => {
  it("writes one JSON line per record", () => {
    const lines: string[] = [];
    const log = new Logger({
      level: "info",
      sinks: [new JsonlSink((l) => lines.push(l))],
      now: fixedNow,
    });
    log.info("event.received", { eventType: "element-added" });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.kind).toBe("event.received");
    expect(parsed.eventType).toBe("element-added");
    expect(parsed.ts).toBe("2026-09-14T17:42:03.000Z");
  });
});

describe("PrettySink", () => {
  it("formats a compact line without color", () => {
    const lines: string[] = [];
    const log = new Logger({
      level: "info",
      sinks: [new PrettySink((l) => lines.push(l), false)],
      now: fixedNow,
    });
    log.info("run", { rule: "spec", pid: 123 });
    expect(lines[0]).toBe("17:42:03  info   run  rule=spec  pid=123");
  });

  it("includes ANSI color codes when enabled", () => {
    const lines: string[] = [];
    const log = new Logger({
      level: "info",
      sinks: [new PrettySink((l) => lines.push(l), true)],
      now: fixedNow,
    });
    log.error("fail", {});
    expect(lines[0]).toContain("\x1b[31m"); // red
    expect(lines[0]).toContain("\x1b[0m"); // reset
  });

  it("quotes values containing whitespace and redacts them", () => {
    const lines: string[] = [];
    const log = new Logger({
      level: "info",
      sinks: [new PrettySink((l) => lines.push(l), false)],
      now: fixedNow,
    });
    log.info("x", { cmd: "echo pb_abc def" });
    expect(lines[0]).toContain('cmd="echo pb_*** def"');
  });
});
