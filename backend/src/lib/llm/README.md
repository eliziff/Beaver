# LLM boundary

`index.ts` dispatches hosted models through the Vercel AI SDK, matching upstream
Mike's SDK family. Codex app-server and Claude Code remain native transports.
`sdkProviders.ts` contains endpoint/authentication and supported provider options;
`sdk.ts` retains only Beaver's ordered tool rounds, limits and callbacks. SDK
providers own request/stream parsing, reasoning signatures, usage and stop reasons.
No second SSE parser or automatic tool execution belongs here: the existing
`TurnToolRegistry` must still validate and order the complete tool batch.

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
session store. Codex continues to own its native durable thread.

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
Normal telemetry remains content-free; `MIKE_LLM_METRICS_PATH` enables numeric
benchmark receipts.

References: [SDK message replay](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling),
[provider options](https://ai-sdk.dev/providers/ai-sdk-providers), and
[Responses conversation state](https://developers.openai.com/api/docs/guides/conversation-state).
