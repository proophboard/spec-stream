import { describe, it, expect } from "vitest";
import {
  discoverConfigPath,
  resolveApiKey,
  loadConfig,
  CONFIG_FILENAME,
  API_KEY_ENV,
} from "./load.js";
import { ConfigError } from "./schema.js";

describe("discoverConfigPath", () => {
  it("finds the config in the start directory", () => {
    const exists = (p: string) => p === `/a/b/c/${CONFIG_FILENAME}`;
    expect(discoverConfigPath("/a/b/c", exists)).toBe(`/a/b/c/${CONFIG_FILENAME}`);
  });

  it("walks up to a parent directory", () => {
    const exists = (p: string) => p === `/a/${CONFIG_FILENAME}`;
    expect(discoverConfigPath("/a/b/c", exists)).toBe(`/a/${CONFIG_FILENAME}`);
  });

  it("returns null when not found up to root", () => {
    const exists = () => false;
    expect(discoverConfigPath("/a/b/c", exists)).toBeNull();
  });

  it("checks the root directory itself", () => {
    const exists = (p: string) => p === `/${CONFIG_FILENAME}`;
    expect(discoverConfigPath("/a", exists)).toBe(`/${CONFIG_FILENAME}`);
  });
});

describe("resolveApiKey", () => {
  it("returns the key from env", () => {
    expect(resolveApiKey({ [API_KEY_ENV]: "pb_abc" })).toBe("pb_abc");
  });

  it("throws when missing", () => {
    expect(() => resolveApiKey({})).toThrow(/Missing PROOPHBOARD_API_KEY/);
  });

  it("throws when empty", () => {
    expect(() => resolveApiKey({ [API_KEY_ENV]: "" })).toThrow(/Missing/);
  });

  it("throws when not a pb_ key", () => {
    expect(() => resolveApiKey({ [API_KEY_ENV]: "sk_live_x" })).toThrow(/start with "pb_"/);
  });
});

describe("loadConfig", () => {
  const validJson = JSON.stringify({
    endpoint: "https://app.prooph-board.com",
    rules: [{ on: "element-added", run: "echo hi" }],
  });

  it("loads and validates a discovered config, injecting configDir", () => {
    const path = `/proj/${CONFIG_FILENAME}`;
    const { config, configPath } = loadConfig({
      cwd: "/proj/sub",
      fileExists: (p) => p === path,
      readFile: (p) => (p === path ? validJson : ""),
    });
    expect(configPath).toBe(path);
    expect(config.configDir).toBe("/proj");
    expect(config.rules[0].on).toEqual(["element-added"]);
  });

  it("uses an explicit config path", () => {
    const path = "/custom/my.json";
    const { configPath } = loadConfig({
      configPath: path,
      fileExists: (p) => p === path,
      readFile: () => validJson,
    });
    expect(configPath).toBe(path);
  });

  it("throws when explicit path does not exist", () => {
    expect(() =>
      loadConfig({ configPath: "/missing.json", fileExists: () => false }),
    ).toThrow(/not found/);
  });

  it("throws when no config discovered", () => {
    expect(() => loadConfig({ cwd: "/x", fileExists: () => false })).toThrow(
      /No proophboard\.spec-stream\.json found/,
    );
  });

  it("throws ConfigError on invalid JSON", () => {
    expect(() =>
      loadConfig({
        configPath: "/c.json",
        fileExists: () => true,
        readFile: () => "{ not json",
      }),
    ).toThrow(ConfigError);
  });

  it("propagates schema validation errors", () => {
    expect(() =>
      loadConfig({
        configPath: "/c.json",
        fileExists: () => true,
        readFile: () => JSON.stringify({ endpoint: "https://x.com", rules: [] }),
      }),
    ).toThrow(/at least one rule/);
  });
});
