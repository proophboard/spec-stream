import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDotenv } from "./dotenv.js";

describe("loadDotenv", () => {
  let dir: string;
  const KEY = "SPEC_STREAM_DOTENV_TEST_KEY";
  const OTHER = "SPEC_STREAM_DOTENV_TEST_OTHER";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ss-dotenv-"));
    delete process.env[KEY];
    delete process.env[OTHER];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env[KEY];
    delete process.env[OTHER];
  });

  it("returns null when no .env exists", () => {
    expect(loadDotenv(dir)).toBeNull();
    expect(process.env[KEY]).toBeUndefined();
  });

  it("loads values from a .env file", () => {
    writeFileSync(join(dir, ".env"), `${KEY}=pb_fromfile\n${OTHER}="quoted value"\n`);
    const loaded = loadDotenv(dir);
    expect(loaded).toBe(join(dir, ".env"));
    expect(process.env[KEY]).toBe("pb_fromfile");
    expect(process.env[OTHER]).toBe("quoted value");
  });

  it("does not override an existing process.env value", () => {
    process.env[KEY] = "pb_fromenv";
    writeFileSync(join(dir, ".env"), `${KEY}=pb_fromfile\n`);
    loadDotenv(dir);
    expect(process.env[KEY]).toBe("pb_fromenv");
  });

  it("ignores comments and blank lines", () => {
    writeFileSync(join(dir, ".env"), `# a comment\n\n${KEY}=abc\n`);
    loadDotenv(dir);
    expect(process.env[KEY]).toBe("abc");
  });
});
