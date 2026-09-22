# LLM boundary

`index.ts` dispatches hosted models through the Vercel AI SDK, matching upstream
Mike's SDK family. Codex app-server and Claude Code remain native transports.
`sdkProviders.ts` contains endpoint/authentication and supported provider options;
`sdk.ts` retains only Beaver's ordered tool rounds, limits and callbacks. SDK
providers own request/stream parsing, reasoning signatures, usage and stop reasons.
This uses the SDK's documented manual-loop/external-execution pattern: omit
`execute`, keep `response.messages`, then append the host's matching tool results.
No second SSE parser or eager execution belongs here: `TurnToolRegistry` must
still validate and order the complete batch before another model step.

Hosted chat persists SDK `ModelMessage` pairs as private `model_messages` events
in the existing chat store. These preserve transport history, not the host's final
answer: merged grounded claims and host rejection messages remain in replay even
when SDK messages exist. The latest permitted grounded answer is copied directly
from durable receipts into turn context, outside generated/opaque checkpoints;
scoping retains whole claim-to-evidence bindings. Older receipts remain stored.
Tool results, errors, images and signatures replay on the same model; model changes
retain text/tool pairs without foreign reasoning signatures. Native compaction
replaces a prefix only for its exact model. OpenAI uses stateless Responses item
replay (`store: false`), including encrypted reasoning, rather than another remote
session store. Codex continues to own its native durable thread. A resumed repair
sends only its new repair instruction, not the original user request again.

Steering is persisted in causal order with SDK steps and replayed once as a user
instruction. Read-only retries retain completed tool pairs rather than rereading;
retries after committed mutations remain prohibited. Host compaction passes typed
messages through the same provider adapter rather than stringifying signatures or
images into user prose. Answering a workflow's input question
retains that workflow; an ordinary new message does not implicitly select it.
Provider output exhaustion and the host step limit raise explicit incomplete
results, not successful completion. Completed tool pairs persist before stopping;
truncated generation never authorizes tool effects. Duplicate call IDs are refused
before execution, and results must pair one-to-one before history is saved. Explicit
tool errors are not validated against success-only schemas. Stream/tool activity
reaches heartbeat callbacks; failed native compaction leaves no running status.

Claude caching is enabled explicitly and cache reads/writes count toward context.
Effort and summary visibility are separate provider options. Hosted discovery
expands the tool list without forcing a newly discovered tool to execute. Native
MCP transports advertise the complete scoped turn catalog (`staticTools`) once;
`load_tools` activates specialists in `TurnToolRegistry`, not in the client's tool
catalog. This avoids depending on list-change notifications over stateless HTTP.
Unloaded tools remain blocked by the registry, and failures retain MCP `isError`.
The loader returns the selected canonical definitions, including their parameter
schemas; repeat loads return those definitions again. Names without an executor
cannot be registered, and oversized discovery results refuse before activation.
Hosted adapters still send only `resolveTools()` definitions. If the model emits
loading and a known deferred call in one batch, the SDK's pre-load `NoSuchToolError`
is resolved by the ordered registry, not persisted instead of the real result.
Unknown names, malformed arguments, unloaded calls and incomplete generations
remain rejected. The full scoped catalog is not sent to hosted models.
The bridge preserves MCP annotations; a write is not advertised as read-only.
Codex's `default_tools_approval_mode: "approve"` applies only to the authenticated
`mike_runtime` bridge. Claude Code enables only its native `ToolSearch` discovery
builtin alongside the Beaver MCP allowlist; native schema deferral stays enabled.
This lets its client retrieve deferred MCP definitions without enabling native
shell, filesystem, agent or other execution tools.
Neither changes Beaver's execution authorization or grants native shell/file
permissions. Native dispatch also requires exactly one matching result per call.

Codex uses the stable stdio initialize/initialized, thread/start or thread/resume,
turn/start, turn/steer and turn/completed lifecycle. A start response identifies
the turn; notifications received before that identity are queued and replayed once
it is confirmed. Only that turn's events update the answer. A successful
`turn/start` response makes steering available without waiting for a second
notification; `turn/steer` must acknowledge the same ID. Completion remains
authoritative.
Use `codex app-server generate-json-schema` from the installed binary to check
its contract rather than adding a second hand-maintained protocol specification.
Normal telemetry remains content-free; `MIKE_LLM_METRICS_PATH` enables numeric
benchmark receipts.

