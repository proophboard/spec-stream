import { describe, it, expect } from "vitest";
import { parseArgs } from "./args.js";

describe("parseArgs", () => {
  it("defaults to the run command", () => {
    expect(parseArgs([]).command).toBe("run");
  });

  it("parses subcommands", () => {
    expect(parseArgs(["stop"]).command).toBe("stop");
    expect(parseArgs(["status"]).command).toBe("status");
    expect(parseArgs(["logs"]).command).toBe("logs");
  });

  it("start implies detach", () => {
    const o = parseArgs(["start"]);
    expect(o.command).toBe("start");
    expect(o.detach).toBe(true);
  });

  it("parses --config with a value", () => {
    expect(parseArgs(["--config", "/a/b.json"]).configPath).toBe("/a/b.json");
    expect(parseArgs(["-c", "x.json"]).configPath).toBe("x.json");
  });

  it("parses --log-dir and --state-dir", () => {
    const o = parseArgs(["--log-dir", "/l", "--state-dir", "/s"]);
    expect(o.logDir).toBe("/l");
    expect(o.stateDir).toBe("/s");
  });

  it("parses boolean flags", () => {
    const o = parseArgs(["run", "--detach", "--dry-run", "--verbose", "--user"]);
    expect(o.detach).toBe(true);
    expect(o.dryRun).toBe(true);
    expect(o.verbose).toBe(true);
    expect(o.userMode).toBe(true);
  });

  it("parses logs -f", () => {
    const o = parseArgs(["logs", "-f"]);
    expect(o.command).toBe("logs");
    expect(o.follow).toBe(true);
  });

  it("handles --help and --version", () => {
    expect(parseArgs(["--help"]).command).toBe("help");
    expect(parseArgs(["-h"]).command).toBe("help");
    expect(parseArgs(["--version"]).command).toBe("version");
    expect(parseArgs(["-V"]).command).toBe("version");
  });

  it("errors on unknown command", () => {
    expect(parseArgs(["frobnicate"]).error).toMatch(/Unknown command/);
  });

  it("errors on unknown option", () => {
    expect(parseArgs(["--nope"]).error).toMatch(/Unknown option/);
  });

  it("errors when a value-flag is missing its value", () => {
    expect(parseArgs(["--config"]).error).toMatch(/requires a value/);
    expect(parseArgs(["--config", "--verbose"]).error).toMatch(/requires a value/);
  });

  it("errors on verbose + quiet together", () => {
    expect(parseArgs(["--verbose", "--quiet"]).error).toMatch(/mutually exclusive/);
  });

  it("accepts flags after a subcommand", () => {
    const o = parseArgs(["run", "-c", "x.json", "--dry-run"]);
    expect(o.command).toBe("run");
    expect(o.configPath).toBe("x.json");
    expect(o.dryRun).toBe(true);
  });
});
