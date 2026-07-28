// CONTEXT_STRATEGY feature flag (Issue 9). Read per call so tests and the
// ablation harness (Issue 10) can flip strategies without a restart.

export const CONTEXT_STRATEGIES = [
  "full_history",
  "generic_summary",
  "legal_state",
  "provider_native",
] as const;

export type ContextStrategy = (typeof CONTEXT_STRATEGIES)[number];

const known = new Set<string>(CONTEXT_STRATEGIES);
const warnedUnknown = new Set<string>();

export function contextStrategy(): ContextStrategy {
  const raw = process.env.CONTEXT_STRATEGY?.trim();
  if (!raw) return "full_history";
  if (known.has(raw)) return raw as ContextStrategy;
  if (!warnedUnknown.has(raw)) {
    warnedUnknown.add(raw);
    console.warn(
      `[context-strategy] unknown CONTEXT_STRATEGY "${raw}"; using full_history`,
    );
  }
  return "full_history";
}
