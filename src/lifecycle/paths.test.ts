import { describe, it, expect } from "vitest";
import { resolvePaths } from "./paths.js";

describe("resolvePaths — project mode (default)", () => {
  it("places state under <configDir>/.spec-stream", () => {
    const p = resolvePaths({ configDir: "/proj" });
    expect(p.baseDir).toBe("/proj/.spec-stream");
    expect(p.logDir).toBe("/proj/.spec-stream/logs");
    expect(p.logFile).toBe("/proj/.spec-stream/logs/spec-stream.jsonl");
    expect(p.pidFile).toBe("/proj/.spec-stream/spec-stream.pid");
    expect(p.commandsDir).toBe("/proj/.spec-stream/logs/commands");
  });

  it("honors a relative logDir override against configDir", () => {
    const p = resolvePaths({ configDir: "/proj", logDirOverride: "mylogs" });
    expect(p.logDir).toBe("/proj/mylogs");
    expect(p.logFile).toBe("/proj/mylogs/spec-stream.jsonl");
  });

  it("honors an absolute logDir override", () => {
    const p = resolvePaths({ configDir: "/proj", logDirOverride: "/var/log/ss" });
    expect(p.logDir).toBe("/var/log/ss");
  });

  it("honors a stateDir override for the pid file", () => {
    const p = resolvePaths({ configDir: "/proj", stateDirOverride: "/run/ss" });
    expect(p.pidFile).toBe("/run/ss/spec-stream.pid");
  });
});

describe("resolvePaths — user/daemon mode", () => {
  it("uses XDG_STATE_HOME when set (linux)", () => {
    const p = resolvePaths({
      configDir: "/proj",
      userMode: true,
      platform: "linux",
      env: { XDG_STATE_HOME: "/home/u/.local/state" },
      home: "/home/u",
    });
    expect(p.baseDir).toBe("/home/u/.local/state/spec-stream");
    expect(p.logDir).toBe("/home/u/.local/state/spec-stream/logs");
    expect(p.pidFile).toBe("/home/u/.local/state/spec-stream/spec-stream.pid");
  });

  it("falls back to ~/.local/state when XDG unset", () => {
    const p = resolvePaths({
      configDir: "/proj",
      userMode: true,
      platform: "linux",
      env: {},
      home: "/home/u",
    });
    expect(p.baseDir).toBe("/home/u/.local/state/spec-stream");
  });

  it("uses LOCALAPPDATA on win32", () => {
    const p = resolvePaths({
      configDir: "C:/proj",
      userMode: true,
      platform: "win32",
      env: { LOCALAPPDATA: "C:/Users/u/AppData/Local" },
      home: "C:/Users/u",
    });
    expect(p.baseDir.replace(/\\/g, "/")).toBe("C:/Users/u/AppData/Local/spec-stream");
  });
});
