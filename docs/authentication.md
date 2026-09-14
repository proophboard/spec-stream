# Authentication

`spec-stream` authenticates using a prooph board **API key** — the same key that grants
access to the prooph board API. This document describes the flow and token lifecycle
from spec-stream's side.

## The API key

- Format: `pb_` followed by an opaque token, e.g. `pb_1a2b3c4d…`.
- Created by a workspace admin in prooph board; each key is scoped to one workspace, and
  its access (read-only or write) is chosen at creation time. **A read-only key is
  recommended for spec-stream.**
- Treated as a **secret**. `spec-stream` reads it only from the environment:
  - `PROOPHBOARD_API_KEY` in `process.env`, or
  - a `.env` file in the working directory (loaded via Node's `--env-file` on
    Node ≥ 20.6, or an optional `dotenv` dependency on older Node).
- It is **never** stored in `proophboard.spec-stream.json` and is **never** logged
  (any `pb_…` value is redacted in output).

## Startup flow

```
1. Read PROOPHBOARD_API_KEY from env/.env
        │
2. POST {endpoint}/realtime-token  (Authorization: Bearer pb_…)
        │  ← { supabase_url, supabase_anon_key, workspace_id, user_id, email,
        │      access_token, expires_at }        // SHORT-LIVED token, no refresh token
        ▼
3. createClient(supabase_url, supabase_anon_key, { auth: { autoRefreshToken: false, persistSession: false } })
        │
4. supabase.realtime.setAuth(access_token)       // authorize the realtime socket
        │
5. subscribe to the workspace's changelog channel
```

`{endpoint}` is the prooph board **API base URL** from the config (e.g.
`https://flow.prooph-board.com/api`). After step 5, changelog messages for the workspace
are delivered over realtime.

Because there is **no refresh token**, `spec-stream` disables supabase-js token
auto-refresh and manages renewal itself by re-calling the endpoint (see below). This
keeps the `pb_…` key as the single source of authority.

## Self identity (own-write filtering)

The response also carries the key's **`user_id`** and **`email`**. `spec-stream` uses
`user_id` to recognize its **own writes** to the board (changelog events made by the same
user) and, by default, does not act on them — preventing agents from re-triggering
themselves. A rule can opt in with `consumeOwnEvents: true`
(see [`config-schema.md`](./config-schema.md)). Both values are passed to invoked commands
as `SPEC_STREAM_SELF_USER_ID` / `SPEC_STREAM_SELF_EMAIL`.

If an older prooph board deployment does not return `user_id`, own-write filtering is
disabled and a `auth.no_self_identity` warning is logged; everything else still works.

## Token lifecycle & renewal

The access token is **short-lived** and there is **no refresh token** — by design, so the
API key remains the only durable credential and revocation is authoritative.

`spec-stream` keeps the connection alive by **re-presenting the API key**:

- **Proactive renewal:** a timer re-calls the token endpoint at ~75% of the token's
  lifetime (from `expires_at`), then `realtime.setAuth(newAccessToken)` so the socket
  keeps authorizing with the fresh token. The renewal is seamless — no reconnect needed.
- **On auth error** (e.g. token expired / `401` on the socket): immediately re-run the
  exchange from step 2 and re-`setAuth`.
- **On endpoint failure** (network, `429`, `5xx`): retry the exchange under the standard
  capped-exponential backoff ([`reconnection.md`](./reconnection.md)). The stream keeps
  trying and never gives up on transient errors.
- **On key revocation:** the token endpoint returns `401` and the stream stops receiving
  events within one token lifetime. `spec-stream` keeps retrying and logs a clear,
  actionable error, surfaced in `status`. A running process does not crash on this — it
  enters the retry/backoff loop and reports the problem. (Startup with an already-revoked
  key fails fast; see `AGENT.md` §9.)

## In-memory only

- The `access_token` lives in process memory only. It is **not** written to disk, logs,
  or the PID/state files. There is no refresh token to store.
- The API key stays in `process.env` for the lifetime of the process and is used only for
  the token exchange and its renewals.

## Redaction

All logging passes through a redactor that masks:

- Anything matching `pb_…` → `pb_***`.
- JWT-shaped tokens → masked.

Never add a log line that prints the raw key or a token. If you must log auth state, log
booleans/expiry timestamps, not secrets.
