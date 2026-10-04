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

export type RestErrorKind = "unauthorized" | "rate_limited" | "server" | "network" | "malformed";

export class RestError extends Error {
  constructor(
    public readonly kind: RestErrorKind,
    message: string,
    public readonly status?: number,
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

  constructor(opts: RestClientOptions) {
    this.base = opts.endpoint.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
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

  /**
   * Fetch changelog event rows created on/after `since` (ISO 8601), oldest-first, paging
   * through results up to `maxEvents`. Used to replay the gap after a realtime disconnect.
   * Returns raw rows in the `ChangelogEventRow` shape (the API's `ChangelogEvent`), which
   * the caller normalizes via `normalizeRow`.
   */
  async fetchChangelogSince(
    since: string,
    opts: { pageSize?: number; maxEvents?: number } = {},
  ): Promise<ApiChangelogRow[]> {
    const pageSize = Math.min(Math.max(opts.pageSize ?? 100, 1), 100);
    const maxEvents = opts.maxEvents ?? 5000;
    const out: ApiChangelogRow[] = [];
    let offset = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const q = new URLSearchParams({
        since,
        limit: String(pageSize),
        offset: String(offset),
      });
      const page = await this.getJson<ApiChangelogRow[]>(`/changelog?${q.toString()}`);
      out.push(...page);
      if (page.length < pageSize || out.length >= maxEvents) break;
      offset += pageSize;
    }
    return out.slice(0, maxEvents);
  }

  private async getJson<T>(path: string): Promise<T> {
    const url = `${this.base}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        headers: { authorization: `Bearer ${this.apiKey}`, accept: "application/json" },
      });
    } catch (err) {
      throw new RestError("network", `GET ${path} failed: ${(err as Error).message}`);
    }

    if (res.status === 401) throw new RestError("unauthorized", `GET ${path}: API key rejected (401).`, 401);
    if (res.status === 429) throw new RestError("rate_limited", `GET ${path}: rate limited (429).`, 429);
    if (res.status >= 500) throw new RestError("server", `GET ${path}: server error (${res.status}).`, res.status);
    if (!res.ok) throw new RestError("malformed", `GET ${path}: unexpected status ${res.status}.`, res.status);

    try {
      return (await res.json()) as T;
    } catch {
      throw new RestError("malformed", `GET ${path}: response was not valid JSON.`);
    }
  }
}
