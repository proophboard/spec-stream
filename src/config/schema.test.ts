import { describe, it, expect } from "vitest";
import { validateConfig, ConfigError } from "./schema.js";

function minimal(overrides: Record<string, unknown> = {}) {
  return {
    endpoint: "https://app.prooph-board.com",
    rules: [{ on: "element-description-changed", run: "echo hi" }],
    ...overrides,
  };
}

describe("validateConfig", () => {
  it("accepts a minimal config and applies defaults", () => {
    const c = validateConfig(minimal(), "/proj");
    expect(c.endpoint).toBe("https://app.prooph-board.com");
    expect(c.logLevel).toBe("info");
    expect(c.maxConcurrent).toBe(4);
    expect(c.drainTimeout).toBe(30000);
    expect(c.shell).toBe(true);
    expect(c.transport).toBe("realtime");
    expect(c.configDir).toBe("/proj");
    expect(c.rules).toHaveLength(1);
  });

  it("strips trailing slashes from endpoint", () => {
    const c = validateConfig(minimal({ endpoint: "https://x.com/" }));
    expect(c.endpoint).toBe("https://x.com");
  });

  it("auto-generates rule ids and defaults", () => {
    const c = validateConfig(minimal());
    const r = c.rules[0];
    expect(r.id).toBe("rule-1");
    expect(r.on).toEqual(["element-description-changed"]);
    expect(r.run).toBe("echo hi");
    expect(r.args).toEqual([]);
    expect(r.env).toEqual({});
  });

  it("defaults concurrency key to element for element events", () => {
    const c = validateConfig(minimal());
    expect(c.rules[0].concurrency.key).toBe("element");
    expect(c.rules[0].concurrency.mode).toBe("queue");
    expect(c.rules[0].concurrency.wait).toBe(2000);
    expect(c.rules[0].concurrency.max).toBe(1);
  });

  it("defaults concurrency key to global for non-element events", () => {
    const c = validateConfig(minimal({ rules: [{ on: "chapter-added", run: "x" }] }));
    expect(c.rules[0].concurrency.key).toBe("global");
  });

  it("defaults concurrency key to global for mixed event lists", () => {
    const c = validateConfig(
      minimal({ rules: [{ on: ["element-added", "chapter-added"], run: "x" }] }),
    );
    expect(c.rules[0].concurrency.key).toBe("global");
  });

  it("parallel mode defaults max to Infinity", () => {
    const c = validateConfig(
      minimal({ rules: [{ on: "*", run: "x", concurrency: { mode: "parallel" } }] }),
    );
    expect(c.rules[0].concurrency.max).toBe(Number.POSITIVE_INFINITY);
  });

  it("accepts on: '*'", () => {
    const c = validateConfig(minimal({ rules: [{ on: "*", run: "x" }] }));
    expect(c.rules[0].on).toBe("*");
  });

  it("accepts command + args form", () => {
    const c = validateConfig(
      minimal({ shell: false, rules: [{ on: "*", command: "kiro", args: ["agent"] }] }),
    );
    expect(c.rules[0].command).toBe("kiro");
    expect(c.rules[0].args).toEqual(["agent"]);
  });

  it("coerces when filters to arrays", () => {
    const c = validateConfig(
      minimal({
        rules: [
          { on: "element-added", run: "x", when: { elementType: "command", context: ["A", "B"] } },
        ],
      }),
    );
    expect(c.rules[0].when.elementType).toEqual(["command"]);
    expect(c.rules[0].when.context).toEqual(["A", "B"]);
  });

  it("defaults consumeOwnEvents to false", () => {
    const c = validateConfig(minimal());
    expect(c.rules[0].consumeOwnEvents).toBe(false);
  });

  it("accepts consumeOwnEvents true", () => {
    const c = validateConfig(minimal({ rules: [{ on: "*", run: "x", consumeOwnEvents: true }] }));
    expect(c.rules[0].consumeOwnEvents).toBe(true);
  });

  it("rejects non-boolean consumeOwnEvents", () => {
    expect(() =>
      validateConfig(minimal({ rules: [{ on: "*", run: "x", consumeOwnEvents: "yes" }] })),
    ).toThrow(/consumeOwnEvents must be a boolean/);
  });

  // ── Failure cases ──
  it("rejects non-object root", () => {
    expect(() => validateConfig(null)).toThrow(ConfigError);
    expect(() => validateConfig([])).toThrow(/JSON object/);
  });

  it("requires endpoint", () => {
    expect(() => validateConfig({ rules: [] })).toThrow(/endpoint/);
  });

  it("rejects invalid endpoint URL", () => {
    expect(() => validateConfig(minimal({ endpoint: "not a url" }))).toThrow(/valid URL/);
  });

  it("requires at least one rule", () => {
    expect(() => validateConfig(minimal({ rules: [] }))).toThrow(/at least one rule/);
  });

  it("rejects rule without on", () => {
    expect(() => validateConfig(minimal({ rules: [{ run: "x" }] }))).toThrow(/\.on is required/);
  });

  it("rejects rule with both run and command", () => {
    expect(() =>
      validateConfig(minimal({ rules: [{ on: "*", run: "x", command: "y" }] })),
    ).toThrow(/not both/);
  });

  it("rejects rule with neither run nor command", () => {
    expect(() => validateConfig(minimal({ rules: [{ on: "*" }] }))).toThrow(/is required/);
  });

  it("rejects invalid concurrency mode", () => {
    expect(() =>
      validateConfig(minimal({ rules: [{ on: "*", run: "x", concurrency: { mode: "nope" } }] })),
    ).toThrow(/mode must be one of/);
  });

  it("rejects invalid logLevel", () => {
    expect(() => validateConfig(minimal({ logLevel: "verbose" }))).toThrow(/logLevel/);
  });

  it("rejects maxConcurrent < 1", () => {
    expect(() => validateConfig(minimal({ maxConcurrent: 0 }))).toThrow(/maxConcurrent/);
  });

  it("rejects duplicate rule ids", () => {
    expect(() =>
      validateConfig(
        minimal({
          rules: [
            { id: "dup", on: "*", run: "a" },
            { id: "dup", on: "*", run: "b" },
          ],
        }),
      ),
    ).toThrow(/Duplicate rule id/);
  });

  it("rejects run rule when shell=false", () => {
    expect(() =>
      validateConfig(minimal({ shell: false, rules: [{ on: "*", run: "x" }] })),
    ).toThrow(/requires shell=true/);
  });

  it("rejects args used with run", () => {
    expect(() =>
      validateConfig(minimal({ rules: [{ on: "*", run: "x", args: ["a"] }] })),
    ).toThrow(/only valid with "command"/);
  });

  it("rejects invalid transport", () => {
    expect(() => validateConfig(minimal({ transport: "socket" }))).toThrow(/transport/);
  });

  it("rejects non-boolean when.addedByAgent", () => {
    expect(() =>
      validateConfig(minimal({ rules: [{ on: "*", run: "x", when: { addedByAgent: "yes" } }] })),
    ).toThrow(/addedByAgent must be a boolean/);
  });
});
