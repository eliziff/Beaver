// Only the critical-path live-turn spec consumes this Anthropic opt-in gate.
export const hasLlmKey = Boolean(process.env.ANTHROPIC_API_KEY);

export const LLM_SKIP_REASON =
    "requires a model key — set the ANTHROPIC_API_KEY secret to run LLM-dependent specs";
