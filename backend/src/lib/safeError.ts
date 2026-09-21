const SECRET_CONTEXT_PATTERNS = [
  /(Incorrect API key provided:\s*)([^.\s]+)(\.?)/gi,
  /(api[_ -]?key|x-api-key|token|secret|authorization|bearer)\s*["']?\s*(?:provided\s*)?(?:is|:|=)\s*["']?([^"'\s,;.}&?#]{6,})["']?/gi,
];

const PROVIDER_KEY_PATTERNS = [
  /\bsk-[A-Za-z0-9_\-]{12,}\b/g,
  /\bAIza[A-Za-z0-9_\-]{20,}\b/g,
  /\bA(?:KI|SI)A[A-Z0-9]{16}\b/g,
  /\b(?:gh[opusr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,})\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi,
  /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi,
];
const CONTEXTUAL_SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/([?&](?:(?:access|refresh|id)_token|api[_-]?key|client_secret|password|passwd|secret|signature|sig|token|x-amz-[a-z-]+|x-goog-[a-z-]+)=)[^&#\s]+/gi, "$1[redacted]"],
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@"],
];

export function redactSensitiveText(value: string): string {
  let redacted = value;
  for (const pattern of SECRET_CONTEXT_PATTERNS) {
    redacted = redacted.replace(pattern, (match, ...groups: string[]) => {
      if (match.toLowerCase().startsWith("incorrect api key provided:")) {
        return `${groups[0]}[redacted]${groups[2] ?? ""}`;
      }
      const secret = groups[1];
      return secret ? match.replace(secret, "[redacted]") : match;
    });
  }
  for (const pattern of PROVIDER_KEY_PATTERNS) {
    redacted = redacted.replace(pattern, "[redacted]");
  }
  for (const [pattern, replacement] of CONTEXTUAL_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

export function safeErrorMessage(
  error: unknown,
  fallback = "Unexpected error",
): string {
  const message =
    error instanceof Error && error.message
      ? error.message
      : typeof error === "string"
        ? error
        : fallback;
  return redactSensitiveText(message.slice(0, 8_192));
}

export const safePublicErrorMessage = (error: unknown, fallback: string) =>
  process.env.NODE_ENV === "production" ? fallback : safeErrorMessage(error, fallback);

export function safeErrorLog(error: unknown): {
  name: string | null;
  message: string;
  stack?: string;
} {
  const message = safeErrorMessage(error).replace(/[\r\n\t]+/gu, " ");
  if (error instanceof Error) {
    return {
      name: error.name || null,
      message,
      stack: process.env.NODE_ENV !== "production" && error.stack
        ? redactSensitiveText(error.stack.slice(0, 8_192)) : undefined,
    };
  }
  return {
    name: null,
    message,
  };
}

/** Public classifications never expose provider response bodies, prompts or credentials. */
export function providerErrorCode(error: unknown) {
  for (let depth = 0; error instanceof Error && depth < 5; depth++) {
    const value = error as Error & { statusCode?: number; status?: number; lastError?: unknown };
    const status = value.statusCode ?? value.status;
    if (status === 401 || status === 403) return "provider_auth" as const;
    if (status === 429) return "provider_limit" as const;
    if (status === 400 || status === 404) return "provider_request" as const;
    if (status && status >= 500) return "provider_unavailable" as const;
    if (/API key is not configured|Unsupported OpenCode Go model/u.test(value.message))
      return "provider_config" as const;
    error = value.cause ?? value.lastError;
  }
  return undefined;
}
