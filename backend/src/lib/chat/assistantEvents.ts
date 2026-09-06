import { z } from "zod";
import { WORK_PRODUCT_KINDS } from "../workProduct";
import { storedLegalEvidenceReceipt, storedLegalResearchQueryReceipt,
  type LegalEvidenceReceipt, type LegalResearchQueryReceipt } from "./legalEvidence";

const text = z.string(), integer = z.number().int().nonnegative();
const citations = z.array(z.record(z.unknown()));
const activity = z.object({ id: text, tool: text, label: text,
  status: z.enum(["running", "completed", "error", "interrupted"]),
  citations: citations.optional() }).strict();
const choice = z.object({ id: text, kind: z.literal("choice"), question: text,
  options: z.array(z.object({ value: text }).strict()) }).strict();
const documents = z.object({ id: text, kind: z.literal("documents"),
  document_types: z.array(text) }).strict();
const response = z.discriminatedUnion("kind", [
  z.object({ id: text, kind: z.literal("choice"), answer: text.optional() }).strict(),
  z.object({ id: text, kind: z.literal("documents"), documents: z.array(
    z.object({ document_id: text, filename: text }).strict()) }).strict(),
]);
const ask = z.object({ type: z.literal("ask_inputs"),
  items: z.array(z.discriminatedUnion("kind", [choice, documents])) }).strict();
const annotation = z.object({ edit_id: text, document_id: text, version_id: text,
  version_number: integer.nullable().optional(), del_w_id: text.optional(), ins_w_id: text.optional(),
  deleted_text: text, inserted_text: text, context_before: text, context_after: text,
  reason: text.optional(), diff: z.array(z.object({
    kind: z.enum(["equal", "delete", "insert"]), text }).strict()),
  status: z.enum(["pending", "accepted", "rejected"]) }).strict();
const workflow = z.object({ type: z.literal("workflow_run"), id: text,
  tool: z.enum(["update_work_product"]), stage: text,
  status: z.enum(["complete", "error"]), error: text.optional(),
  counts: z.array(z.object({ label: text, value: z.number().finite() }).strict()).optional(),
  outputs: z.array(z.object({ name: text }).strict()).optional(), app_url: text.optional(),
  work_product: z.object({ id: text, kind: z.enum(WORK_PRODUCT_KINDS),
    revision: integer.min(1) }).strict().optional(), requested_action: text.optional(),
  version_number: z.number().finite().optional() }).strict();
const subagent = z.object({ type: z.literal("subagent_run"), id: text, task: text,
  status: z.enum(["running", "completed", "error", "cancelled", "interrupted"]),
  activity: activity.optional(), activities: z.array(activity).optional(),
  output: text.optional(), error: text.optional(), citations: citations.optional() }).strict();
const checkpoint = z.object({ type: z.literal("context_checkpoint"), schema_version: z.literal(1),
  summary: text.optional(), keep_current: z.boolean(), provider: z.enum(["claude", "openai"]).optional(),
  payload: z.record(z.unknown()).optional() }).strict();
const evidence = z.custom<LegalEvidenceReceipt>((value) => storedLegalEvidenceReceipt(value) !== null);
const query = z.custom<LegalResearchQueryReceipt>((value) => storedLegalResearchQueryReceipt(value) !== null);
const receipt = z.object({ type: z.literal("legal_evidence_receipt"), schema_version: z.literal(7),
  mode: z.literal("citation_structure").nullable(), status: z.enum(["passed", "failed"]),
  verification: z.object({ reference: z.literal("verified"), answerability: z.literal("not_run"),
    holistic: z.literal("not_run"), semantic: z.literal("not_run"), coverage: z.literal("not_run"),
    authority: z.literal("not_run") }).strict(),
  claims: z.array(z.object({ text, evidence_ids: z.array(text), text_sha256: text,
    context_status: z.literal("not_run"), evidence_status: z.literal("not_run") }).strict()),
  evidence: z.array(evidence), queries: z.array(query), bounces: z.tuple([]),
  failure: text.nullable() }).strict();
const assignment = z.object({ task: text, scope: text, jurisdiction: z.enum(["CA", "US", "UK"]),
  collections: z.array(text).optional(), source_types: z.array(text).optional() }).strict();
const resume = z.object({ id: text, continuation_id: text, model: text, effort: text,
  assignment, evidence: z.array(evidence), activities: z.array(activity).optional() }).strict();
const privateSubagent = subagent.extend({ agent: z.enum(["scout", "native"]), model: text, effort: text,
  publicError: text.optional(), grounding: receipt.optional(), resume: resume.optional() });

