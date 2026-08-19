# LLM boundary

Purpose: translate Beaver's provider-neutral messages and MCP-shaped tools to
each provider's native protocol.

Public entrypoint: `lib/llm/index.ts`.

Canonical operations:

- `streamChatWithTools` for interactive/provider tool loops.
- `completeText` for one-shot text generation.
- model/provider helpers exported by `index.ts`.

`providerLoop.ts` owns every API-provider agent loop. Protocol wire adapters
only encode requests and normalize wire events; provider-named modules contain
fixed endpoint and credential configuration. Tool authorization and execution
stay with the caller's `TurnToolRegistry`. Do not add provider call-through
modules or recreate completion dispatch outside `index.ts`.

Production records no prompts, responses, hashes, or provider identifiers.
Benchmarks may set `MIKE_LLM_METRICS_PATH` to append numeric token and byte
counts; do not turn that opt-in receipt into product telemetry.
