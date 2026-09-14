import { describe, it, expect } from "vitest";
import { exchangeToken, TokenExchangeError } from "./tokenExchange.js";

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

const good = {
  supabase_url: "https://x.supabase.co",
  supabase_anon_key: "anon",
  workspace_id: "ws-1",
  access_token: "eyJ.a.b",
  expires_at: 2000, // unix seconds
};

describe("exchangeToken", () => {
  it("POSTs to /api/realtime-token with the API key and parses the response", async () => {
    let calledUrl = "";
    let calledInit: RequestInit | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calledUrl = url;
      calledInit = init;
      return jsonResponse(200, good);
    }) as unknown as typeof fetch;

    const token = await exchangeToken({
      endpoint: "https://flow.prooph-board.com/api",
      apiKey: "pb_abc",
      fetchImpl,
      now: () => 1_000_000,
    });

    expect(calledUrl).toBe("https://flow.prooph-board.com/api/realtime-token");
    expect((calledInit?.headers as Record<string, string>).authorization).toBe("Bearer pb_abc");
    expect(calledInit?.method).toBe("POST");
    expect(token.supabaseUrl).toBe("https://x.supabase.co");
    expect(token.workspaceId).toBe("ws-1");
    expect(token.accessToken).toBe("eyJ.a.b");
    expect(token.expiresAtMs).toBe(2000 * 1000);
    expect(token.obtainedAtMs).toBe(1_000_000);
  });

  it("normalizes a trailing slash on the endpoint", async () => {
    let calledUrl = "";
    const fetchImpl = (async (url: string) => {
      calledUrl = url;
      return jsonResponse(200, good);
    }) as unknown as typeof fetch;
    await exchangeToken({ endpoint: "https://x.com/api/", apiKey: "pb_a", fetchImpl });
    expect(calledUrl).toBe("https://x.com/api/realtime-token");
  });

  it("throws unauthorized (non-retryable) on 401", async () => {
    const fetchImpl = (async () => jsonResponse(401, { error: "Unauthorized" })) as unknown as typeof fetch;
    await expect(
      exchangeToken({ endpoint: "https://x.com", apiKey: "pb_a", fetchImpl }),
    ).rejects.toMatchObject({ kind: "unauthorized" });

    try {
      await exchangeToken({ endpoint: "https://x.com", apiKey: "pb_a", fetchImpl });
    } catch (err) {
      expect(err).toBeInstanceOf(TokenExchangeError);
      expect((err as TokenExchangeError).retryable).toBe(false);
    }
  });

  it("throws rate_limited (retryable) on 429", async () => {
    const fetchImpl = (async () => jsonResponse(429, {})) as unknown as typeof fetch;
    const err = await exchangeToken({ endpoint: "https://x.com", apiKey: "pb_a", fetchImpl }).catch(
      (e) => e,
    );
    expect(err.kind).toBe("rate_limited");
    expect(err.retryable).toBe(true);
  });

  it("throws server (retryable) on 5xx", async () => {
    const fetchImpl = (async () => jsonResponse(503, {})) as unknown as typeof fetch;
    const err = await exchangeToken({ endpoint: "https://x.com", apiKey: "pb_a", fetchImpl }).catch(
      (e) => e,
    );
    expect(err.kind).toBe("server");
  });

  it("throws network (retryable) when fetch rejects", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const err = await exchangeToken({ endpoint: "https://x.com", apiKey: "pb_a", fetchImpl }).catch(
      (e) => e,
    );
    expect(err.kind).toBe("network");
  });

  it("throws malformed when required fields are missing", async () => {
    const fetchImpl = (async () =>
      jsonResponse(200, { supabase_url: "u" })) as unknown as typeof fetch;
    const err = await exchangeToken({ endpoint: "https://x.com", apiKey: "pb_a", fetchImpl }).catch(
      (e) => e,
    );
    expect(err.kind).toBe("malformed");
    expect(err.message).toMatch(/missing fields/);
  });

  it("throws malformed when body is not JSON", async () => {
    const fetchImpl = (async () =>
      ({
        status: 200,
        ok: true,
        json: async () => {
          throw new Error("bad json");
        },
      }) as unknown as Response) as unknown as typeof fetch;
    const err = await exchangeToken({ endpoint: "https://x.com", apiKey: "pb_a", fetchImpl }).catch(
      (e) => e,
    );
    expect(err.kind).toBe("malformed");
  });
});
