import { z } from "zod";
import { WORK_PRODUCT_KINDS } from "mike/shared/work-products.mjs";
import { buildCanliiLawUrl } from "../canliiUrls";

export const ASSISTANT_LIMITS = { activities: 256, artifacts: 64, blocks: 128,
  citations: 256, readers: 32, text: 1_000_000 } as const;
export const FIELD_TEXT_LIMIT = 8_192, SHORT_TEXT_LIMIT = 512;
export function safeAssistantUrl(value: unknown, { relative = true } = {}): string | null {
  const raw = typeof value === "string" ? value.trim().slice(0, FIELD_TEXT_LIMIT) : "";
  if (!raw || raw.includes("\\") ||
      Array.from(raw).some((character) => character.charCodeAt(0) <= 0x1f)) return null;
  if (relative && raw.startsWith("/") && !raw.startsWith("//")) return raw;
  try {
    const url = new URL(raw);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
const text = z.string().max(FIELD_TEXT_LIMIT), short = z.string().max(SHORT_TEXT_LIMIT).trim();
const id = short.min(1), integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const longText = z.string().max(ASSISTANT_LIMITS.text), finite = z.number().finite();
const url = text.nullable().transform((value) => safeAssistantUrl(value));
const validUrl = url.refine((value): value is string => value !== null);
const status = z.enum(["running", "completed", "error", "interrupted", "cancelled"]);
const display = { source_class: z.enum(["case", "legislation", "commentary"]).optional(),
  external_url: url.optional(), authority: short.optional(), short_authority: short.optional(),
  short_form: z.boolean().optional(), locator_separator: z.enum([" at ", ", "]).optional() };
const locator = { ...display, locator_kind: z.enum(["paragraph", "page", "section", "footnote"]).optional(),
  locator: short.nullable().optional(), pinpoint: short.nullable().optional() };
const quotes = z.array(z.object({ quote: text }).strict()).max(32).default([]);
const citation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("a2aj"), ref: integer, citation: short.nullable().optional(),
    name: short.nullable().optional(), dataset: short.nullable().optional(),
    url: url.nullable().optional(), quotes, ...locator }).strict(),
  z.object({ kind: z.literal("public_legal"), ref: integer,
    provider: z.enum(["courtlistener", "tna", "govuk-et", "govinfo", "hansard", "journal"]),
    identifier: id, title: short.nullable().optional(), citation: short.nullable().optional(),
    url: url.nullable().optional(), quotes, ...locator }).strict(),
  z.object({ kind: z.literal("tabular"), ref: integer, review_id: id, col_index: integer,
    row_index: integer, col_name: short.default(""), doc_name: short.default(""), quotes, ...display }).strict(),
  z.object({ kind: z.literal("document"), ref: integer, document_id: id, filename: id,
    sheet: short.optional(), cells: short.optional(), version_id: short.optional(),
    version_number: integer.optional(), url: url.optional(), ...locator,
    locator_kind: z.enum(["document", "paragraph", "page", "section", "footnote", "sheet", "cell"]).optional(),
    quotes: z.array(z.object({ quote: text, sheet: short.optional(), cell: short.optional(),
      page: z.union([finite, short]).optional() }).strict()).max(32).default([]) }).strict(),
]);
export type AssistantCitation = z.infer<typeof citation>;
export function parseAssistantCitations(value: unknown): AssistantCitation[] {
  try {
    return Array.isArray(value) ? value.slice(0, ASSISTANT_LIMITS.citations).flatMap((raw) => {
      try {
        const parsed = citation.safeParse(raw); if (!parsed.success) return [];
        // Legislation links go to CanLII's statute page, also for citations stored before that rule.
        const canlii = parsed.data.kind === "a2aj" && parsed.data.source_class !== "case"
          ? buildCanliiLawUrl({ dataset: parsed.data.dataset ?? "", citation: parsed.data.citation ?? null, language: "en" }) : null;
        return [canlii ? { ...parsed.data, url: canlii, external_url: canlii } : parsed.data];
      }
      catch { return []; }
    }) : [];
  } catch { return []; }
}
const citations = z.array(z.unknown()).transform(parseAssistantCitations);
export const activity = z.object({ id, tool: id, label: id, status,
  citations: citations.optional() }).strict();
const choice = z.object({ id, kind: z.literal("choice"), question: text,
  options: z.array(z.object({ value: id }).strict()).min(1).max(32) }).strict();
const documents = z.object({ id, kind: z.literal("documents"),
  document_types: z.array(short).max(32).default([]) }).strict();
