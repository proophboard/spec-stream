/**
 * Redaction of secrets from log output. Always applied before writing to any sink.
 * Masks prooph board API keys (pb_...) and JWT-shaped tokens (eyJ...).
 */

// pb_ followed by key chars (hex/alphanumeric). Mask everything after the prefix.
const PB_KEY = /\bpb_[A-Za-z0-9]+/g;
// JWT: three base64url segments separated by dots, starting with the typical eyJ header.
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

/** Redact secrets from a string. */
export function redactString(input: string): string {
  return input.replace(PB_KEY, "pb_***").replace(JWT, "***.jwt.***");
}

/**
 * Recursively redact secrets from any JSON-serializable value. Also masks common secret
 * field names regardless of value shape.
 */
export function redactValue<T>(value: T): T {
  if (typeof value === "string") {
    return redactString(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSecretKey(k)) {
        out[k] = "***";
      } else {
        out[k] = redactValue(v);
      }
    }
    return out as unknown as T;
  }
  return value;
}

const SECRET_KEYS = new Set([
  "access_token",
  "refresh_token",
  "accesstoken",
  "apikey",
  "api_key",
  "authorization",
  "password",
  "machine_user_password",
]);

function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key.toLowerCase());
}
