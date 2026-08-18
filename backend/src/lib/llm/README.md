# LLM boundary

Purpose: translate Beaver's provider-neutral messages and MCP-shaped tools to
each provider's native protocol.

Public entrypoint: `lib/llm/index.ts`.

Canonical operations:

- `streamChatWithTools` for interactive/provider tool loops.
- `completeText` for one-shot text generation.
- model/provider helpers exported by `index.ts`.

Provider modules are wire adapters, not application APIs. Keep their native
streaming, reasoning, tool, cancellation, and usage behavior there. Do not add
provider call-through modules or recreate completion dispatch outside
`index.ts`.
