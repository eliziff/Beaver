# LLM boundary

`index.ts` dispatches hosted models through the Vercel AI SDK, matching upstream
Mike's SDK family. Codex app-server and Claude Code remain native transports.
`sdkProviders.ts` contains endpoint/authentication and supported provider options;
`sdk.ts` uses SDK multi-step streaming, active-tool selection, result messages and
usage aggregation. One batch bridge invokes `TurnToolRegistry` exactly once per
completed model call; tool authorization, validation and ordered effects stay there.
SDK providers own wire parsing and reject tool effects from incomplete generations.
Required persistence failures stop execution explicitly, not through observer throws.

Hosted chat persists SDK `ModelMessage` pairs as private `model_messages` events
in the existing chat store. Display events are not the agent's resumable history.
Tool results, errors, images and signatures replay on the same model; model changes
retain text/tool pairs without foreign reasoning signatures. Native compaction
replaces a prefix only for its exact model. OpenAI uses stateless Responses item
replay (`store: false`), including encrypted reasoning, rather than another remote
session store. Codex continues to own its native durable thread.

Steering is replayed as a user instruction. Answering a workflow's input question
retains that workflow; an ordinary new message does not implicitly select it.
Clarification after an authorized edit preserves that edit and pauses subsequent
work; an earlier mutation is not a reason to reject a genuine question.
Provider output exhaustion and the host step limit raise explicit incomplete
results, not successful completion. Completed tool pairs persist before stopping;
truncated generation never authorizes tool effects.

Claude caching is enabled explicitly and cache reads/writes count toward context.
Compaction is a public activity with running/completed/failed state. Its disclosure
shows the actual readable summary when one is returned; opaque OpenAI checkpoints
are identified as opaque, never expanded through another model call. Manual
compaction saves the same details in the existing transcript. Original history is
retained; provider signatures and encrypted payloads are not public text.

Structured callers provide `outputSchema` through `runChatTurn`. The SDK validates
its parsed output; native Codex/Claude CLI use their schema channels and the shared
boundary validates the returned object. Jev routing uses this path without fence
repair. `submit_grounded_answer`, `submit_extraction` and `ask_inputs` opt into
strict tool generation; external MCP and other tool schemas are not rewritten.
Strictness never replaces authorization, evidence membership, sentence granularity,
source-version checks or targeted claim repair. Only the inactive `claims`/`replace`
branch uses explicit null; unrelated optional/update semantics are unchanged.

Effort and summary visibility are separate provider options. Discovery expands the
tool list without forcing a newly discovered tool to execute. Normal telemetry
remains content-free; `MIKE_LLM_METRICS_PATH` enables numeric benchmark receipts.

References: [SDK message replay](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling),
[provider options](https://ai-sdk.dev/providers/ai-sdk-providers), and
[Responses conversation state](https://developers.openai.com/api/docs/guides/conversation-state).
