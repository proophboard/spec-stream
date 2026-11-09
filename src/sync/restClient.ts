/**
 * Minimal REST client for the prooph board HTTP API.
 *
 * Used by the local projection to **seed** the initial model before the realtime
 * changelog stream takes over with incremental updates. Authentication is the same
 * `pb_...` API key used for token exchange, sent as a Bearer token (OpenAPI `ApiKeyAuth`).
 *
 * Only the read endpoints needed for seeding are implemented:
 *   GET /chapters              -> ChapterSummary[]
 *   GET /chapters/{id}         -> Chapter (with lanes, slices, elements)
 *   GET /milestones            -> Milestone[]
 *
 * Conventions mirror auth/tokenExchange.ts: injectable `fetchImpl`, categorized errors,
 * endpoint with trailing slashes stripped.
 */

import { RateLimiter, type RateLimiterOptions } from "../util/rateLimiter.js";
import { redactString } from "../logging/redact.js";
import type { Logger } from "../logging/logger.js";

export type RestErrorKind = "unauthorized" | "rate_limited" | "server" | "network" | "malformed" | "bad_request";

export class RestError extends Error {
  constructor(
    public readonly kind: RestErrorKind,
    message: string,
    public readonly status?: number,
    /** Parsed value of the `Retry-After` response header, in milliseconds. Only set for rate_limited errors. */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "RestError";
  }

  get retryable(): boolean {
    return this.kind !== "unauthorized";
  }
}

export interface RestClientOptions {
  endpoint: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  /**
   * Rate-limiter options injected to throttle outbound requests.
   * Defaults to 600 ms between requests (safe below 120 req/min prooph board limit).
   * Pass an existing RateLimiter instance to share it across multiple RestClient users,
   * or override minIntervalMs here to change the throttle rate.
   */
  rateLimiter?: RateLimiter | RateLimiterOptions;
  /**
   * Logger for debug output (URL, method, status). API keys are always redacted.
   */
  logger?: Logger;
  /**
   * Short-lived Supabase access token issued by /api/realtime-token. When provided,
   * `fetchChangelogSince` calls the lightweight `/catchup` endpoint with this JWT
   * instead of the heavier `/changelog` tool-call path. Updated via `setAccessToken`
   * on each token renewal.
   */
  accessToken?: string;
  /**
   * Workspace ID — required when `accessToken` is set so the `/catchup` endpoint
   * can explicitly verify workspace membership (defence-in-depth alongside RLS).
   */
  workspaceId?: string;
}

/** A full chapter as returned by GET /chapters/{id}. */
export interface ApiChapter {
  id: string;
  name: string;
  index: number;
  context: string;
  mode: string;
  lanes: Record<string, unknown>[];
  slices: Record<string, unknown>[];
  /** Elements may include playFunction/playType when set on the element. */
  elements: Record<string, unknown>[];
}

export interface ApiChapterSummary {
  id: string;
  name: string;
  index: number;
  context: string;
  mode: string;
}

export interface ApiMilestone extends Record<string, unknown> {
  id: string;
}

/** A scenario as returned by GET /chapters/{id}/scenarios. */
export interface ApiScenario extends Record<string, unknown> {
  id: string;
  chapter_id: string;
  name: string;
  clock?: string | null;
  initial_state?: Record<string, unknown>;
  seeded_events?: Record<string, unknown>[];
  interactions?: Record<string, unknown>[];
  expectations?: Record<string, unknown>[];
  created_at?: string;
  updated_at?: string;
}

/** A workspace-wide HTML snippet as returned by GET /snippets. */
export interface ApiHtmlSnippet {
  workspace_id: string;
  slug: string;
  name: string;
  snippet: string;
  created_at?: string;
  updated_at?: string;
}

/**
 * A changelog event row from `GET /changelog`, matching the `changelog_events` columns
 * consumed by `normalizeRow`. `workspace_id` may be absent from the REST shape; the caller
 * fills it from the known workspace before normalizing.
 */
