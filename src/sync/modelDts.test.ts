import { describe, it, expect } from "vitest";
import { buildWorkspaceModelDts } from "./modelDts.js";
import type { ModelState } from "./model.js";

function emptyState(): ModelState {
  return {
    workspaceId: "ws-1",
    workspaceName: "Test Workspace",
    chapters: new Map(),
    slices: new Map(),
    lanes: new Map(),
    elements: new Map(),
    milestones: new Map(),
    scenarios: new Map(),
    htmlSnippets: new Map(),
    sharedLaneDetails: new Map(),
  };
}

describe("buildWorkspaceModelDts", () => {
  it("generates minimal valid types when there are no elements", () => {
    const state = emptyState();
    const dts = buildWorkspaceModelDts(state);
    
    expect(dts).toContain("type CommandName = string");
    expect(dts).toContain("type EventName = string");
    expect(dts).toContain("type ContextName = string");
    expect(dts).toContain("interface CommandPayloads {}");
    expect(dts).toContain("interface EventPayloads {}");
    expect(dts).toContain("interface UiInputs {}");
    expect(dts).toContain("type ProjectionPatch = Record<string, Record<string, unknown>>");
    expect(dts).toContain("declare global");
    expect(dts).toContain("export {};");
  });

  it("aggregates command names across all chapters", () => {
    const state = emptyState();
    const laneId = "lane-1";
    const sliceId = "slice-1";
    
    // Add chapter
    state.chapters.set("chap-1", {
      id: "chap-1",
      name: "Chapter 1",
      context: "App",
      index: 0,
      mode: "event-modeling",
      sliceOrder: [sliceId],
      laneOrder: [laneId],
    });
    
    state.lanes.set(laneId, {
      id: laneId,
      label: "System",
      type: "system",
      chapterId: "chap-1",
      index: 0,
    });
    
    state.slices.set(sliceId, {
      id: sliceId,
      label: "Write",
      chapterId: "chap-1",
      index: 0,
    });
    
    // Add commands from different contexts
    state.elements.set("cmd-1", {
      id: "cmd-1",
      type: "command",
      name: "Add User",
      context: "User Management",
      description: "",
      details: "",
      laneId,
      sliceId,
      chapterId: "chap-1",
      index: 0,
    });
    
    state.elements.set("cmd-2", {
      id: "cmd-2",
      type: "command",
      name: "Remove User",
      context: "User Management",
      description: "",
      details: "",
      laneId,
      sliceId,
      chapterId: "chap-1",
      index: 1,
    });
    
    // Another chapter with same command name
    state.chapters.set("chap-2", {
      id: "chap-2",
      name: "Chapter 2",
      context: "Data",
      index: 1,
      mode: "event-modeling",
      sliceOrder: [sliceId],
      laneOrder: [laneId],
    });
    
    state.elements.set("cmd-3", {
      id: "cmd-3",
      type: "command",
      name: "Add User",  // Same name as cmd-1
      context: "Data",
      description: "",
      details: "",
      laneId,
      sliceId,
      chapterId: "chap-2",
      index: 0,
    });
    
    const dts = buildWorkspaceModelDts(state);
    
    // Command names should be deduplicated and sorted
    expect(dts).toContain('"Add User" | "Remove User"');
    expect(dts).not.toContain('"Add User" | "Remove User" | "Add User"'); // no duplicates
  });

  it("aggregates event names across all chapters", () => {
    const state = emptyState();
    const laneId = "lane-1";
    const sliceId = "slice-1";
    
    state.chapters.set("chap-1", {
      id: "chap-1",
      name: "Chapter 1",
      context: "App",
      index: 0,
      mode: "event-modeling",
      sliceOrder: [sliceId],
      laneOrder: [laneId],
    });
    
    state.lanes.set(laneId, {
      id: laneId,
      label: "System",
      type: "system",
      chapterId: "chap-1",
      index: 0,
    });
    
    state.slices.set(sliceId, {
      id: sliceId,
      label: "Write",
      chapterId: "chap-1",
      index: 0,
    });
    
    state.elements.set("evt-1", {
      id: "evt-1",
      type: "event",
      name: "User Added",
      context: "User Management",
      description: "",
      details: "",
      laneId,
      sliceId,
      chapterId: "chap-1",
      index: 0,
    });
    
    state.elements.set("evt-2", {
      id: "evt-2",
      type: "event",
      name: "User Removed",
      context: "User Management",
      description: "",
      details: "",
      laneId,
      sliceId,
      chapterId: "chap-1",
      index: 1,
    });
    
    const dts = buildWorkspaceModelDts(state);
    
    expect(dts).toContain('"User Added" | "User Removed"');
  });

  it("aggregates contexts across all chapters", () => {
    const state = emptyState();
    const laneId = "lane-1";
    const sliceId = "slice-1";
    
    state.chapters.set("chap-1", {
      id: "chap-1",
      name: "Chapter 1",
      context: "App",
      index: 0,
      mode: "event-modeling",
      sliceOrder: [sliceId],
      laneOrder: [laneId],
    });
    
    state.lanes.set(laneId, {
      id: laneId,
      label: "System",
      type: "system",
      chapterId: "chap-1",
      index: 0,
    });
    
    state.slices.set(sliceId, {
      id: sliceId,
      label: "Write",
      chapterId: "chap-1",
      index: 0,
    });
    
    state.elements.set("cmd-1", {
      id: "cmd-1",
      type: "command",
      name: "Add User",
      context: "User Management",
      description: "",
      details: "",
      laneId,
      sliceId,
      chapterId: "chap-1",
      index: 0,
    });
    
    state.elements.set("cmd-2", {
      id: "cmd-2",
      type: "command",
      name: "Add Order",
      context: "Order Processing",
      description: "",
      details: "",
      laneId,
      sliceId,
      chapterId: "chap-1",
      index: 1,
    });
    
    const dts = buildWorkspaceModelDts(state);
    
    // Contexts should be deduplicated and sorted
    expect(dts).toContain('"Order Processing" | "User Management"');
  });

  it("builds CommandPayloads interface for typed commands", () => {
    const state = emptyState();
    const laneId = "lane-1";
    const sliceId = "slice-1";
    
    state.chapters.set("chap-1", {
      id: "chap-1",
      name: "Chapter 1",
      context: "App",
      index: 0,
      mode: "event-modeling",
      sliceOrder: [sliceId],
      laneOrder: [laneId],
    });
    
    state.lanes.set(laneId, {
      id: laneId,
      label: "System",
      type: "system",
      chapterId: "chap-1",
      index: 0,
    });
    
    state.slices.set(sliceId, {
      id: sliceId,
      label: "Write",
      chapterId: "chap-1",
      index: 0,
    });
    
    state.elements.set("cmd-1", {
      id: "cmd-1",
      type: "command",
      name: "Add User",
      context: "User Management",
      description: "",
      details: "",
      laneId,
      sliceId,
      chapterId: "chap-1",
      index: 0,
      playType: "{ name: string; email: string }",
    });
    
    const dts = buildWorkspaceModelDts(state);
    
    expect(dts).toContain("interface CommandPayloads");
    expect(dts).toContain('"Add User": { name: string; email: string }');
  });

  it("builds RuntimeState with projection keys from Information elements", () => {
    const state = emptyState();
    const laneId = "lane-1";
    const sliceId = "slice-1";
    
    state.chapters.set("chap-1", {
      id: "chap-1",
      name: "Chapter 1",
      context: "App",
      index: 0,
      mode: "event-modeling",
      sliceOrder: [sliceId],
      laneOrder: [laneId],
    });
    
    state.lanes.set(laneId, {
      id: laneId,
      label: "System",
      type: "system",
      chapterId: "chap-1",
      index: 0,
    });
    
    state.slices.set(sliceId, {
      id: sliceId,
      label: "Write",
      chapterId: "chap-1",
      index: 0,
    });
    
    state.elements.set("info-1", {
      id: "info-1",
      type: "information",
      name: "User List",
      context: "User Management",
      description: "",
      details: "",
      laneId,
      sliceId,
      chapterId: "chap-1",
      index: 0,
      playType: "User[]",
    });
    
    const dts = buildWorkspaceModelDts(state);
    
    // Check RuntimeState interface augmentation
    expect(dts).toContain("interface RuntimeState");
    expect(dts).toContain("UserList: User[]");
    expect(dts).toContain("namespace RuntimeState");
    expect(dts).toContain("namespace UserManagement");
  });
});
