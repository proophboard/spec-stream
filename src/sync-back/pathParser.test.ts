import { describe, it, expect } from "vitest";
import { parseSyncPath, primaryJsonPath } from "./pathParser.js";

describe("parseSyncPath", () => {
  // ─── chapter ────────────────────────────────────────────────────────────────
  describe("chapter files", () => {
    it("parses chapter.json", () => {
      const result = parseSyncPath("chapters/App/My-Chapter/chapter.json");
      expect(result).toEqual({
        kind: "chapter",
        entityDir: "chapters/App/My-Chapter",
        role: "chapter.json",
        generated: false,
      });
    });

    it("marks index.md as generated", () => {
      const result = parseSyncPath("chapters/App/My-Chapter/index.md");
      expect(result).toEqual({
        kind: "chapter",
        entityDir: "chapters/App/My-Chapter",
        role: "index.md",
        generated: true,
      });
    });

    it("returns null for the chapter directory itself", () => {
      expect(parseSyncPath("chapters/App/My-Chapter")).toBeNull();
    });

    it("parses scenario.json under chapters", () => {
      const result = parseSyncPath("chapters/App/My-Chapter/scenarios/My-Scenario/scenario.json");
      expect(result).toEqual({
        kind: "scenario",
        entityDir: "chapters/App/My-Chapter/scenarios/My-Scenario",
        role: "scenario.json",
        generated: false,
      });
    });

    it("returns null for non-scenario.json files under scenarios", () => {
      expect(parseSyncPath("chapters/App/My-Chapter/scenarios/My-Scenario/other.md")).toBeNull();
    });
  });

  // ─── slice ──────────────────────────────────────────────────────────────────
  describe("slice files", () => {
    it("parses slice.json", () => {
      const result = parseSyncPath("chapters/App/My-Chapter/slices/0001_My-Slice/slice.json");
      expect(result).toEqual({
        kind: "slice",
        entityDir: "chapters/App/My-Chapter/slices/0001_My-Slice",
        role: "slice.json",
        generated: false,
      });
    });

    it("parses slice details.md", () => {
      const result = parseSyncPath("chapters/App/My-Chapter/slices/0001_My-Slice/details.md");
      expect(result).toEqual({
        kind: "slice",
        entityDir: "chapters/App/My-Chapter/slices/0001_My-Slice",
        role: "slice.details",
        generated: false,
      });
    });

    it("returns null for slice comments", () => {
      expect(
        parseSyncPath("chapters/App/My-Chapter/slices/0001_My-Slice/comments/2026-01-01_abc/comment.json"),
      ).toBeNull();
    });
  });

  // ─── lane ───────────────────────────────────────────────────────────────────
  describe("lane files", () => {
    it("parses lane.json", () => {
      const result = parseSyncPath(
        "chapters/App/My-Chapter/slices/0001_My-Slice/lanes/information-flow/My-Lane/lane.json",
      );
      expect(result).toEqual({
        kind: "lane",
        entityDir: "chapters/App/My-Chapter/slices/0001_My-Slice/lanes/information-flow/My-Lane",
        role: "lane.json",
        generated: false,
      });
    });
  });

  // ─── element ─────────────────────────────────────────────────────────────────
  describe("element files", () => {
    const base =
      "chapters/App/My-Chapter/slices/0001_My-Slice/lanes/information-flow/My-Lane/elements/0001_My-Element";

    it("parses element.json", () => {
      const result = parseSyncPath(`${base}/element.json`);
      expect(result).toEqual({
        kind: "element",
        entityDir: base,
        role: "element.json",
        generated: false,
      });
    });

    it("parses description.md", () => {
      const result = parseSyncPath(`${base}/description.md`);
      expect(result).toMatchObject({ kind: "element", role: "element.description" });
    });

    it("parses details.md", () => {
      const result = parseSyncPath(`${base}/details.md`);
      expect(result).toMatchObject({ kind: "element", role: "element.details" });
    });

    it("parses play-function.ts", () => {
      const result = parseSyncPath(`${base}/play-function.ts`);
      expect(result).toMatchObject({ kind: "element", role: "element.play-function" });
    });

    it("parses play-type.ts", () => {
      const result = parseSyncPath(`${base}/play-type.ts`);
      expect(result).toMatchObject({ kind: "element", role: "element.play-type" });
    });

    it("returns null for element comments", () => {
      expect(parseSyncPath(`${base}/comments/2026-01-01_abc/comment.md`)).toBeNull();
    });
  });

  // ─── milestone ───────────────────────────────────────────────────────────────
  describe("milestone files", () => {
    it("parses milestone.json", () => {
      const result = parseSyncPath("milestones/My-Milestone/milestone.json");
      expect(result).toEqual({
        kind: "milestone",
        entityDir: "milestones/My-Milestone",
        role: "milestone.json",
        generated: false,
      });
    });

    it("parses milestone description.md", () => {
      const result = parseSyncPath("milestones/My-Milestone/description.md");
      expect(result).toMatchObject({ kind: "milestone", role: "milestone.description" });
    });
  });

  // ─── element-details ─────────────────────────────────────────────────────────
  describe("element-details files", () => {
    it("parses element-details details.md", () => {
      const result = parseSyncPath("element-details/App/command/Register-User/details.md");
      expect(result).toEqual({
        kind: "element-details",
        entityDir: "element-details/App/command/Register-User",
        role: "element-details.details",
        generated: false,
      });
    });
  });

  // ─── ignored paths ────────────────────────────────────────────────────────────
  describe("ignored paths", () => {
    it("returns null for workspace.json", () => {
      expect(parseSyncPath("workspace.json")).toBeNull();
    });

    it("returns null for uuid-index.json", () => {
      expect(parseSyncPath("uuid-index.json")).toBeNull();
    });

    it("returns null for sync-state.json", () => {
      expect(parseSyncPath("sync-state.json")).toBeNull();
    });

    it("returns null for lane-details", () => {
      expect(parseSyncPath("lane-details/information-flow/My-Lane/details.md")).toBeNull();
    });

    it("handles backslash paths (Windows)", () => {
      const result = parseSyncPath(
        "chapters\\App\\My-Chapter\\slices\\0001_My-Slice\\slice.json",
      );
      expect(result).toMatchObject({ kind: "slice", role: "slice.json" });
    });
  });
});

describe("primaryJsonPath", () => {
  it("returns chapter.json for chapter", () => {
    const parsed = parseSyncPath("chapters/App/Ch/chapter.json")!;
    expect(primaryJsonPath(parsed)).toBe("chapters/App/Ch/chapter.json");
  });

  it("returns slice.json for slice", () => {
    const parsed = parseSyncPath("chapters/App/Ch/slices/0001_Sl/slice.json")!;
    expect(primaryJsonPath(parsed)).toBe("chapters/App/Ch/slices/0001_Sl/slice.json");
  });

  it("returns element.json for element description", () => {
    const base = "chapters/App/Ch/slices/0001_Sl/lanes/system/Ln/elements/0001_El";
    const parsed = parseSyncPath(`${base}/description.md`)!;
    expect(primaryJsonPath(parsed)).toBe(`${base}/element.json`);
  });
});
