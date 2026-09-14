import { describe, it, expect, vi } from "vitest";
import { runInit, STARTER_CONFIG } from "./init.js";
import { CONFIG_FILENAME } from "../config/load.js";

describe("runInit", () => {
  it("writes the starter config when none exists", () => {
    const writeFile = vi.fn();
    const result = runInit({
      cwd: "/proj",
      fileExists: () => false,
      writeFile,
    });

    expect(result.written).toBe(true);
    expect(result.path).toBe(`/proj/${CONFIG_FILENAME}`);
    expect(writeFile).toHaveBeenCalledOnce();
    expect(writeFile).toHaveBeenCalledWith(`/proj/${CONFIG_FILENAME}`, STARTER_CONFIG);
  });

  it("does not overwrite an existing config without force", () => {
    const writeFile = vi.fn();
    const result = runInit({
      cwd: "/proj",
      fileExists: () => true,
      writeFile,
    });

    expect(result.written).toBe(false);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("overwrites an existing config with force", () => {
    const writeFile = vi.fn();
    const result = runInit({
      cwd: "/proj",
      force: true,
      fileExists: () => true,
      writeFile,
    });

    expect(result.written).toBe(true);
    expect(writeFile).toHaveBeenCalledOnce();
  });

  it("produces a config that is valid JSON with an echo example rule", () => {
    const parsed = JSON.parse(STARTER_CONFIG);
    expect(parsed.endpoint).toContain("/api");
    expect(Array.isArray(parsed.rules)).toBe(true);
    expect(parsed.rules).toHaveLength(2);
    expect(parsed.rules[0].run.startsWith("echo ")).toBe(true);
    expect(parsed.rules[0].on).toBe("element-description-changed");

    const build = parsed.rules[1];
    expect(build.on).toBe("slice-status-changed");
    expect(build.when.data["newValue.status"]).toEqual(["planned"]);
    expect(build.run.startsWith("echo ")).toBe(true);
  });
});
