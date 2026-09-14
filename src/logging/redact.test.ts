import { describe, it, expect } from "vitest";
import { redactString, redactValue } from "./redact.js";

describe("redactString", () => {
  it("masks pb_ API keys", () => {
    expect(redactString("key is pb_9cb82dfad2254f4e847a23ee90cf51ef done")).toBe(
      "key is pb_*** done",
    );
  });

  it("masks JWT tokens", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc-DEF_123";
    expect(redactString(`token=${jwt}`)).toBe("token=***.jwt.***");
  });

  it("leaves normal text unchanged", () => {
    expect(redactString("nothing secret here")).toBe("nothing secret here");
  });

  it("masks multiple occurrences", () => {
    expect(redactString("pb_aaa and pb_bbb")).toBe("pb_*** and pb_***");
  });
});

describe("redactValue", () => {
  it("redacts strings recursively in objects and arrays", () => {
    const input = {
      note: "use pb_secret123",
      list: ["ok", "eyJa.eyJb.ccc"],
      nested: { text: "pb_deadbeef" },
    };
    expect(redactValue(input)).toEqual({
      note: "use pb_***",
      list: ["ok", "***.jwt.***"],
      nested: { text: "pb_***" },
    });
  });

  it("masks known secret field names by key", () => {
    const input = {
      access_token: "eyJx.y.z",
      refresh_token: "whatever",
      Authorization: "Bearer pb_x",
      password: "hunter2",
      keep: "visible",
    };
    expect(redactValue(input)).toEqual({
      access_token: "***",
      refresh_token: "***",
      Authorization: "***",
      password: "***",
      keep: "visible",
    });
  });

  it("passes through non-secret primitives", () => {
    expect(redactValue(42)).toBe(42);
    expect(redactValue(true)).toBe(true);
    expect(redactValue(null)).toBe(null);
  });
});
