import { describe, it, expect } from "vitest";
import {
  sanitizeSegment,
  idPrefixedSegment,
  orderedSegment,
  MAX_SEGMENT_LENGTH,
} from "./sanitize.js";

describe("sanitizeSegment", () => {
  it("passes through a clean name", () => {
    expect(sanitizeSegment("Order Shipped", "id")).toBe("Order-Shipped");
  });

  it("replaces path separators and reserved chars", () => {
    expect(sanitizeSegment("a/b\\c:d*e?f", "id")).toBe("a-b-c-d-e-f");
    expect(sanitizeSegment('x"y<z>w|v', "id")).toBe("x-y-z-w-v");
  });

  it("strips control characters", () => {
    expect(sanitizeSegment("a\u0000b\u001fc", "id")).toBe("a-b-c");
  });

  it("collapses whitespace and separator runs", () => {
    expect(sanitizeSegment("a    b", "id")).toBe("a-b");
    expect(sanitizeSegment("a---b", "id")).toBe("a-b");
    expect(sanitizeSegment("a - - b", "id")).toBe("a-b");
  });

  it("trims leading/trailing dots, spaces and dashes", () => {
    expect(sanitizeSegment("  .name.  ", "id")).toBe("name");
    expect(sanitizeSegment("--name--", "id")).toBe("name");
  });

  it("never emits '.' or '..'", () => {
    expect(sanitizeSegment(".", "fallback")).toBe("fallback");
    expect(sanitizeSegment("..", "fallback")).toBe("fallback");
    expect(sanitizeSegment("...", "fallback")).toBe("fallback");
  });

  it("falls back when the result is empty", () => {
    expect(sanitizeSegment("", "the-id")).toBe("the-id");
    expect(sanitizeSegment("///", "the-id")).toBe("the-id");
    expect(sanitizeSegment("   ", "the-id")).toBe("the-id");
  });

  it("enforces max length and re-trims the cut edge", () => {
    const long = "a".repeat(200);
    const out = sanitizeSegment(long, "id");
    expect(out.length).toBe(MAX_SEGMENT_LENGTH);
    const trailingDash = sanitizeSegment("a".repeat(MAX_SEGMENT_LENGTH) + "-tail", "id");
    expect(trailingDash.endsWith("-")).toBe(false);
  });

  it("keeps mixed case and unicode letters", () => {
    expect(sanitizeSegment("Übersicht Prüfung", "id")).toBe("Übersicht-Prüfung");
  });

  it("prevents path traversal via crafted names", () => {
    expect(sanitizeSegment("../../etc/passwd", "id")).toBe("etc-passwd");
    expect(sanitizeSegment("..\\..\\win", "id")).toBe("win");
  });
});

describe("idPrefixedSegment", () => {
  it("combines id and slug", () => {
    expect(idPrefixedSegment("abc123", "My Element")).toBe("abc123_My-Element");
  });

  it("omits the slug when it equals the id (unnamed)", () => {
    expect(idPrefixedSegment("abc123", "")).toBe("abc123");
    expect(idPrefixedSegment("abc123", "///")).toBe("abc123");
  });
});

describe("orderedSegment", () => {
  it("zero-pads the index for lexicographic sort", () => {
    expect(orderedSegment(0, "id", "First")).toBe("0000_id_First");
    expect(orderedSegment(12, "id", "Twelfth")).toBe("0012_id_Twelfth");
  });

  it("clamps negative/NaN indices to 0", () => {
    expect(orderedSegment(-5, "id", "X")).toBe("0000_id_X");
    expect(orderedSegment(Number.NaN, "id", "X")).toBe("0000_id_X");
  });

  it("sorts correctly as strings", () => {
    const segs = [10, 2, 1, 20].map((i) => orderedSegment(i, "id", "n"));
    const sorted = [...segs].sort();
    expect(sorted).toEqual([
      orderedSegment(1, "id", "n"),
      orderedSegment(2, "id", "n"),
      orderedSegment(10, "id", "n"),
      orderedSegment(20, "id", "n"),
    ]);
  });
});
