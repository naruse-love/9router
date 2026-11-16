// OpenAI-compatible error types mapping (client-facing)
export const ERROR_TYPES = {
  400: { type: "invalid_request_error", code: "bad_request" },
  401: { type: "authentication_error", code: "invalid_api_key" },
  402: { type: "billing_error", code: "payment_required" },
  403: { type: "permission_error", code: "insufficient_quota" },
  404: { type: "invalid_request_error", code: "model_not_found" },
  406: { type: "invalid_request_error", code: "model_not_supported" },
  429: { type: "rate_limit_error", code: "rate_limit_exceeded" },
  500: { type: "server_error", code: "internal_server_error" },
  502: { type: "server_error", code: "bad_gateway" },
  503: { type: "server_error", code: "service_unavailable" },
  504: { type: "server_error", code: "gateway_timeout" }
};

// Default error messages per status code (client-facing)
export const DEFAULT_ERROR_MESSAGES = {
  400: "Bad request",
  401: "Invalid API key provided",
  402: "Payment required",
  403: "You exceeded your current quota",
  404: "Model not found",
  406: "Model not supported",
  429: "Rate limit exceeded",
  500: "Internal server error",
  502: "Bad gateway - upstream provider error",
  503: "Service temporarily unavailable",
  504: "Gateway timeout"
};

// Canonical reason phrases (RFC 9110 + the 499 client-closed convention) so the
// dashboard can label a failed request without re-deriving status text itself.
export const HTTP_STATUS_TEXT = {
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  406: "Not Acceptable",
  408: "Request Timeout",
  409: "Conflict",
  413: "Payload Too Large",
  422: "Unprocessable Content",
  429: "Too Many Requests",
  499: "Client Closed Request",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout"
};

// "503 Service Unavailable" for a known 4xx/5xx status, else the bare code.
// Returns null when the value is not an HTTP error status.
export function describeHttpStatus(status) {
  const code = Number(status);
  if (!Number.isInteger(code) || code < 400 || code > 599) return null;
  const text = HTTP_STATUS_TEXT[code];
  return text ? `${code} ${text}` : String(code);
}

// Exponential backoff config for rate limits
export const BACKOFF_CONFIG = {
  base: 2000,
  max: 5 * 60 * 1000,
  maxLevel: 15
};

// Default cooldown for transient/unknown errors
export const TRANSIENT_COOLDOWN_MS = 30 * 1000;

// Hard cap for provider-reported rate limit cooldown (e.g. codex resets_at can be 5-6h)
export const MAX_RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;

// Cooldown durations (ms)
const COOLDOWN = {
  long: 2 * 60 * 1000,
  short: 5 * 1000,
};

/**
 * Unified error classification rules.
 * Checked top-to-bottom: text rules first (by order), then status rules.
 * Each rule: { text?, status?, cooldownMs?, backoff? }
 *   - text: substring match (case-insensitive) on error message
 *   - status: HTTP status code match
 *   - cooldownMs: fixed cooldown duration
 *   - backoff: true = use exponential backoff (rate limit)
 */
export const ERROR_RULES = [
  // --- Text-based rules (checked first, order = priority) ---
  { provider: "codex", text: "model is not supported when using codex with a chatgpt account", cooldownMs: MAX_RATE_LIMIT_COOLDOWN_MS },
  // Intl gateway blocks affect the account/IP, so let the connection back off.
  { provider: "codebuddy-intl", text: "request illegal", backoff: true },
  { provider: "codebuddy-intl", text: "conversation id missing", backoff: true },
  // NVIDIA NIM returns 400 with "degraded" when specific model cluster is unhealthy.
  // Lock only the degraded model (modelScoped: true) without locking the API key.
  { provider: "nvidia", text: "degraded", cooldownMs: 15 * 60 * 1000, modelScoped: true },
  // Google AI Studio returns HTTP 400 for invalid/expired API keys; treat as account-scoped so Gemini rotates keys.
  { provider: "gemini", text: "api key not valid", cooldownMs: COOLDOWN.long },
  { provider: "gemini", text: "api_key_invalid",   cooldownMs: COOLDOWN.long },
  { provider: "gemini", text: "api key expired",   cooldownMs: COOLDOWN.long },
  { provider: "gemini", text: "api_key_expired",   cooldownMs: COOLDOWN.long },
  { text: "no credentials",           cooldownMs: COOLDOWN.long },
  { text: "request not allowed",      cooldownMs: COOLDOWN.short },
  { text: "improperly formed request", cooldownMs: COOLDOWN.long },
  { text: "rate limit",               backoff: true },
  { text: "too many requests",        backoff: true },
  { text: "quota exceeded",           backoff: true },
  { text: "insufficient credit",      backoff: true },
  { text: "credit balance is too low", backoff: true },
  { text: "capacity",                 backoff: true },
  { text: "overloaded",               backoff: true },

  // --- Status-based rules (fallback when text doesn't match) ---
  { status: 401, cooldownMs: COOLDOWN.long },
  { status: 402, cooldownMs: COOLDOWN.long },
  { status: 403, cooldownMs: COOLDOWN.long },
  { status: 404, cooldownMs: COOLDOWN.long },
  { status: 429, backoff: true },
];

// Backward compat: COOLDOWN_MS object (used by index.js re-export)
export const COOLDOWN_MS = {
  unauthorized: COOLDOWN.long,
  paymentRequired: COOLDOWN.long,
  notFound: COOLDOWN.long,
  transient: TRANSIENT_COOLDOWN_MS,
  requestNotAllowed: COOLDOWN.short,
};