const sharedEvents = [
  z.object({ type: z.literal("reasoning"), text }).strict(),
  z.object({ type: z.literal("content"), text }).strict(),
  z.object({ type: z.literal("tool_activity"), ...activity.shape }).strict(),
  ask, z.object({ type: z.literal("ask_inputs_response"), responses: z.array(response) }).strict(),
  z.object({ type: z.literal("document_artifact"), action: z.enum(["created", "edited"]),
    filename: text, download_url: text, document_id: text, version_id: text,
    version_number: integer.nullable(), edit_mode: z.enum(["manual", "auto"]).optional(),
    annotations: z.array(annotation).optional() }).strict(),
  workflow,
  z.object({ type: z.literal("steering"), id: text, text }).strict(),
  z.object({ type: z.literal("context_usage"), used_tokens: integer,
    window_tokens: integer }).strict(),
  z.object({ type: z.literal("compaction"), status: z.enum(["running", "completed", "failed"]) }).strict(),
  z.object({ type: z.literal("turn_status"), status: z.literal("cancelled") }).strict(),
  z.object({ type: z.literal("error"), message: text,
    retryable: z.boolean().optional(), accepted: z.boolean().optional() }).strict(),
] as const;
const publicEvent = z.discriminatedUnion("type", [
  ...sharedEvents, subagent,
  z.object({ type: z.literal("turn_queued"), jobId: text }).strict(),
  z.object({ type: z.literal("chat_id"), chatId: text, transcriptVersion: integer }).strict(),
  z.object({ type: z.literal("transcript_version"), transcriptVersion: integer }).strict(),
  z.object({ type: z.literal("client_tool_call"), callId: text, name: text,
    input: z.record(z.unknown()) }).strict(),
  z.object({ type: z.literal("reasoning_delta"), text }).strict(),
  z.object({ type: z.literal("reasoning_block_end") }).strict(),
  z.object({ type: z.literal("content_final"), text, citations }).strict(),
]);
const storedEvent = z.discriminatedUnion("type", [
  ...sharedEvents, privateSubagent, checkpoint, receipt,
  z.object({ type: z.literal("mcp_tool_call"), connector_id: text, connector_name: text,
    tool_name: text, openai_tool_name: text, status: z.enum(["ok", "error"]), error: text.optional() }).strict(),
  z.object({ type: z.literal("local_mutation_committed"), schema_version: z.literal(1) }).strict(),
  z.object({ type: z.literal("local_turn_completed"), schema_version: z.literal(1) }).strict(),
]);

export type PublicAssistantEvent = z.infer<typeof publicEvent>;
export const parsePublicAssistantEvent = (value: unknown): PublicAssistantEvent => publicEvent.parse(value);
export function parseAssistantEvent(value: unknown): AssistantEvent | null {
  const parsed = storedEvent.safeParse(value);
  return parsed.success ? parsed.data : null;
}
export type ToolActivity = z.infer<typeof activity>;
export type AskInputItem = z.infer<typeof choice> | z.infer<typeof documents>;
export type AskInputOption = z.infer<typeof choice>["options"][number];
export type AskInputsEvent = z.infer<typeof ask>;
export type AskInputResponseItem = z.infer<typeof response>;
export type AskInputsResponseRequest = { responses: AskInputResponseItem[] };
export type WorkflowRunEvent = z.infer<typeof workflow>;
export type PublicSubagentEvent = Extract<PublicAssistantEvent, { type: "subagent_run" }>;
export type PublicTranscriptEvent = Extract<PublicAssistantEvent, { type:
  "ask_inputs" | "ask_inputs_response" | "workflow_run" | "compaction" | "content" |
  "document_artifact" | "error" | "steering" | "subagent_run" | "tool_activity" | "turn_status" }>;
export type ContextCheckpointEvent = z.infer<typeof checkpoint>;
export type LegalEvidenceReceiptEvent = z.infer<typeof receipt>;
export type ReadSubagentAssignment = z.infer<typeof assignment>;
export type ReadSubagentCheckpoint = z.infer<typeof resume>;
export type ReadSubagentEvent = z.infer<typeof privateSubagent>;
export type AssistantEvent = z.infer<typeof storedEvent>;
export type McpToolEvent = Extract<AssistantEvent, { type: "mcp_tool_call" }>;

export function publicAssistantEvent(event: ReadSubagentEvent): PublicSubagentEvent;
export function publicAssistantEvent(event: AssistantEvent): PublicTranscriptEvent | null;
export function publicAssistantEvent(event: AssistantEvent): PublicTranscriptEvent | null {
  switch (event.type) {
    case "subagent_run": return {
      type: event.type, id: event.id, task: event.task, status: event.status,
      ...(event.activity && { activity: event.activity }),
      ...(event.activities && { activities: event.activities }),
      ...(event.output !== undefined && { output: event.output }),
      ...(event.publicError !== undefined && { error: event.publicError }),
      ...(event.citations && { citations: event.citations }),
    };
    case "ask_inputs": case "ask_inputs_response": case "workflow_run": case "compaction":
    case "content": case "document_artifact": case "error": case "steering":
    case "tool_activity": case "turn_status": return event;
    default: return null;
  }
}
