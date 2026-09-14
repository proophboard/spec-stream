/**
 * Token exchange: trade a prooph board API key (pb_...) for a short-lived Supabase
 * access token via `POST {endpoint}/api/realtime-token`.
 *
 * There is intentionally NO refresh token (see docs/authentication.md). Renewal is done
 * by calling this again with the API key. The API key is the single durable credential.
 */

export interface RealtimeTokenResponse {
  supabase_url: string;
  supabase_anon_key: string;
  workspace_id: string;
  access_token: string;
  /** Unix seconds. */
  expires_at: number;
  /** The API key's user id — used to filter out the user's own writes. */
  user_id?: string;
  /** The API key's user email — passed to invoked commands as context. */
  email?: string;
}

export interface RealtimeToken {
  supabaseUrl: string;
  supabaseAnonKey: string;
  workspaceId: string;
  accessToken: string;
  /** ms epoch when the token expires. */
  expiresAtMs: number;
  /** ms epoch when the token was obtained. */
  obtainedAtMs: number;
  /** The API key's user id (self identity), if the endpoint provides it. */
  userId?: string;
  /** The API key's user email, if the endpoint provides it. */
  email?: string;
}

export type TokenErrorKind =
  | "unauthorized" // 401 — bad/revoked key; fatal at startup
  | "rate_limited" // 429 — retryable with backoff
  | "server" // 5xx — retryable
  | "network" // fetch threw — retryable
  | "malformed"; // bad response body — retryable

export class TokenExchangeError extends Error {
  constructor(
    public readonly kind: TokenErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "TokenExchangeError";
  }

  /** Whether retrying (with backoff) could succeed. 401 is fatal; everything else retryable. */
  get retryable(): boolean {
    return this.kind !== "unauthorized";
  }
}

export interface ExchangeOptions {
  endpoint: string;
  apiKey: string;
  /** Injectable fetch for testing (defaults to global fetch). */
  fetchImpl?: typeof fetch;
  /** Injectable clock (ms) for deterministic tests. */
  now?: () => number;
}

/**
 * Perform the token exchange. Resolves with a {@link RealtimeToken} or throws a
 * {@link TokenExchangeError} categorized for the caller's retry logic.
 */
export async function exchangeToken(opts: ExchangeOptions): Promise<RealtimeToken> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const url = `${opts.endpoint.replace(/\/+$/, "")}/realtime-token`;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${opts.apiKey}` },
    });
  } catch (err) {
    throw new TokenExchangeError("network", `Token request failed: ${(err as Error).message}`);
  }

  if (res.status === 401) {
    throw new TokenExchangeError("unauthorized", "API key rejected (401).", 401);
  }
  if (res.status === 429) {
    throw new TokenExchangeError("rate_limited", "Token endpoint rate limited (429).", 429);
  }
  if (res.status >= 500) {
    throw new TokenExchangeError("server", `Token endpoint error (${res.status}).`, res.status);
  }
  if (!res.ok) {
    throw new TokenExchangeError(
      "malformed",
      `Unexpected token endpoint status ${res.status}.`,
      res.status,
    );
  }

  let body: Partial<RealtimeTokenResponse>;
  try {
    body = (await res.json()) as Partial<RealtimeTokenResponse>;
  } catch {
    throw new TokenExchangeError("malformed", "Token response was not valid JSON.");
  }

  const missing = (["supabase_url", "supabase_anon_key", "workspace_id", "access_token", "expires_at"] as const).filter(
    (k) => body[k] === undefined || body[k] === null,
  );
  if (missing.length > 0) {
    throw new TokenExchangeError(
      "malformed",
      `Token response missing fields: ${missing.join(", ")}.`,
    );
  }

  return {
    supabaseUrl: body.supabase_url as string,
    supabaseAnonKey: body.supabase_anon_key as string,
    workspaceId: body.workspace_id as string,
    accessToken: body.access_token as string,
    expiresAtMs: (body.expires_at as number) * 1000,
    obtainedAtMs: now(),
    userId: typeof body.user_id === "string" ? body.user_id : undefined,
    email: typeof body.email === "string" ? body.email : undefined,
  };
}
