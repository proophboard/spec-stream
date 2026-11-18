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
  /** Bare 401s in a row (no throttle signal) before the key is declared dead. */
  private static readonly MAX_CONSECUTIVE_AUTH_REJECTIONS = 5;
  /** Retry-After fallback surfaced to callers for a transient bare-401 blip. */
  private static readonly TRANSIENT_401_RETRY_MS = 5_000;

  private readonly base: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly limiter: RateLimiter;
  private readonly logger?: Logger;
  /**
   * Consecutive 401 responses that carried no throttle signal. The platform's
   * edge intermittently emits bare 401s under load whose payload is identical
   * to a revoked-key rejection — a single response proves nothing either way.
   * The only reliable distinguishing signal is behaviour: a dead key is
   * rejected on every request, while a transient blip is followed by
   * successes. Reset by any response whose status is not 401.
   */
  private consecutiveAuthRejections = 0;
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
    queueWaitMs?: number,
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
        queueWaitMs,
        apiKeyUsed: apiKeyPreview,
      });
    } else {
      this.logger.debug("rest.request", {
        method,
        path,
        status,
        durationMs,
        queueWaitMs,
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
    const queuedAt = Date.now();
    await this.limiter.throttle();
    const startTime = Date.now();
    const queueWaitMs = startTime - queuedAt;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "DELETE",
        headers: { authorization: `Bearer ${this.apiKey}`, accept: "application/json" },
      });
    } catch (err) {
      const duration = Date.now() - startTime;
      this.logRequest("DELETE", path, undefined, duration, "network", queueWaitMs);
      throw new RestError("network", `DELETE ${path} failed: ${(err as Error).message}`);
    }
    const duration = Date.now() - startTime;
    this.logRequest("DELETE", path, res.status, duration, undefined, queueWaitMs);
    this.noteAuthOutcome(res.status);
    if (res.ok) this.limiter.recover();

    // Some endpoints return 204 No Content.
    if (res.status === 204 || res.headers.get("content-length") === "0") {
      return;
    }
    if (!res.ok) {
      this.checkStatus("DELETE", path, res, await readApiErrorMessage(res));
    }
  }

  private async writeJson<T>(
    method: "POST" | "PATCH",
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const url = `${this.base}${path}`;
    const queuedAt = Date.now();
    await this.limiter.throttle();
    const startTime = Date.now();
    const queueWaitMs = startTime - queuedAt;
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
      this.logRequest(method, path, undefined, duration, "network", queueWaitMs);
      throw new RestError("network", `${method} ${path} failed: ${(err as Error).message}`);
    }
    const duration = Date.now() - startTime;
    this.logRequest(method, path, res.status, duration, undefined, queueWaitMs);
    this.noteAuthOutcome(res.status);
    if (res.ok) this.limiter.recover();

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
      this.checkStatus(method, path, res, await readApiErrorMessage(res));
    }
    try {
      return (await res.json()) as T;
    } catch {
      throw new RestError("malformed", `${method} ${path}: response was not valid JSON.`);
    }
  }

  /**
   * Reset the bare-401 streak on any response that proves the key was
   * processed — i.e. any status other than 401 (including other errors).
   */
  private noteAuthOutcome(status: number): void {
    if (status !== 401) this.consecutiveAuthRejections = 0;
  }

  /**
   * Double the shared limiter's pacing interval after a throttle rejection.
   * The platform's effective budget is opaque and smaller than the documented
   * 120 req/min — production traces showed ~35–40 req/min sustained before
   * 401s started — so each rejection halves the rate rather than merely
   * pausing and resuming at the same speed into the same wall.
   */
  private slowDownForThrottle(): void {
    const intervalMs = this.limiter.slowDown();
    if (this.logger?.isEnabled("debug")) {
      this.logger.debug("rest.throttle_slowdown", { intervalMs });
    }
  }

  private checkStatus(method: string, path: string, res: Response, apiMessage?: string): void {
    const detail = apiMessage ? ` — ${apiMessage}` : "";
    if (res.status === 400) throw new RestError("bad_request", `${method} ${path}: unexpected status ${res.status}${detail}.`, res.status);
    if (res.status === 401) {
      // prooph board's edge answers 401 (not 429) when the request quota is
      // exhausted. A Retry-After header or a rate-limit-flavoured error body means
      // "slow down and retry"; anything else is a genuinely dead API key.
      const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
      if (retryAfterMs !== undefined || looksLikeRateLimit(apiMessage)) {
        this.slowDownForThrottle();
        throw new RestError("rate_limited", `${method} ${path}: rate limited (401)${detail}.`, 401, retryAfterMs);
      }
      // A bare 401 carries no throttle signal — but production traces showed the
      // edge emits exactly this response spuriously under load, indistinguishable
      // in payload from a revoked-key rejection. A single 401 therefore proves
      // nothing: treat it as transient throttling and only escalate to fatal
      // `unauthorized` after a sustained streak of rejections without any
      // non-401 response in between — the only reliable sign of a dead key.
      this.consecutiveAuthRejections++;
      if (this.consecutiveAuthRejections >= RestClient.MAX_CONSECUTIVE_AUTH_REJECTIONS) {
        throw new RestError(
          "unauthorized",
          `${method} ${path}: API key rejected — ${RestClient.MAX_CONSECUTIVE_AUTH_REJECTIONS} consecutive 401s without a single success.`,
          401,
        );
      }
      this.slowDownForThrottle();
      throw new RestError(
        "rate_limited",
        `${method} ${path}: rejected (401) with no throttle signal — treating as transient (rejection ${this.consecutiveAuthRejections}/${RestClient.MAX_CONSECUTIVE_AUTH_REJECTIONS}).`,
        401,
        RestClient.TRANSIENT_401_RETRY_MS,
      );
    }
    if (res.status === 429) {
      const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
      this.slowDownForThrottle();
      throw new RestError("rate_limited", `${method} ${path}: rate limited (429).`, 429, retryAfterMs);
    }
    if (res.status >= 500) throw new RestError("server", `${method} ${path}: server error (${res.status}).`, res.status);
    if (!res.ok) {
      throw new RestError("malformed", `${method} ${path}: unexpected status ${res.status}${detail}.`, res.status);
    }
  }

  private async getJson<T>(path: string, bearerToken?: string): Promise<T> {
    const url = `${this.base}${path}`;
    const queuedAt = Date.now();
    await this.limiter.throttle();
    const startTime = Date.now();
    const queueWaitMs = startTime - queuedAt;
    let res: Response;
    const token = bearerToken ?? this.apiKey;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      });
    } catch (err) {
      const duration = Date.now() - startTime;
      this.logRequest("GET", path, undefined, duration, "network", queueWaitMs);
      throw new RestError("network", `GET ${path} failed: ${(err as Error).message}`);
    }
    const duration = Date.now() - startTime;
    this.logRequest("GET", path, res.status, duration, undefined, queueWaitMs);
    this.noteAuthOutcome(res.status);
    if (res.ok) this.limiter.recover();

    // Throw on any 4xx/5xx before attempting to parse the body — same taxonomy as
    // writeJson, including reading the error body so a quota-flavoured 401 can be
    // told apart from a revoked API key.
    if (!res.ok) {
      this.checkStatus("GET", path, res, await readApiErrorMessage(res));
    }

    try {
      return (await res.json()) as T;
    } catch {
      throw new RestError("malformed", `GET ${path}: response was not valid JSON.`);
    }
  }
}

/** Read `{ error: "..." }` from an error response body; undefined when absent/unparseable. */
async function readApiErrorMessage(res: Response): Promise<string | undefined> {
  try {
    const errBody = (await res.json()) as { error?: string };
    return errBody?.error;
  } catch {
    return undefined; // Body was not JSON — caller falls back to a generic message.
  }
}

/** Does an API error message indicate a rate/quota rejection rather than a dead key? */
function looksLikeRateLimit(apiMessage: string | undefined): boolean {
  return !!apiMessage && /rate.?limit|quota|too many requests/i.test(apiMessage);
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