const response = z.discriminatedUnion("kind", [
  z.object({ id, kind: z.literal("choice"), answer: text.optional() }).strict(),
  z.object({ id, kind: z.literal("documents"), documents: z.array(
    z.object({ document_id: id, filename: id }).strict()).max(32).default([]) }).strict(),
]);
const ask = z.object({ type: z.literal("ask_inputs"),
  items: z.array(z.discriminatedUnion("kind", [choice, documents])).min(1).max(32) }).strict();
const annotation = z.object({ edit_id: id, document_id: id, version_id: id,
  version_number: integer.nullable().optional(), del_w_id: short.optional(), ins_w_id: short.optional(),
  deleted_text: text.default(""), inserted_text: text.default(""), context_before: text.optional(),
  context_after: text.optional(), reason: text.optional(), diff: z.array(z.object({
    kind: z.enum(["equal", "delete", "insert"]), text }).strict()).max(256).default([]),
  status: z.enum(["pending", "accepted", "rejected"]) }).strict();
export const workflow = z.object({ type: z.literal("workflow_run"), id: short.optional(),
  tool: z.enum(["create_table_of_authorities", "update_work_product"]),
  stage: short.default("Workflow"), status: short.default("unknown"), error: short.optional(),
  progress: finite.min(0).max(100).optional(), message: text.optional(),
  counts: z.array(z.object({ label: id, value: finite }).strict()).max(32).optional(),
  outputs: z.array(z.object({ name: id, url: validUrl.optional() }).strict()).max(32).optional(),
  app_url: validUrl.optional(), job_id: short.optional(), version_number: integer.nullable().optional(),
  work_product: z.object({ id, kind: z.enum(WORK_PRODUCT_KINDS), revision: integer.min(1) }).strict().optional(),
  requested_action: z.enum(["open", "refresh", "build"]).optional() }).strict();
export const subagent = z.object({ type: z.literal("subagent_run"), id, task: longText, status,
  activity: activity.optional(), activities: z.array(activity).max(ASSISTANT_LIMITS.activities).optional(),
  output: longText.optional(), error: short.optional(), citations: citations.optional() }).strict();
export const sharedEvents = [
  z.object({ type: z.literal("reasoning"), text: longText }).strict(),
  z.object({ type: z.literal("content"), text: longText }).strict(),
  z.object({ type: z.literal("tool_activity"), ...activity.shape }).strict(),
  ask, z.object({ type: z.literal("ask_inputs_response"), responses: z.array(response).max(32) }).strict(),
  z.object({ type: z.literal("document_artifact"), action: z.enum(["created", "edited"]),
    filename: id, download_url: validUrl.refine((value) => value.startsWith("/")),
    document_id: id, version_id: id, version_number: integer.nullable(),
    edit_mode: z.enum(["manual", "auto"]).optional(), annotations: z.array(annotation).max(256).optional() }).strict(),
  workflow, z.object({ type: z.literal("steering"), id, text }).strict(),
  z.object({ type: z.literal("context_usage"), used_tokens: finite.min(0), window_tokens: finite.positive() }).strict(),
  z.object({ type: z.literal("compaction"), status: z.enum(["running", "completed", "failed"]) }).strict(),
  z.object({ type: z.literal("turn_status"), status: z.literal("cancelled") }).strict(),
  z.object({ type: z.literal("error"), message: text,
    retryable: z.boolean().optional(), accepted: z.boolean().optional() }).strict(),
] as const;
export const publicEvent = z.discriminatedUnion("type", [
  ...sharedEvents, subagent,
  z.object({ type: z.literal("turn_queued"), jobId: id }).strict(),
  z.object({ type: z.literal("chat_id"), chatId: id, transcriptVersion: integer.optional() }).strict(),
  z.object({ type: z.literal("transcript_version"), transcriptVersion: integer }).strict(),
  z.object({ type: z.literal("client_tool_call"), callId: id, name: id, input: z.record(z.unknown()) }).strict(),
  z.object({ type: z.literal("reasoning_delta"), text: z.string().max(65_536) }).strict(),
  z.object({ type: z.literal("reasoning_block_end") }).strict(),
  z.object({ type: z.literal("content_final"), text: longText, citations }).strict(),
]);
export type PublicAssistantEvent = z.infer<typeof publicEvent>;
export type ToolActivity = z.infer<typeof activity>;
export type AskInputItem = z.infer<typeof choice> | z.infer<typeof documents>;
export type AskInputOption = z.infer<typeof choice>["options"][number];
export type AskInputsEvent = z.infer<typeof ask>;
export type AskInputResponseItem = z.infer<typeof response>;
export type AskInputsResponseEvent = Extract<PublicAssistantEvent, { type: "ask_inputs_response" }>;
export type AskInputsResponseRequest = { responses: AskInputResponseItem[] };
export type WorkflowRunEvent = z.infer<typeof workflow>;
export const parsePublicAssistantEvent = (value: unknown): PublicAssistantEvent => publicEvent.parse(value);
