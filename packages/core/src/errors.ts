/**
 * Runtime error classification. Port of aif-handoff `runtime/src/errors.ts`
 * (bf6a8b6, MIT). Addition (Р-024): `no_subscription`.
 */
export const RUNTIME_ERROR_CATEGORIES = [
  "rate_limit",
  "no_subscription",
  "auth",
  "timeout",
  "permission",
  "stream",
  "transport",
  "model_not_found",
  "context_length",
  "content_filter",
  "unknown",
] as const;
export type RuntimeErrorCategory = (typeof RUNTIME_ERROR_CATEGORIES)[number];

const HTTP_STATUS_CATEGORY_MAP: ReadonlyMap<number, RuntimeErrorCategory> = new Map<number, RuntimeErrorCategory>([
  [401, "auth"],
  [402, "no_subscription"],
  [403, "auth"],
  [429, "rate_limit"],
  [408, "timeout"],
  [504, "timeout"],
  [413, "context_length"],
  [451, "content_filter"],
]);

export function classifyByHttpStatus(status: number): RuntimeErrorCategory | null {
  const exact = HTTP_STATUS_CATEGORY_MAP.get(status);
  if (exact) return exact;
  if (status >= 500 && status < 600) return "transport";
  return null;
}

const SHARED_FALLBACK_PATTERNS: readonly { category: RuntimeErrorCategory; patterns: readonly string[] }[] = [
  {
    category: "no_subscription",
    patterns: [
      "payment required",
      "subscription has expired",
      "subscription expired",
      "no active subscription",
      "subscription required",
      "billing",
      "plan has expired",
    ],
  },
  {
    category: "rate_limit",
    patterns: [
      "usage limit",
      "out of extra usage",
      "rate limit",
      "rate_limit",
      "too many requests",
      "insufficient_quota",
      "quota",
      "at capacity",
      "model is at capacity",
      "hit your limit",
      "limit reached",
      "limit exceeded",
      "out of credits",
      "credits",
    ],
  },
  {
    category: "auth",
    patterns: [
      "authentication_error",
      "invalid authentication credentials",
      "failed to authenticate",
      "unauthorized",
      "invalid api key",
      "invalid_api_key",
      "invalid credentials",
      "invalid password",
      "forbidden",
      "not logged in",
    ],
  },
  {
    category: "timeout",
    patterns: ["timed out", "timeout", "etimedout", "aborted", "query_start_timeout", "first_activity_timeout"],
  },
  { category: "permission", patterns: ["permission denied", "write permission", "blocked by permissions"] },
  { category: "stream", patterns: ["stream_error", "stream closed", "stream interrupted"] },
  { category: "transport", patterns: ["connection refused", "econnrefused", "econnreset", "network", "fetch failed"] },
  {
    category: "model_not_found",
    patterns: [
      "model not found",
      "no endpoints found",
      "model_not_available",
      "no available model",
      "providermodelnotfounderror",
      "modelnotfounderror",
      "provider not found",
      "no models match",
    ],
  },
  { category: "context_length", patterns: ["context_length_exceeded", "maximum context length"] },
  { category: "content_filter", patterns: ["content_filter", "content_policy"] },
];

export function classifyByMessageFallback(message: string): RuntimeErrorCategory {
  const lowered = message.toLowerCase();
  for (const entry of SHARED_FALLBACK_PATTERNS) {
    if (entry.patterns.some((p) => lowered.includes(p))) return entry.category;
  }
  return "unknown";
}

const EXTERNAL_FAILURE_CATEGORIES: ReadonlySet<RuntimeErrorCategory> = new Set<RuntimeErrorCategory>([
  "rate_limit",
  "no_subscription",
  "auth",
  "timeout",
  "permission",
  "stream",
  "transport",
]);

export function isExternalFailureCategory(category: RuntimeErrorCategory): boolean {
  return EXTERNAL_FAILURE_CATEGORIES.has(category);
}

/** Р-024/Р-025: these only switch the model, they never change the task process. */
export function isModelLimitCategory(category: RuntimeErrorCategory): boolean {
  return category === "rate_limit" || category === "no_subscription";
}

export const NON_RETRYABLE_RUNTIME_CATEGORIES: ReadonlySet<RuntimeErrorCategory> = new Set<RuntimeErrorCategory>([
  "model_not_found",
  "context_length",
  "content_filter",
]);

/** Try to read a reset moment from provider text ("resets at …", "try again in 3h 20m"). */
export function extractResetAt(message: string, now: Date): string | null {
  const iso = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))/.exec(message);
  if (iso?.[1]) {
    const ms = Date.parse(iso[1]);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  const rel = /(?:try again in|retry in|resets? in|retry after)\s+(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?\s*(?:(\d+)\s*s(?:ec(?:onds?)?)?)?/i.exec(
    message,
  );
  if (rel && (rel[1] ?? rel[2] ?? rel[3])) {
    const seconds = Number(rel[1] ?? 0) * 3600 + Number(rel[2] ?? 0) * 60 + Number(rel[3] ?? 0);
    return new Date(now.getTime() + seconds * 1000).toISOString();
  }
  return null;
}