export interface ApiChangelogRow {
  id: string;
  workspace_id?: string;
  chapter_id: string | null;
  element_id: string | null;
  slice_id: string | null;
  user_id: string;
  event_type: string;
  event_data: Record<string, unknown> | null;
  created_at: string;
}

export class RestClient {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly limiter: RateLimiter;
  private readonly logger?: Logger;
  /** Short-lived JWT from /api/realtime-token. Used for /catchup calls. */
  private accessToken: string | undefined;
  /** Workspace ID, sent as an explicit parameter to /catchup for defence-in-depth. */
  private readonly workspaceId: string | undefined;

  constructor(opts: RestClientOptions) {
    this.base = opts.endpoint.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.limiter =
      opts.rateLimiter instanceof RateLimiter
        ? opts.rateLimiter
        : new RateLimiter(opts.rateLimiter);
    this.logger = opts.logger;
    this.accessToken = opts.accessToken;
    this.workspaceId = opts.workspaceId;
  }

  /**
   * Update the realtime access token after a renewal. Called by App when the token
   * is refreshed so subsequent `fetchChangelogSince` calls use the new JWT.
   */
  setAccessToken(token: string): void {
    this.accessToken = token;
  }

  /**
   * Log a REST API call (only in debug/verbose mode). API keys are always redacted.
   */
  private logRequest(
    method: string,
    path: string,
    status: number | undefined,
    durationMs: number,
    errorKind?: RestErrorKind,
  ): void {
    if (!this.logger || !this.logger.isEnabled("debug")) return;

    const redactedKey = redactString(this.apiKey);
    const apiKeyPreview = redactedKey.startsWith("pb_***") ? "pb_***" : redactedKey;

    if (errorKind) {
      this.logger.debug("rest.request_failed", {
        method,
        path,
        status,
        error: errorKind,
        durationMs,
        apiKeyUsed: apiKeyPreview,
      });
    } else {
      this.logger.debug("rest.request", {
        method,
        path,
        status,
        durationMs,
        apiKeyUsed: apiKeyPreview,
      });
    }
  }

  async listChapters(): Promise<ApiChapterSummary[]> {
    return this.getJson<ApiChapterSummary[]>("/chapters");
  }

  async getChapter(chapterId: string): Promise<ApiChapter> {
    return this.getJson<ApiChapter>(`/chapters/${encodeURIComponent(chapterId)}`);
  }

  async listMilestones(): Promise<ApiMilestone[]> {
    return this.getJson<ApiMilestone[]>("/milestones");
  }

  async listScenarios(chapterId: string): Promise<ApiScenario[]> {
    return this.getJson<ApiScenario[]>(`/chapters/${encodeURIComponent(chapterId)}/scenarios`);
  }

  async listSnippets(): Promise<ApiHtmlSnippet[]> {
    return this.getJson<ApiHtmlSnippet[]>("/snippets");
  }

  /**
   * Resolve a task comment on an element.
   *
   * POST /chapters/{chapterId}/elements/{elementId}/comments/{commentId}/resolve
   *
   * The comment must have been created as a task (`is_task=true`); the API rejects
   * resolving a non-task comment. Used by sync-back when a local task comment is
   * removed — resolving is the only API action that removes a comment from an
   * element's collection (there is no plain comment-delete endpoint).
   */
  async resolveElementTask(chapterId: string, elementId: string, commentId: string): Promise<void> {
    const enc = encodeURIComponent;
    await this.postJson(
      `/chapters/${enc(chapterId)}/elements/${enc(elementId)}/comments/${enc(commentId)}/resolve`,
      {},
    );
  }

  /**
   * Resolve a task comment on a slice.
   *
   * POST /chapters/{chapterId}/slices/{sliceId}/comments/{commentId}/resolve
   *
   * The comment must have been created as a task (`is_task=true`); the API rejects
   * resolving a non-task comment. See {@link resolveElementTask}.
   */
  async resolveSliceTask(chapterId: string, sliceId: string, commentId: string): Promise<void> {
    const enc = encodeURIComponent;
    await this.postJson(
      `/chapters/${enc(chapterId)}/slices/${enc(sliceId)}/comments/${enc(commentId)}/resolve`,
      {},
    );
  }

