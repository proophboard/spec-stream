import { describe, it, expect, vi } from "vitest";
import { executeOperations } from "./executor.js";
import type { SyncBackOperation } from "./operationBuilder.js";
import type { RestClient } from "../sync/restClient.js";

// ─── Mock RestClient ──────────────────────────────────────────────────────────

function makeMockClient(): RestClient & {
  calls: Array<{ method: string; path: string; body?: unknown }>;
} {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];

  const client = {
    calls,
    async postJson(path: string, body: Record<string, unknown>) {
      calls.push({ method: "POST", path, body });
      return {};
    },
    async patchJson(path: string, body: Record<string, unknown>) {
      calls.push({ method: "PATCH", path, body });
      return {};
    },
    async deleteReq(path: string) {
      calls.push({ method: "DELETE", path });
    },
  } as unknown as RestClient & { calls: typeof calls };

  return client;
}

function makeOpts(dryRun = false) {
  const logs: string[] = [];
  return {
    dryRun,
    log: (msg: string) => logs.push(msg),
    logs,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("executeOperations", () => {
  it("returns zero counts for empty operations list", async () => {
    const client = makeMockClient();
    const { dryRun, log } = makeOpts();
    const result = await executeOperations(client, [], { dryRun, log });
    expect(result.executed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("executes element.update-description", async () => {
    const client = makeMockClient();
    const ops: SyncBackOperation[] = [
      {
        kind: "element.update-description",
        chapterId: "chap-1",
        elementId: "elem-1",
        newDescription: "Hello",
      },
    ];
    const { dryRun, log } = makeOpts();
    const result = await executeOperations(client, ops, { dryRun, log });
    expect(result.executed).toBe(1);
    expect(result.failed).toBe(0);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({
      method: "POST",
      path: "/chapters/chap-1/elements/elem-1/description",
      body: { new_description: "Hello" },
    });
  });

  it("executes element.update-details", async () => {
    const client = makeMockClient();
    const ops: SyncBackOperation[] = [
      { kind: "element.update-details", chapterId: "chap-1", elementId: "elem-1", newDetails: "Detail text" },
    ];
    const { dryRun, log } = makeOpts();
    await executeOperations(client, ops, { dryRun, log });
    expect(client.calls[0]).toMatchObject({
      method: "POST",
      path: "/chapters/chap-1/elements/elem-1/details",
      body: { new_details: "Detail text" },
    });
  });

  it("executes slice.update-details", async () => {
    const client = makeMockClient();
    const ops: SyncBackOperation[] = [
      { kind: "slice.update-details", chapterId: "chap-1", sliceId: "slice-1", newDetails: "Notes" },
    ];
    const { dryRun, log } = makeOpts();
    await executeOperations(client, ops, { dryRun, log });
    expect(client.calls[0]).toMatchObject({
      method: "POST",
      path: "/chapters/chap-1/slices/slice-1/details",
      body: { slice_id: "slice-1", new_details: "Notes" },
    });
  });

  it("executes chapter.create", async () => {
    const client = makeMockClient();
    const ops: SyncBackOperation[] = [
      { kind: "chapter.create", name: "My Chapter", context: "App", mode: "event-modeling" },
    ];
    const { dryRun, log } = makeOpts();
    await executeOperations(client, ops, { dryRun, log });
    expect(client.calls[0]).toMatchObject({
      method: "POST",
      path: "/chapters",
      body: { name: "My Chapter", context: "App", mode: "event-modeling" },
    });
  });

  it("executes milestone.create", async () => {
    const client = makeMockClient();
    const ops: SyncBackOperation[] = [
      { kind: "milestone.create", name: "M1", description: "desc", deadline: "2026-12-31", color: "#3b82f6" },
    ];
    const { dryRun, log } = makeOpts();
    await executeOperations(client, ops, { dryRun, log });
    expect(client.calls[0]).toMatchObject({
      method: "POST",
      path: "/milestones",
      body: { name: "M1", description: "desc", deadline: "2026-12-31", color: "#3b82f6" },
    });
  });

  it("executes milestone.update via PATCH", async () => {
    const client = makeMockClient();
    const ops: SyncBackOperation[] = [
      { kind: "milestone.update", milestoneId: "ms-1", name: "New Name" },
    ];
    const { dryRun, log } = makeOpts();
    await executeOperations(client, ops, { dryRun, log });
    expect(client.calls[0]).toMatchObject({
      method: "PATCH",
      path: "/milestones/ms-1",
      body: { name: "New Name" },
    });
  });

  it("executes element.delete via DELETE", async () => {
    const client = makeMockClient();
    const ops: SyncBackOperation[] = [
      { kind: "element.delete", chapterId: "chap-1", elementId: "elem-1" },
    ];
    const { dryRun, log } = makeOpts();
    await executeOperations(client, ops, { dryRun, log });
    expect(client.calls[0]).toMatchObject({
      method: "DELETE",
      path: "/chapters/chap-1/elements/elem-1",
    });
  });

  it("executes element.move", async () => {
    const client = makeMockClient();
    const ops: SyncBackOperation[] = [
      {
        kind: "element.move",
        chapterId: "chap-1",
        elementId: "elem-1",
        newLaneId: "lane-2",
        newSliceId: "slice-2",
        newIndex: 3,
      },
    ];
    const { dryRun, log } = makeOpts();
    await executeOperations(client, ops, { dryRun, log });
    expect(client.calls[0]).toMatchObject({
      method: "POST",
      path: "/chapters/chap-1/elements/elem-1/move",
      body: { element_id: "elem-1", new_lane_id: "lane-2", new_slice_id: "slice-2", new_index: 3 },
    });
  });

  it("executes element.update-config with play_function and play_type", async () => {
    const client = makeMockClient();
    const ops: SyncBackOperation[] = [
      {
        kind: "element.update-config",
        chapterId: "chap-1",
        elementId: "elem-1",
        playFunction: "async () => ({})",
        playType: "{ input: string }",
      },
    ];
    const { dryRun, log } = makeOpts();
    await executeOperations(client, ops, { dryRun, log });
    expect(client.calls[0]).toMatchObject({
      method: "POST",
      path: "/chapters/chap-1/elements/elem-1/config",
      body: { play_function: "async () => ({})", play_type: "{ input: string }" },
    });
  });

  it("URL-encodes IDs with special characters", async () => {
    const client = makeMockClient();
    const ops: SyncBackOperation[] = [
      { kind: "chapter.rename", chapterId: "chap/with space", newName: "New" },
    ];
    const { dryRun, log } = makeOpts();
    await executeOperations(client, ops, { dryRun, log });
    expect(client.calls[0].path).toBe("/chapters/chap%2Fwith%20space/rename");
  });

  // ─── Dry-run ──────────────────────────────────────────────────────────────

  it("dry-run logs operations without calling the API", async () => {
    const client = makeMockClient();
    const ops: SyncBackOperation[] = [
      { kind: "element.update-description", chapterId: "chap-1", elementId: "elem-1", newDescription: "X" },
      { kind: "element.update-details", chapterId: "chap-1", elementId: "elem-1", newDetails: "Y" },
    ];
    const { dryRun, log, logs } = makeOpts(true);
    const result = await executeOperations(client, ops, { dryRun, log });
    expect(result.skipped).toBe(2);
    expect(result.executed).toBe(0);
    expect(client.calls).toHaveLength(0);
    expect(logs.some((l) => l.includes("[dry-run]"))).toBe(true);
  });

  // ─── Error handling ───────────────────────────────────────────────────────

  it("continues after a failed operation (fail-forward)", async () => {
    const client = makeMockClient();
    let callCount = 0;
    vi.spyOn(client, "postJson").mockImplementation(async (path) => {
      callCount++;
      if (callCount === 1) throw new Error("API error");
      return {};
    });

    const ops: SyncBackOperation[] = [
      { kind: "element.update-description", chapterId: "chap-1", elementId: "elem-1", newDescription: "X" },
      { kind: "element.update-details", chapterId: "chap-1", elementId: "elem-1", newDetails: "Y" },
    ];
    const { dryRun, log } = makeOpts();
    const result = await executeOperations(client, ops, { dryRun, log });
    expect(result.failed).toBe(1);
    expect(result.executed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toBe("API error");
  });

  // ─── Chapter operations ───────────────────────────────────────────────────

  it("executes chapter.rename", async () => {
    const client = makeMockClient();
    const ops: SyncBackOperation[] = [
      { kind: "chapter.rename", chapterId: "chap-1", newName: "New Name" },
    ];
    const { dryRun, log } = makeOpts();
    await executeOperations(client, ops, { dryRun, log });
    expect(client.calls[0]).toMatchObject({
      method: "POST",
      path: "/chapters/chap-1/rename",
      body: { new_name: "New Name" },
    });
  });

  it("executes chapter.update-context via PATCH", async () => {
    const client = makeMockClient();
    const ops: SyncBackOperation[] = [
      { kind: "chapter.update-context", chapterId: "chap-1", newContext: "Payments" },
    ];
    const { dryRun, log } = makeOpts();
    await executeOperations(client, ops, { dryRun, log });
    expect(client.calls[0]).toMatchObject({
      method: "PATCH",
      path: "/chapters/chap-1",
      body: { new_context: "Payments" },
    });
  });

  it("executes lane.rename with lane_id in body", async () => {
    const client = makeMockClient();
    const ops: SyncBackOperation[] = [
      { kind: "lane.rename", chapterId: "chap-1", laneId: "lane-1", newLabel: "New Lane" },
    ];
    const { dryRun, log } = makeOpts();
    await executeOperations(client, ops, { dryRun, log });
    expect(client.calls[0]).toMatchObject({
      method: "POST",
      path: "/chapters/chap-1/lanes/lane-1/rename",
      body: { lane_id: "lane-1", new_label: "New Lane" },
    });
  });

  it("executes slice.update-status", async () => {
    const client = makeMockClient();
    const ops: SyncBackOperation[] = [
      { kind: "slice.update-status", chapterId: "chap-1", sliceId: "slice-1", newStatus: "planned" },
    ];
    const { dryRun, log } = makeOpts();
    await executeOperations(client, ops, { dryRun, log });
    expect(client.calls[0]).toMatchObject({
      method: "POST",
      path: "/chapters/chap-1/slices/slice-1/status",
      body: { slice_id: "slice-1", new_status: "planned" },
    });
  });
});
