import { describe, it, expect } from "vitest";
import { RestClient, RestError } from "./restClient.js";

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

function clientWith(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { client: RestClient; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  const client = new RestClient({
    endpoint: "https://flow.prooph-board.com/api/",
    apiKey: "pb_test",
    fetchImpl,
  });
  return { client, calls };
}

describe("RestClient", () => {
  it("GETs /chapters with bearer auth and strips trailing slash from endpoint", async () => {
    const { client, calls } = clientWith(() => jsonResponse(200, [{ id: "c1" }]));
    const result = await client.listChapters();
    expect(result).toEqual([{ id: "c1" }]);
    expect(calls[0].url).toBe("https://flow.prooph-board.com/api/chapters");
    expect((calls[0].init?.headers as Record<string, string>).authorization).toBe("Bearer pb_test");
  });

  it("GETs a single chapter by id (url-encoded)", async () => {
    const { client, calls } = clientWith(() => jsonResponse(200, { id: "c 1" }));
    await client.getChapter("c 1");
    expect(calls[0].url).toBe("https://flow.prooph-board.com/api/chapters/c%201");
  });

  it("GETs /milestones", async () => {
    const { client, calls } = clientWith(() => jsonResponse(200, []));
    await client.listMilestones();
    expect(calls[0].url).toBe("https://flow.prooph-board.com/api/milestones");
  });

  it("throws a fatal unauthorized error on 401", async () => {
    const { client } = clientWith(() => jsonResponse(401, {}));
    await expect(client.listChapters()).rejects.toMatchObject({
      name: "RestError",
      kind: "unauthorized",
    });
    const err = await client.listChapters().catch((e) => e as RestError);
    expect(err.retryable).toBe(false);
  });

  it("categorizes 429 and 5xx as retryable", async () => {
    const rl = clientWith(() => jsonResponse(429, {}));
    await expect(rl.client.listChapters()).rejects.toMatchObject({ kind: "rate_limited" });
    const srv = clientWith(() => jsonResponse(503, {}));
    const err = await srv.client.listChapters().catch((e) => e as RestError);
    expect(err.kind).toBe("server");
    expect(err.retryable).toBe(true);
  });

  it("categorizes a thrown fetch as a network error", async () => {
    const { client } = clientWith(() => {
      throw new Error("ECONNREFUSED");
    });
    await expect(client.listChapters()).rejects.toMatchObject({ kind: "network" });
  });

  it("categorizes invalid JSON as malformed", async () => {
    const { client } = clientWith(
      () =>
        ({
          status: 200,
          ok: true,
          json: async () => {
            throw new Error("bad json");
          },
        }) as unknown as Response,
    );
    await expect(client.listChapters()).rejects.toMatchObject({ kind: "malformed" });
  });
});

describe("RestClient.fetchChangelogSince", () => {
  function row(id: string) {
    return {
      id,
      chapter_id: null,
      element_id: null,
      slice_id: null,
      user_id: "u",
      event_type: "element-renamed",
      event_data: {},
      created_at: "2026-10-03T00:00:00Z",
    };
  }

  it("sends since/limit/offset and returns a single page", async () => {
    const { client, calls } = clientWith(() => jsonResponse(200, [row("a"), row("b")]));
    const result = await client.fetchChangelogSince("2026-10-03T00:00:00Z", { pageSize: 100 });
    expect(result).toHaveLength(2);
    const url = new URL(calls[0].url);
    expect(url.searchParams.get("since")).toBe("2026-10-03T00:00:00Z");
    expect(url.searchParams.get("limit")).toBe("100");
    expect(url.searchParams.get("offset")).toBe("0");
  });

  it("paginates until a short page is returned", async () => {
    let call = 0;
    const { client, calls } = clientWith(() => {
      call++;
      // full page, then a short page
      return jsonResponse(200, call === 1 ? [row("a"), row("b")] : [row("c")]);
    });
    const result = await client.fetchChangelogSince("t", { pageSize: 2 });
    expect(result.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(calls.length).toBe(2);
    expect(new URL(calls[1].url).searchParams.get("offset")).toBe("2");
  });

  it("respects maxEvents cap", async () => {
    const { client } = clientWith(() => jsonResponse(200, [row("a"), row("b")]));
    const result = await client.fetchChangelogSince("t", { pageSize: 2, maxEvents: 3 });
    // page1 -> a,b (len 2 < maxEvents, full page so continue) page2 -> a,b -> total 4, sliced to 3
    expect(result).toHaveLength(3);
  });
});