References: [SDK manual loop control](https://ai-sdk.dev/docs/agents/loop-control),
[SDK external execution](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text),
[SDK message replay](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling),
[provider options](https://ai-sdk.dev/providers/ai-sdk-providers), and
[Responses conversation state](https://developers.openai.com/api/docs/guides/conversation-state),
[Codex app-server](https://developers.openai.com/codex/app-server),
[Codex MCP configuration](https://developers.openai.com/codex/mcp),
[Claude Code CLI permissions](https://code.claude.com/docs/en/cli-reference),
[MCP tool contract](https://modelcontextprotocol.io/specification/2025-06-18/server/tools),
and [DeepSeek reasoning replay](https://api-docs.deepseek.com/guides/thinking_mode/).

## Transport contracts

The hosted path uses the SDK's documented external-execution contract: omit
`execute`, consume a complete response, run the existing ordered dispatcher,
append its tool results to `response.messages`, and await durable persistence
before the next request. `jsonSchema` without a `validate` callback describes the
wire schema; it does not replace runtime validation. The registry validates every
call and owns deferred per-cell repair (`onInvalidInput`). Moving validation into
an SDK-only rejection path would bypass that existing behavior. Structured final
outputs separately use `Output.object` with an actual validator.

Codex initialization and stdio flags are checked against the real CLI, not inferred
from an overview example. A successful `turn/start` response makes steering
available without waiting for a second notification; earlier start events retain
their turn ID, and other-turn events are ignored. `turn/steer` must acknowledge
that same ID. Stop uses `turn/interrupt` and waits for native completion. Resume
uses `excludeTurns: true`: Codex retains its conversation; Beaver does not download
a duplicate history it never consumes.

Only the authenticated `mike_runtime` MCP server receives Codex's documented
`default_tools_approval_mode = "approve"`. Other approvals remain `never`, inherited
servers remain disabled, and the sandbox stays read-only. Claude Code uses its
existing `--allowedTools mcp__beaver` permission. Neither transport needs false
`readOnlyHint` annotations. Some Codex built-ins can still be advertised; the
sandbox and rejection of native approval requests, not prompt text, prevent
out-of-band file edits.

The MCP bridge exposes normalized text/images, not the original executor's
`structuredContent`, so it does not advertise the executor's `outputSchema`.
Underlying successful structured outputs still pass registry validation; URL
filtering, result limits, and explicit errors are unchanged.

Hosted providers receive `modelForProvider`'s native model ID, never Beaver's
`provider:model` picker identity. OpenCode Go lists every valid published slug;
its connection uses the existing vendor-aware wire resolver rather than rejecting
new releases through the older fixed list. Requests identify `beaver/1.0` and
retain the conversation's stable `x-opencode-session` header, as the gateway
requires. No additional gateway, model router, or protocol implementation is added.

Qualified protocol versions: locked AI SDK **7.0.98**, MCP SDK **1.29.0**, and
Codex CLI **0.155.1**. Focused tests run with `vitest run src/lib/llm/sdk.test.ts
src/lib/llm/codex.test.ts src/lib/llm/__tests__/mcpToolBridge.test.ts` from `backend`.
Native qualification also runs that CLI with an isolated home and loopback-only
scripted Responses server: initialize, scoped MCP load/call, resume, steering,
interruption and rejection of an out-of-band file edit. Generate its protocol with
`codex app-server generate-json-schema --out <dir>` when checking another release;
do not treat mocked RPC responses as proof that an installed CLI accepts a field.

Contract references: [Vercel external execution](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling),
[JSON Schema validation](https://ai-sdk.dev/docs/reference/ai-sdk-core/json-schema),
[Codex app server](https://developers.openai.com/codex/app-server),
[Codex configuration](https://developers.openai.com/codex/config-reference),
[Claude Code MCP permissions](https://code.claude.com/docs/en/permissions#mcp),
[OpenCode Go endpoints and client headers](https://opencode.ai/docs/go/),
and [MCP tool results](https://modelcontextprotocol.io/specification/2025-06-18/server/tools).
