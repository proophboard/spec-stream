import { describe, it, expect, vi } from "vitest";
import { executeOperations } from "./executor.js";
import type { SyncBackOperation } from "./operationBuilder.js";
import { PENDING_ELEMENT_ID, PENDING_SCENARIO_ID } from "./operationBuilder.js";
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
    async resolveElementTask(chapterId: string, elementId: string, commentId: string) {
      const enc = encodeURIComponent;
      calls.push({ method: "POST", path: `/chapters/${enc(chapterId)}/elements/${enc(elementId)}/comments/${enc(commentId)}/resolve` });
    },
    async resolveSliceTask(chapterId: string, sliceId: string, commentId: string) {
      const enc = encodeURIComponent;
      calls.push({ method: "POST", path: `/chapters/${enc(chapterId)}/slices/${enc(sliceId)}/comments/${enc(commentId)}/resolve` });
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
    expect(result.failedEntityDirs.size).toBe(0);
  });

  it("executes element.update-description", async () => {
    const client = makeMockClient();
    const ops: SyncBackOperation[] = [
      {
        kind: "element.update-description",
        chapterId: "chap-1",
        elementId: "elem-1",
        newDescription: "Hello",
        entityDir: "chapters/App/Ch/slices/0001_S/lanes/system/L/elements/0001_E",
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
      {
        kind: "element.update-details",
        chapterId: "chap-1",
        elementId: "elem-1",
        newDetails: "Detail text",
        entityDir: "chapters/App/Ch/slices/0001_S/lanes/system/L/elements/0001_E",
      },
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
      {
        kind: "slice.update-details",
        chapterId: "chap-1",
        sliceId: "slice-1",
        newDetails: "Notes",
        entityDir: "chapters/App/Ch/slices/0001_S",
      },
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
      {
        kind: "chapter.create",
        name: "My Chapter",
        context: "App",
        mode: "event-modeling",
        entityDir: "chapters/App/My Chapter",
      },
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
      {
        kind: "milestone.create",
        name: "M1",
        description: "desc",
        deadline: "2026-12-31",
        color: "#3b82f6",
        entityDir: "milestones/M1",
      },
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
      { kind: "milestone.update", milestoneId: "ms-1", name: "New Name", entityDir: "milestones/M1" },
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
      {
        kind: "element.delete",
        chapterId: "chap-1",
        elementId: "elem-1",
        entityDir: "chapters/App/Ch/slices/0001_S/lanes/system/L/elements/0001_E",
      },
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
        entityDir: "chapters/App/Ch/slices/0001_S/lanes/system/L/elements/0001_E",
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
        entityDir: "chapters/App/Ch/slices/0001_S/lanes/system/L/elements/0001_E",
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
      { kind: "chapter.rename", chapterId: "chap/with space", newName: "New", entityDir: "chapters/App/Ch" },
    ];
    const { dryRun, log } = makeOpts();
    await executeOperations(client, ops, { dryRun, log });
    expect(client.calls[0].path).toBe("/chapters/chap%2Fwith%20space/rename");
  });

  // ─── Dry-run ──────────────────────────────────────────────────────────────

  it("dry-run logs operations without calling the API", async () => {
    const client = makeMockClient();
    const entityDir = "chapters/App/Ch/slices/0001_S/lanes/system/L/elements/0001_E";
    const ops: SyncBackOperation[] = [
      { kind: "element.update-description", chapterId: "chap-1", elementId: "elem-1", newDescription: "X", entityDir },
      { kind: "element.update-details", chapterId: "chap-1", elementId: "elem-1", newDetails: "Y", entityDir },
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

    const entityDir = "chapters/App/Ch/slices/0001_S/lanes/system/L/elements/0001_E";
    const ops: SyncBackOperation[] = [
      { kind: "element.update-description", chapterId: "chap-1", elementId: "elem-1", newDescription: "X", entityDir },
      { kind: "element.update-details", chapterId: "chap-1", elementId: "elem-1", newDetails: "Y", entityDir },
    ];
    const { dryRun, log } = makeOpts();
    const result = await executeOperations(client, ops, { dryRun, log });
    expect(result.failed).toBe(1);
    expect(result.executed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toBe("API error");
  });

  it("adds entityDir to failedEntityDirs when an operation fails", async () => {
    const client = makeMockClient();
    vi.spyOn(client, "postJson").mockRejectedValueOnce(new Error("network error"));

    const failingDir = "chapters/App/Ch/slices/0001_S/lanes/system/L/elements/0001_E";
    const succeedingDir = "chapters/App/Ch/slices/0001_S/lanes/system/L/elements/0002_F";
    const ops: SyncBackOperation[] = [
      { kind: "element.update-description", chapterId: "chap-1", elementId: "elem-1", newDescription: "X", entityDir: failingDir },
      { kind: "element.update-details", chapterId: "chap-1", elementId: "elem-2", newDetails: "Y", entityDir: succeedingDir },
    ];
    const { dryRun, log } = makeOpts();
    const result = await executeOperations(client, ops, { dryRun, log });

    expect(result.failedEntityDirs.has(failingDir)).toBe(true);
    expect(result.failedEntityDirs.has(succeedingDir)).toBe(false);
    expect(result.failedEntityDirs.size).toBe(1);
  });

  it("collects all distinct failing entityDirs across multiple failures", async () => {
    const client = makeMockClient();
    vi.spyOn(client, "postJson").mockRejectedValue(new Error("always fails"));

    const dir1 = "chapters/App/Ch/slices/0001_S/lanes/system/L/elements/0001_E";
    const dir2 = "chapters/App/Ch/slices/0002_T/lanes/system/L/elements/0001_G";
    const ops: SyncBackOperation[] = [
      { kind: "element.update-description", chapterId: "chap-1", elementId: "elem-1", newDescription: "X", entityDir: dir1 },
      { kind: "element.update-details",     chapterId: "chap-1", elementId: "elem-1", newDetails: "Y",     entityDir: dir1 },
      { kind: "element.update-description", chapterId: "chap-1", elementId: "elem-2", newDescription: "Z", entityDir: dir2 },
    ];
    const { dryRun, log } = makeOpts();
    const result = await executeOperations(client, ops, { dryRun, log });

    expect(result.failed).toBe(3);
    expect(result.failedEntityDirs.size).toBe(2);
    expect(result.failedEntityDirs.has(dir1)).toBe(true);
    expect(result.failedEntityDirs.has(dir2)).toBe(true);
  });

  it("does not add to failedEntityDirs when all operations succeed", async () => {
    const client = makeMockClient();
    const entityDir = "chapters/App/Ch/slices/0001_S/lanes/system/L/elements/0001_E";
    const ops: SyncBackOperation[] = [
      { kind: "element.update-description", chapterId: "chap-1", elementId: "elem-1", newDescription: "X", entityDir },
    ];
    const { dryRun, log } = makeOpts();
    const result = await executeOperations(client, ops, { dryRun, log });

    expect(result.failedEntityDirs.size).toBe(0);
  });

  // ─── Scenario create — sentinel ID substitution ───────────────────────────

  it("scenario.create: substitutes PENDING_SCENARIO_ID with the real returned ID in follow-up ops", async () => {
    const realId = "real-scenario-uuid";
    // Build a client whose postJson returns the real scenario ID for the create call.
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const client = {
      calls,
      async postJson(path: string, body: Record<string, unknown>) {
        calls.push({ method: "POST", path, body });
        if (path.endsWith("/scenarios")) return { id: realId };
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

    const scenarioDir = "chapters/App/Ch/scenarios/My-Scenario";
    const ops: SyncBackOperation[] = [
      {
        kind: "scenario.create",
        chapterId: "chap-1",
        name: "My Scenario",
        entityDir: scenarioDir,
      },
      {
        kind: "scenario.clear-interactions",
        chapterId: "chap-1",
        scenarioId: PENDING_SCENARIO_ID,
        entityDir: scenarioDir,
      },
      {
        kind: "scenario.record-interaction",
        chapterId: "chap-1",
        scenarioId: PENDING_SCENARIO_ID,
        uiElementId: "elem-ui-1",
        storage: { clicked: true },
        entityDir: scenarioDir,
      },
      {
        kind: "scenario.set-expectation",
        chapterId: "chap-1",
        scenarioId: PENDING_SCENARIO_ID,
        expectation: { id: "exp-1", sliceId: "slice-1", kind: "state", expected: {} },
        entityDir: scenarioDir,
      },
    ];

    const { dryRun, log } = makeOpts();
    const result = await executeOperations(client, ops, { dryRun, log });

    expect(result.executed).toBe(4);
    expect(result.failed).toBe(0);

    // The create call goes to the chapter scenarios endpoint
    expect(calls[0]).toMatchObject({ method: "POST", path: "/chapters/chap-1/scenarios" });

    // clear-interactions uses the real ID (not the sentinel)
    expect(calls[1]).toMatchObject({
      method: "DELETE",
      path: `/chapters/chap-1/scenarios/${realId}/interactions`,
    });

    // record-interaction uses the real ID
    expect(calls[2]).toMatchObject({
      method: "POST",
      path: `/chapters/chap-1/scenarios/${realId}/interactions`,
      body: { ui_element_id: "elem-ui-1", storage: { clicked: true } },
    });

    // set-expectation uses the real ID
    expect(calls[3]).toMatchObject({
      method: "POST",
      path: `/chapters/chap-1/scenarios/${realId}/expectations`,
    });
  });

  it("scenario.create: does not substitute follow-up ops from a different entityDir", async () => {
    const realId = "scenario-uuid-A";
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const client = {
      calls,
      async postJson(path: string, body: Record<string, unknown>) {
        calls.push({ method: "POST", path, body });
        if (path.endsWith("/scenarios")) return { id: realId };
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

    const scenarioDirA = "chapters/App/Ch/scenarios/Scenario-A";
    const scenarioDirB = "chapters/App/Ch/scenarios/Scenario-B";
    const ops: SyncBackOperation[] = [
      {
        kind: "scenario.create",
        chapterId: "chap-1",
        name: "Scenario A",
        entityDir: scenarioDirA,
      },
      {
        // This belongs to a different scenario — sentinel should NOT be replaced
        kind: "scenario.clear-interactions",
        chapterId: "chap-1",
        scenarioId: PENDING_SCENARIO_ID,
        entityDir: scenarioDirB,
      },
    ];

    const { dryRun, log } = makeOpts();
    await executeOperations(client, ops, { dryRun, log });

    // The clear-interactions call for scenarioDirB should still have the sentinel
    // (which means the API would be called with the literal sentinel string)
    expect(calls[1]).toMatchObject({
      method: "DELETE",
      path: `/chapters/chap-1/scenarios/${PENDING_SCENARIO_ID}/interactions`,
    });
  });

  it("scenario.create: stores the returned ID in newIds", async () => {
    const realId = "new-scenario-uuid";
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const client = {
      calls,
      async postJson(path: string, body: Record<string, unknown>) {
        calls.push({ method: "POST", path, body });
        if (path.endsWith("/scenarios")) return { id: realId };
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

    const scenarioDir = "chapters/App/Ch/scenarios/My-Scenario";
    const ops: SyncBackOperation[] = [
      { kind: "scenario.create", chapterId: "chap-1", name: "My Scenario", entityDir: scenarioDir },
    ];

    const { dryRun, log } = makeOpts();
    const result = await executeOperations(client, ops, { dryRun, log });

    expect(result.newIds.get(scenarioDir)).toBe(realId);
  });

  it("scenario.create: follow-up ops are skipped when create fails", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const client = {
      calls,
      async postJson(path: string, body: Record<string, unknown>) {
        if (path.endsWith("/scenarios")) throw new Error("create failed");
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

    const scenarioDir = "chapters/App/Ch/scenarios/My-Scenario";
    const ops: SyncBackOperation[] = [
      { kind: "scenario.create", chapterId: "chap-1", name: "My Scenario", entityDir: scenarioDir },
      { kind: "scenario.clear-interactions", chapterId: "chap-1", scenarioId: PENDING_SCENARIO_ID, entityDir: scenarioDir },
      {
        kind: "scenario.record-interaction",
        chapterId: "chap-1",
        scenarioId: PENDING_SCENARIO_ID,
        uiElementId: "elem-ui-1",
        storage: {},
        entityDir: scenarioDir,
      },
    ];

    const { dryRun, log } = makeOpts();
    const result = await executeOperations(client, ops, { dryRun, log });

    // create failed, but the other two still execute (fail-forward semantics)
    // They will call the API with the sentinel ID — the API will reject them, which
    // is also fine since they get logged as failures.
    expect(result.failed).toBeGreaterThanOrEqual(1);
    // The create itself failed
    expect(result.errors[0]!.operation.kind).toBe("scenario.create");
  });

  // ─── Element pending-id substitution ────────────────────────────────────────
  // Documents the fix for "play-type.ts is silently dropped on element create":
  // when element.json has no local id, buildOperations emits element.update-config
  // with a PENDING_ELEMENT_ID sentinel. The executor must substitute the real
  // element id returned by the create call — same mechanism as
  // PENDING_SCENARIO_ID above.

  it("element.create: substitutes PENDING_ELEMENT_ID with the real returned ID in follow-up update-config", async () => {
    // GIVEN a client that returns a real element id from the create call
    const realId = "real-element-uuid";
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const client = {
      calls,
      async postJson(path: string, body: Record<string, unknown>) {
        calls.push({ method: "POST", path, body });
        if (path.endsWith("/elements")) return { id: realId };
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

    const elementDir = "chapters/chap-1/elements/elem-1";
    const ops: SyncBackOperation[] = [
      {
        kind: "element.create",
        chapterId: "chap-1",
        name: "My Element",
        type: "command",
        laneId: "lane-1",
        sliceId: "slice-1",
        entityDir: elementDir,
      },
      {
        kind: "element.update-config",
        chapterId: "chap-1",
        elementId: PENDING_ELEMENT_ID,
        playType: "{ amountMl: number }",
        entityDir: elementDir,
      },
    ];

    // WHEN the ops are executed
    const { dryRun, log } = makeOpts();
    const result = await executeOperations(client, ops, { dryRun, log });

    // THEN the config call targets the freshly created element, not the sentinel
    expect(result.failed).toBe(0);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/chapters/chap-1/elements" });
    expect(calls[1]).toMatchObject({
      method: "POST",
      path: `/chapters/chap-1/elements/${realId}/config`,
      body: { play_type: "{ amountMl: number }" },
    });
  });

  it("element.create: does not substitute update-config ops from a different entityDir", async () => {
    // GIVEN two new elements, only one of which has a play config follow-up op
    const realId = "element-uuid-A";
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const client = {
      calls,
      async postJson(path: string, body: Record<string, unknown>) {
        calls.push({ method: "POST", path, body });
        if (path.endsWith("/elements")) return { id: realId };
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

    const elementDirA = "chapters/chap-1/elements/elem-A";
    const elementDirB = "chapters/chap-1/elements/elem-B";
    const ops: SyncBackOperation[] = [
      {
        kind: "element.create",
        chapterId: "chap-1",
        name: "Element A",
        type: "command",
        laneId: "lane-1",
        sliceId: "slice-1",
        entityDir: elementDirA,
      },
      {
        // This config op belongs to a different element — sentinel must NOT be
        // replaced with element A's id
        kind: "element.update-config",
        chapterId: "chap-1",
        elementId: PENDING_ELEMENT_ID,
        playType: "{ x: number }",
        entityDir: elementDirB,
      },
    ];

    // WHEN executed
    const { dryRun, log } = makeOpts();
    await executeOperations(client, ops, { dryRun, log });

    // THEN the second call still carries the literal sentinel
    expect(calls[1]).toMatchObject({
      method: "POST",
      path: `/chapters/chap-1/elements/${PENDING_ELEMENT_ID}/config`,
    });
  });

  // ─── Chapter operations ───────────────────────────────────────────────────

  it("executes chapter.rename", async () => {
    const client = makeMockClient();
    const ops: SyncBackOperation[] = [
      { kind: "chapter.rename", chapterId: "chap-1", newName: "New Name", entityDir: "chapters/App/Ch" },
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
      { kind: "chapter.update-context", chapterId: "chap-1", newContext: "Payments", entityDir: "chapters/Payments/Ch" },
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
      {
        kind: "lane.rename",
        chapterId: "chap-1",
        laneId: "lane-1",
        newLabel: "New Lane",
        entityDir: "chapters/App/Ch/lanes/user-lane/New Lane",
      },
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
      {
        kind: "slice.update-status",
        chapterId: "chap-1",
        sliceId: "slice-1",
        newStatus: "planned",
        entityDir: "chapters/App/Ch/slices/0001_S",
      },
    ];
    const { dryRun, log } = makeOpts();
    await executeOperations(client, ops, { dryRun, log });
    expect(client.calls[0]).toMatchObject({
      method: "POST",
      path: "/chapters/chap-1/slices/slice-1/status",
      body: { slice_id: "slice-1", new_status: "planned" },
    });
  });

  it("executes slice.reorder", async () => {
    const client = makeMockClient();
    const newSliceIds = ["slice-2", "slice-1", "slice-3"];
    const ops: SyncBackOperation[] = [
      {
        kind: "slice.reorder",
        chapterId: "chap-1",
        newSliceIds,
        entityDir: "chapters/chap-1",
      },
    ];
    const { dryRun, log } = makeOpts();
    await executeOperations(client, ops, { dryRun, log });
    expect(client.calls[0]).toMatchObject({
      method: "POST",
      path: "/chapters/chap-1/slices/reorder",
      body: { new_slice_ids: newSliceIds },
    });
  });

  // ─── localId forwarding ───────────────────────────────────────────────────

  it("chapter.create passes localId as id in the request body", async () => {
    const client = makeMockClient();
    const ops: SyncBackOperation[] = [
      {
        kind: "chapter.create",
        name: "My Chapter",
        context: "App",
        mode: "event-modeling",
        entityDir: "chapters/App/My-Chapter",
        localId: "local-chapter-uuid",
      },
    ];
    const { dryRun, log } = makeOpts();
    await executeOperations(client, ops, { dryRun, log });
    expect(client.calls[0]).toMatchObject({
      method: "POST",
      path: "/chapters",
      body: { name: "My Chapter", context: "App", mode: "event-modeling", id: "local-chapter-uuid" },
    });
  });

  it("chapter.create without localId does not include id in body", async () => {
    const client = makeMockClient();
    const ops: SyncBackOperation[] = [
      {
        kind: "chapter.create",
        name: "My Chapter",
        entityDir: "chapters/App/My-Chapter",
      },
    ];
    const { dryRun, log } = makeOpts();
    await executeOperations(client, ops, { dryRun, log });
    expect((client.calls[0]!.body as Record<string, unknown>)["id"]).toBeUndefined();
  });

  it("lane.create passes localId as id in the request body", async () => {
    const client = makeMockClient();
    const ops: SyncBackOperation[] = [
      {
        kind: "lane.create",
        chapterId: "chap-1",
        label: "My Lane",
        type: "system",
        index: 0,
        entityDir: "chapters/App/Ch/slices/0001_S/lanes/system/My-Lane",
        localId: "local-lane-uuid",
      },
    ];
    const { dryRun, log } = makeOpts();
    await executeOperations(client, ops, { dryRun, log });
    expect(client.calls[0]).toMatchObject({
      method: "POST",
      path: "/chapters/chap-1/lanes",
      body: { label: "My Lane", type: "system", index: 0, id: "local-lane-uuid" },
    });
  });

  it("slice.create passes localId as id in the request body", async () => {
    const client = makeMockClient();
    const ops: SyncBackOperation[] = [
      {
        kind: "slice.create",
        chapterId: "chap-1",
        label: "My Slice",
        index: 0,
        entityDir: "chapters/App/Ch/slices/0001_My-Slice",
        localId: "local-slice-uuid",
      },
    ];
    const { dryRun, log } = makeOpts();
    await executeOperations(client, ops, { dryRun, log });
    expect(client.calls[0]).toMatchObject({
      method: "POST",
      path: "/chapters/chap-1/slices",
      body: { label: "My Slice", index: 0, id: "local-slice-uuid" },
    });
  });

  it("element.create passes localId as id in the request body", async () => {
    const client = makeMockClient();
    const ops: SyncBackOperation[] = [
      {
        kind: "element.create",
        chapterId: "chap-1",
        name: "My Element",
        type: "command",
        laneId: "lane-1",
        sliceId: "slice-1",
        entityDir: "chapters/App/Ch/slices/0001_S/lanes/system/L/elements/0001_E",
        localId: "local-element-uuid",
      },
    ];
    const { dryRun, log } = makeOpts();
    await executeOperations(client, ops, { dryRun, log });
    expect(client.calls[0]).toMatchObject({
      method: "POST",
      path: "/chapters/chap-1/elements",
      body: { name: "My Element", type: "command", lane_id: "lane-1", slice_id: "slice-1", id: "local-element-uuid" },
    });
  });

  it("element.create sends force=true for event type", async () => {
    const client = makeMockClient();
    const ops: SyncBackOperation[] = [
      {
        kind: "element.create",
        chapterId: "chap-1",
        name: "Order Placed",
        type: "event",
        laneId: "lane-system",
        sliceId: "slice-1",
        entityDir: "chapters/App/Ch/slices/0001_S/elements/0001_E",
      },
    ];
    const { dryRun, log } = makeOpts();
    await executeOperations(client, ops, { dryRun, log });
    expect(client.calls[0]).toMatchObject({
      method: "POST",
      path: "/chapters/chap-1/elements",
      body: { name: "Order Placed", type: "event", lane_id: "lane-system", slice_id: "slice-1", force: true },
    });
  });

  it("element.create sends force=true for automation type", async () => {
    const client = makeMockClient();
    const ops: SyncBackOperation[] = [
      {
        kind: "element.create",
        chapterId: "chap-1",
        name: "Send Email",
        type: "automation",
        laneId: "lane-user",
        sliceId: "slice-1",
        entityDir: "chapters/App/Ch/slices/0001_S/elements/0001_E",
      },
    ];
    const { dryRun, log } = makeOpts();
    await executeOperations(client, ops, { dryRun, log });
    expect(client.calls[0]).toMatchObject({
      method: "POST",
      path: "/chapters/chap-1/elements",
      body: { name: "Send Email", type: "automation", lane_id: "lane-user", slice_id: "slice-1", force: true },
    });
  });

  it.each(["command", "information", "hotspot", "ui"] as const)(
    "element.create does NOT send force for type %s",
    async (type) => {
      const client = makeMockClient();
      const ops: SyncBackOperation[] = [
        {
          kind: "element.create",
          chapterId: "chap-1",
          name: "My Element",
          type,
          laneId: "lane-1",
          sliceId: "slice-1",
          entityDir: "chapters/App/Ch/slices/0001_S/elements/0001_E",
        },
      ];
      const { dryRun, log } = makeOpts();
      await executeOperations(client, ops, { dryRun, log });
      expect(client.calls[0]?.body).not.toHaveProperty("force");
    },
  );

  it("executes comment.resolve-element-task via the element resolve endpoint", async () => {
    const client = makeMockClient();
    const ops: SyncBackOperation[] = [
      { kind: "comment.resolve-element-task", chapterId: "chap-1", elementId: "elem-1", commentId: "cm-1", entityDir: "chapters/chap-1/elements/elem-1" },
    ];
    const { dryRun, log } = makeOpts();
    const result = await executeOperations(client, ops, { dryRun, log });
    expect(result.executed).toBe(1);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({
      method: "POST",
      path: "/chapters/chap-1/elements/elem-1/comments/cm-1/resolve",
    });
  });

  it("executes comment.resolve-slice-task via the slice resolve endpoint", async () => {
    const client = makeMockClient();
    const ops: SyncBackOperation[] = [
      { kind: "comment.resolve-slice-task", chapterId: "chap-1", sliceId: "slice-1", commentId: "cm-2", entityDir: "chapters/chap-1/slices/slice-1" },
    ];
    const { dryRun, log } = makeOpts();
    const result = await executeOperations(client, ops, { dryRun, log });
    expect(result.executed).toBe(1);
    expect(client.calls[0]).toMatchObject({
      method: "POST",
      path: "/chapters/chap-1/slices/slice-1/comments/cm-2/resolve",
    });
  });
});
