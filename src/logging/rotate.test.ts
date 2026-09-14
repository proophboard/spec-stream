import { describe, it, expect } from "vitest";
import { rotateIfNeeded, type RotationOptions } from "./rotate.js";

/** Build an in-memory fs stub for rotation tests. */
function memFs(initial: Record<string, number>) {
  const sizes = new Map<string, number>(Object.entries(initial));
  const ops: string[] = [];
  const fs: NonNullable<RotationOptions["fs"]> = {
    existsSync: (p) => sizes.has(p),
    statSize: (p) => sizes.get(p) ?? 0,
    renameSync: (from, to) => {
      ops.push(`rename ${from} -> ${to}`);
      sizes.set(to, sizes.get(from)!);
      sizes.delete(from);
    },
    unlinkSync: (p) => {
      ops.push(`unlink ${p}`);
      sizes.delete(p);
    },
  };
  return { fs, sizes, ops };
}

describe("rotateIfNeeded", () => {
  it("does nothing when file is under the limit", () => {
    const { fs, ops } = memFs({ "app.jsonl": 100 });
    expect(rotateIfNeeded("app.jsonl", { maxBytes: 1000, maxFiles: 3, fs })).toBe(false);
    expect(ops).toEqual([]);
  });

  it("does nothing when file does not exist", () => {
    const { fs } = memFs({});
    expect(rotateIfNeeded("app.jsonl", { maxBytes: 10, maxFiles: 3, fs })).toBe(false);
  });

  it("rotates the active file to .1 when over the limit", () => {
    const { fs, sizes } = memFs({ "app.jsonl": 2000 });
    expect(rotateIfNeeded("app.jsonl", { maxBytes: 1000, maxFiles: 3, fs })).toBe(true);
    expect(sizes.has("app.jsonl")).toBe(false);
    expect(sizes.get("app.jsonl.1")).toBe(2000);
  });

  it("shifts existing segments and drops the oldest", () => {
    const { fs, sizes, ops } = memFs({
      "app.jsonl": 2000,
      "app.jsonl.1": 10,
      "app.jsonl.2": 20,
      "app.jsonl.3": 30,
    });
    rotateIfNeeded("app.jsonl", { maxBytes: 1000, maxFiles: 3, fs });
    // oldest (.3) dropped, .2->.3, .1->.2, active->.1
    expect(ops[0]).toBe("unlink app.jsonl.3");
    expect(sizes.get("app.jsonl.3")).toBe(20);
    expect(sizes.get("app.jsonl.2")).toBe(10);
    expect(sizes.get("app.jsonl.1")).toBe(2000);
    expect(sizes.has("app.jsonl")).toBe(false);
  });
});
