import { describe, it, expect } from "vitest";
import { normalizeRow, type ChangelogEventRow } from "./events.js";

function baseRow(overrides: Partial<ChangelogEventRow> = {}): ChangelogEventRow {
  return {
    id: "row-id-1",
    workspace_id: "ws-1",
    chapter_id: "ch-1",
    element_id: "el-1",
    slice_id: "sl-1",
    user_id: "user-1",
    event_type: "element-description-changed",
    event_data: {
      id: "event-id-1",
      type: "element-description-changed",
      timestamp: 1700000000000,
      chapterId: "ch-1",
      chapterName: "Checkout",
      elementId: "el-1",
      elementName: "Place Order",
      elementType: "command",
      sliceId: "sl-1",
      workspaceId: "ws-1",
      oldValue: { description: "old" },
      newValue: { description: "new" },
    },
    created_at: "2026-09-14T10:00:00.000Z",
    ...overrides,
  };
}

describe("normalizeRow", () => {
  it("normalizes a complete row using event_data fields", () => {
    const ev = normalizeRow(baseRow());
    expect(ev.id).toBe("event-id-1");
    expect(ev.type).toBe("element-description-changed");
    expect(ev.timestamp).toBe(1700000000000);
    expect(ev.workspaceId).toBe("ws-1");
    expect(ev.chapterId).toBe("ch-1");
    expect(ev.chapterName).toBe("Checkout");
    expect(ev.elementId).toBe("el-1");
    expect(ev.elementName).toBe("Place Order");
    expect(ev.elementType).toBe("command");
    expect(ev.sliceId).toBe("sl-1");
    expect(ev.addedByAgent).toBe(false);
    expect(ev.data).toMatchObject({ newValue: { description: "new" } });
    expect(ev.row.id).toBe("row-id-1");
  });

  it("falls back to row columns when event_data omits envelope fields", () => {
    const ev = normalizeRow(
      baseRow({
        event_data: { oldValue: {}, newValue: {} }, // no type/ids in payload
      }),
    );
    expect(ev.id).toBe("row-id-1"); // from row.id
    expect(ev.type).toBe("element-description-changed"); // from row.event_type
    expect(ev.chapterId).toBe("ch-1"); // from row.chapter_id
    expect(ev.elementId).toBe("el-1"); // from row.element_id
    expect(ev.sliceId).toBe("sl-1"); // from row.slice_id
    expect(ev.workspaceId).toBe("ws-1"); // from row.workspace_id
    expect(ev.userId).toBe("user-1"); // from row.user_id
  });

  it("derives timestamp from created_at when event_data.timestamp is absent", () => {
    const ev = normalizeRow(baseRow({ event_data: { type: "slice-added" } }));
    expect(ev.timestamp).toBe(Date.parse("2026-09-14T10:00:00.000Z"));
  });

  it("prefers event_data.type over row.event_type (agent-enriched)", () => {
    const ev = normalizeRow(
      baseRow({ event_type: "row-type", event_data: { type: "data-type" } }),
    );
    expect(ev.type).toBe("data-type");
  });

  it("reads addedByAgent from event_data", () => {
    const ev = normalizeRow(baseRow({ event_data: { type: "x", addedByAgent: true } }));
    expect(ev.addedByAgent).toBe(true);
  });

  it("accepts unknown/new event types (open union)", () => {
    const ev = normalizeRow(baseRow({ event_type: "some-future-event", event_data: null }));
    expect(ev.type).toBe("some-future-event");
  });

  it("handles null chapter_id/element_id/slice_id", () => {
    const ev = normalizeRow(
      baseRow({
        chapter_id: null,
        element_id: null,
        slice_id: null,
        event_data: { type: "chapter-removed" },
      }),
    );
    expect(ev.chapterId).toBeNull();
    expect(ev.elementId).toBeUndefined();
    expect(ev.sliceId).toBeUndefined();
  });

  it("defaults data to {} when event_data is null", () => {
    const ev = normalizeRow(baseRow({ event_data: null }));
    expect(ev.data).toEqual({});
  });

  it("throws on missing workspace_id", () => {
    expect(() => normalizeRow(baseRow({ workspace_id: "" }))).toThrow(/workspace_id/);
  });

  it("throws when both event_type and event_data.type are missing", () => {
    expect(() => normalizeRow(baseRow({ event_type: "", event_data: {} }))).toThrow(
      /event_type/,
    );
  });

  it("throws on non-object row", () => {
    // @ts-expect-error testing runtime guard
    expect(() => normalizeRow(null)).toThrow(/Invalid changelog row/);
  });
});