  /**
   * Fetch changelog event rows created on/after `since` (ISO 8601), oldest-first, paging
   * through results up to `maxEvents`. Used to replay the gap after a realtime disconnect.
   * Returns raw rows in the `ChangelogEventRow` shape (the API's `ChangelogEvent`), which
   * the caller normalizes via `normalizeRow`.
   *
   * When an `accessToken` is available (set at construction or via `setAccessToken`) this
   * calls the lightweight `GET /catchup` endpoint with the realtime JWT — no api_keys
   * lookup, no machine-user sign-in, just one Supabase query per page. Falls back to
   * `GET /changelog` with the pb_ key when no access token is set.
   */
  async fetchChangelogSince(
    since: string,
    opts: { pageSize?: number; maxEvents?: number } = {},
  ): Promise<ApiChangelogRow[]> {
    const pageSize = Math.min(Math.max(opts.pageSize ?? 100, 1), 100);
    const maxEvents = opts.maxEvents ?? 5000;
    const out: ApiChangelogRow[] = [];
    let offset = 0;
    // Use /catchup (JWT auth, 0 extra Supabase round-trips) when the access token is
    // available; fall back to /changelog (pb_ key auth) otherwise.
    const useCatchup = !!(this.accessToken && this.workspaceId);
    const path = useCatchup ? "/catchup" : "/changelog";
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const q = new URLSearchParams({
        since,
        limit: String(pageSize),
        offset: String(offset),
      });
      if (useCatchup) {
        // /catchup requires an explicit workspace_id for defence-in-depth server-side.
        q.set("workspace_id", this.workspaceId!);
      }
      const page = await this.getJson<ApiChangelogRow[]>(`${path}?${q.toString()}`, this.accessToken);
      out.push(...page);
      if (page.length < pageSize || out.length >= maxEvents) break;
      offset += pageSize;
    }
    return out.slice(0, maxEvents);
  }

  // ─── Write methods ──────────────────────────────────────────────────────────

  /**
   * POST to `path` with a JSON body. Returns the parsed response body (typed as T).
   * Used by the sync-back command to create/update entities on the board.
   */
  async postJson<T = unknown>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.writeJson<T>("POST", path, body);
  }

  /**
   * PATCH to `path` with a JSON body. Returns the parsed response body (typed as T).
   */
  async patchJson<T = unknown>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.writeJson<T>("PATCH", path, body);
  }

  /**
   * DELETE to `path`. No body is sent (prooph board DELETE endpoints use path params only).
   * Returns void; a non-2xx response throws RestError.
   */
  async deleteReq(path: string): Promise<void> {
    const url = `${this.base}${path}`;
    const startTime = Date.now();
    await this.limiter.throttle();
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "DELETE",
        headers: { authorization: `Bearer ${this.apiKey}`, accept: "application/json" },
      });
    } catch (err) {
      const duration = Date.now() - startTime;
      this.logRequest("DELETE", path, undefined, duration, "network");
      throw new RestError("network", `DELETE ${path} failed: ${(err as Error).message}`);
    }
    const duration = Date.now() - startTime;
    this.logRequest("DELETE", path, res.status, duration);

    // Some endpoints return 204 No Content.
    if (res.status === 204 || res.headers.get("content-length") === "0") {
      return;
    }
    this.checkStatus("DELETE", path, res);
  }

  private async writeJson<T>(
    method: "POST" | "PATCH",
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const url = `${this.base}${path}`;
    const startTime = Date.now();
    await this.limiter.throttle();
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const duration = Date.now() - startTime;
      this.logRequest(method, path, undefined, duration, "network");
      throw new RestError("network", `${method} ${path} failed: ${(err as Error).message}`);
    }
    const duration = Date.now() - startTime;
    this.logRequest(method, path, res.status, duration);

    // Some endpoints return 204 No Content (e.g. DELETE-equivalent actions).
    if (res.status === 204 || res.headers.get("content-length") === "0") {
      return undefined as unknown as T;
    }
    // Throw on any 4xx/5xx before attempting to parse the body. Without this check,
    // a 400 ValidationError (e.g. adding an automation to an event-reaction slice via
    // the wrong endpoint) is silently returned as a "successful" response because the
    // body is valid JSON with an `error` field — the caller never sees an exception.
    //
    // For 4xx errors, read the response body first so we can include the API's detailed
    // validation message in the thrown error. This is essential for agents running
    // sync-back: they need the precise error hint (e.g. "use the add_event_reaction tool
    // instead") to understand and fix the problem.
    if (!res.ok) {
      let apiMessage: string | undefined;
      try {
        const errBody = await res.json() as { error?: string };
        if (errBody?.error) apiMessage = errBody.error;
      } catch {
        // Body was not JSON — fall through to checkStatus for a generic message.
      }
      this.checkStatus(method, path, res, apiMessage);
    }
    try {
      return (await res.json()) as T;
    } catch {
      throw new RestError("malformed", `${method} ${path}: response was not valid JSON.`);
    }
  }

  private checkStatus(method: string, path: string, res: Response, apiMessage?: string): void {
    const detail = apiMessage ? ` — ${apiMessage}` : "";
    if (res.status === 400) throw new RestError("bad_request", `${method} ${path}: unexpected status ${res.status}${detail}.`, res.status);
    if (res.status === 401) throw new RestError("unauthorized", `${method} ${path}: API key rejected (401).`, 401);
    if (res.status === 429) {
      const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
      throw new RestError("rate_limited", `${method} ${path}: rate limited (429).`, 429, retryAfterMs);
    }
    if (res.status >= 500) throw new RestError("server", `${method} ${path}: server error (${res.status}).`, res.status);
    if (!res.ok) {
      throw new RestError("malformed", `${method} ${path}: unexpected status ${res.status}${detail}.`, res.status);
    }
  }

  private async getJson<T>(path: string, bearerToken?: string): Promise<T> {
    const url = `${this.base}${path}`;
    const startTime = Date.now();
    await this.limiter.throttle();
    let res: Response;
    const token = bearerToken ?? this.apiKey;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      });
    } catch (err) {
      const duration = Date.now() - startTime;
      this.logRequest("GET", path, undefined, duration, "network");
      throw new RestError("network", `GET ${path} failed: ${(err as Error).message}`);
    }
    const duration = Date.now() - startTime;
    this.logRequest("GET", path, res.status, duration);

    if (res.status === 401) throw new RestError("unauthorized", `GET ${path}: API key rejected (401).`, 401);
    if (res.status === 429) {
      const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
      throw new RestError("rate_limited", `GET ${path}: rate limited (429).`, 429, retryAfterMs);
    }
    if (res.status >= 500) throw new RestError("server", `GET ${path}: server error (${res.status}).`, res.status);
    if (!res.ok) throw new RestError("malformed", `GET ${path}: unexpected status ${res.status}.`, res.status);

    try {
      return (await res.json()) as T;
    } catch {
      throw new RestError("malformed", `GET ${path}: response was not valid JSON.`);
    }
  }
}

/**
 * Parse the `Retry-After` header value into milliseconds.
 * Handles both numeric (seconds) and HTTP-date forms.
 * Returns undefined if the header is absent or unparseable.
 */
export function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  // Numeric seconds form: "Retry-After: 60"
  const secs = Number(trimmed);
  if (!Number.isNaN(secs) && secs >= 0) return Math.ceil(secs) * 1000;
  // HTTP-date form: "Retry-After: Wed, 21 Oct 2015 07:28:00 GMT"
  const date = new Date(trimmed);
  const ms = date.getTime() - Date.now();
  if (!Number.isNaN(ms) && ms >= 0) return ms;
  return undefined;
}
