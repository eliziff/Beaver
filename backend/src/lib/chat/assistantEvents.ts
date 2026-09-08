import { z } from "zod";
import { activity, subagent, sharedEvents, type PublicAssistantEvent } from "./assistantWire";
export { parsePublicAssistantEvent } from "./assistantWire";
export type { PublicAssistantEvent, ToolActivity, AskInputItem, AskInputOption, AskInputsEvent,
  AskInputResponseItem, AskInputsResponseRequest, WorkflowRunEvent } from "./assistantWire";
import { researchReadContextSchema } from "../researchReader";
import { storedLegalEvidenceReceipt, storedLegalResearchQueryReceipt,
  type LegalEvidenceReceipt, type LegalResearchQueryReceipt } from "./legalEvidence";

const text = z.string();
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
  collections: z.array(text).optional(), source_types: z.array(text).optional(),
  resources: z.array(text).optional(), evidence_ids: z.array(text).optional() }).strict();
const resume = z.object({ id: text, continuation_id: text, model: text, effort: text,
  assignment, evidence: z.array(evidence), queries: z.array(query),
  research: researchReadContextSchema.optional(), activities: z.array(activity).optional() }).strict();
const privateSubagent = subagent.extend({ agent: z.enum(["scout", "native"]), model: text, effort: text,
  publicError: text.optional(), grounding: receipt.optional(), resume: resume.optional() });

const storedEvent = z.discriminatedUnion("type", [
  ...sharedEvents, privateSubagent, checkpoint, receipt,
  z.object({ type: z.literal("mcp_tool_call"), connector_id: text, connector_name: text,
    tool_name: text, openai_tool_name: text, status: z.enum(["ok", "error"]), error: text.optional() }).strict(),
  z.object({ type: z.literal("local_mutation_committed"), schema_version: z.literal(1) }).strict(),
  z.object({ type: z.literal("local_turn_completed"), schema_version: z.literal(1) }).strict(),
]);

export function parseAssistantEvent(value: unknown): AssistantEvent | null {
  const parsed = storedEvent.safeParse(value);
  return parsed.success ? parsed.data : null;
}
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
