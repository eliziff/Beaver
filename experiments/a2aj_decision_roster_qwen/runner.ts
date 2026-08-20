#!/usr/bin/env node

/**
 * Random A2AJ decision-roster sidecar experiment.
 *
 * Paragraph structure is deliberately not implemented here. The runner uses
 * the backend's SourceDoc/A2AJ compiler and lookup/evidence contracts, then
 * adds only the experiment-specific opinion-role extraction task.
 */

import { createHash, randomInt, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fork, spawn, spawnSync, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import {
  a2ajLocalBulkPath,
  fetchLocalA2AJDocument,
  fetchLocalA2AJDocumentsByIds,
} from "../../backend/src/lib/a2ajLocalBulk";
import {
  a2ajLegalSourceProvider,
  type A2AJDocument,
} from "../../backend/src/lib/legalSources/a2aj";
import {
  a2ajLookupEvidenceBlocks,
} from "../../backend/src/lib/chat/tools/a2ajTools";
import {
  createA2AJDocumentEvidence,
  type LegalEvidenceReceipt,
} from "../../backend/experiments/legal-evidence/legalEvidenceExperiment";
import {
  withReadonlySqlite,
} from "../../backend/src/lib/legalDataPath";
import {
  sourceDocQuoteWords,
  tokenizeSourceText,
  type SourceDoc,
  type SourceDocBlock,
} from "../../backend/src/lib/sourceDoc";
import { deriveA2AJSourceDoc } from "../../backend/src/lib/sourceDocStructureHost";
import { shutdownSourceStructureEngine } from "../../backend/src/lib/sourceStructureEngine";
import {
  citationLookupKey,
  citationsInText,
} from "../../backend/src/lib/citationKey";
import { citationAliasKeys } from "../../backend/src/lib/caselawCitator";
import { classifyCitatorExcerpt } from "../../backend/src/lib/citatorExcerpts";
import {
  analyzeOpinionStructure,
  analyzeTextOpinionStructure,
  deriveTextOpinionStructure,
  MIN_OPINION_WORDS,
  partitionOpinionStructure,
  type JudgeOpinionRelationship,
  type JudgeResultSide,
  type OpinionAlignment,
  type OpinionStructure,
  type TextOpinionStructure,
} from "../../backend/experiments/a2aj-decision-roster/legalOpinionBoundaries";
import {
  createJudgeCourtServiceResolver,
  type JudgeCourtRegistryData,
  type JudgeCourtServiceResolver,
} from "../../backend/experiments/a2aj-decision-roster/judgeCourtService";
import {
  CASE_ISSUE_CARD_SCHEMA,
  resolveIssueCards,
  type ModelIssueCard,
} from "../../backend/experiments/a2aj-decision-roster/caseSemanticMvp";
import {
  CASE_TREATMENT_ITEM_SCHEMA,
  citationTarget,
  resolveTreatmentBatch,
  type ModelTreatmentItem,
  type OpinionPosition,
  type TreatmentInput,
} from "../../backend/experiments/a2aj-decision-roster/caseTreatment";
import {
  footnoteReferenceContext,
  resolveCaseTargetMvp,
  type CaseTargetOccurrence,
} from "../../backend/experiments/a2aj-decision-roster/caseTargetMvp";
import {
  CASE_TARGET_MVP_REDUCED_JSON_SCHEMA,
  compileReducedCaseTargetSubmission,
  type ReducedCaseTargetSubmission,
} from "../../backend/experiments/a2aj-decision-roster/caseTargetMvpReduced";

type Role = "majority" | "minority" | "concurring" | "unknown";
type Provider = "ollama" | "luna" | "dry";
type Range = { from: number; to: number };
type ResultPosition = "supports_disposition" | "opposes_disposition" | "mixed" | "unclear";
type OpinionLinkRelation = "authors" | "joins" | "joins_in_part";
type OpinionAuthorityPosition = "unanimous" | "majority" | "plurality" | "concurring" | "dissenting" | "unknown";

type CaseTargetSpec = {
  documentId: number | null;
  citation: string;
  citationAliases: string[];
  name: string | null;
  sameLitigationEligible: boolean;
};

type Candidate = {
  documentId: number;
  dataset: string;
  citation: string;
  name: string | null;
  date: string | null;
  target?: CaseTargetSpec;
};

type MechanicalOpinion = {
  role: Role;
  from: number | null;
  to: number | null;
  excerpt: string;
};

type MechanicalHints = {
  judgeCandidates: string[];
  opinions: MechanicalOpinion[];
  header: string;
  status: "usable" | "unresolved" | "unavailable";
};

type PreflightSearch = {
  term: string;
  paragraph_hits: string[];
  snippets: string[];
};

type Preflight = {
  searches: PreflightSearch[];
  note: string;
};

type CitationEdgeCandidate = {
  id: string;
  citation: string;
  targetCitationKey: string;
  start: number;
  end: number;
  contextStart: number;
  contextEnd: number;
  context: string;
  contextSha256: string;
  excerptKind: ReturnType<typeof classifyCitatorExcerpt>["kind"];
  selectionRule: string;
};

type CaseRecord = {
  candidate: Candidate;
  document: A2AJDocument;
  source: SourceDoc;
  paragraphs: SourceDocBlock[];
  sourceEvidence: LegalEvidenceReceipt;
  sourceSha256: string;
  structure: OpinionStructure;
  deterministic: TextOpinionStructure;
  hints: MechanicalHints;
  preflight: Preflight;
  citationEdges: CitationEdgeCandidate[];
  targetOccurrences: CaseTargetOccurrence[];
};

type DeterministicAuditRecord = Pick<
  CaseRecord,
  "candidate" | "source" | "paragraphs" | "sourceSha256" | "structure" | "deterministic"
>;

type Prediction = {
  disposition_quote: string | null;
  disposition_start: number | null;
  disposition_end_exclusive: number | null;
  opinions: Array<{
    id: string;
    author_names: string[];
    collective_author: string | null;
    result_position: ResultPosition;
    position_evidence_quote: string | null;
    alignment: OpinionAlignment;
    /** Derived from explicit full-opinion authorship/joinders, never from `lead`. */
    authority_position: OpinionAuthorityPosition;
    start_quote: string;
    end_quote: string;
    start: number;
    end_exclusive: number;
    text_sha256: string;
    substantive_words: number;
    paragraphs: Range[];
  }>;
  participants: Array<{
    name: string;
    panel_evidence_quote: string | null;
    result_position: ResultPosition;
    opinion_links: Array<{
      opinion_id: string;
      relation: OpinionLinkRelation;
      evidence_quote: string | null;
    }>;
    result_only: boolean;
    result_only_evidence_quote: string | null;
    // Derived compatibility fields for the deterministic oracle and sidecar.
    result_side: JudgeResultSide;
    relationship: JudgeOpinionRelationship;
    opinion_ids: string[];
  }>;
  nonparticipants: Array<{
    name: string;
    evidence_quote: string | null;
  }>;
};

type MechanicalReference = {
  source: "mechanical";
  status: "ready" | "unresolved";
  judges: Array<{ name: string; role: Role }>;
  spans: Record<Role, Range[]>;
  note?: string;
};

type HumanReference = {
  source: "human";
  status: "ready";
  prediction: Prediction;
};

type Reference = MechanicalReference | HumanReference;

type Validation = {
  ok: boolean;
  error?: string;
  errors?: string[];
  warnings?: string[];
  next?: string;
};

type Args = Record<string, string | number | boolean | undefined>;

type JudgeRegistryContext = {
  resolver: JudgeCourtServiceResolver;
  sha256: string;
  absolutePath: string;
};

const HERE = __dirname;
const RUN_DIR = path.join(HERE, "runs");
const DEFAULT_MODEL = process.env.QWEN_MODEL?.trim() || "qwen3.5:9b";
const DEFAULT_CODEX_MODEL = "gpt-5.6-luna";
const DEFAULT_CODEX_EFFORT = "high";
const MVP_CODEX_MODELS = new Set([DEFAULT_CODEX_MODEL, "gpt-5.6-terra"]);
const DEFAULT_BASE_URL = process.env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434";
const DEFAULT_SIDECAR = path.join(RUN_DIR, "decision-roster.sqlite");
const DEFAULT_NUM_CTX = 32_768;
const DEFAULT_NUM_PREDICT = 4_096;
const PROMPT_VERSION = "a2aj-opinion-v5";
const CODEX_PROMPT_VERSION = "a2aj-opinion-codex-v6";
const SEMANTIC_MVP_PROMPT_VERSION = "a2aj-semantic-mvp-combined-v2";
const VALIDATOR_VERSION = "a2aj-opinion-validator-v7";
const SEMANTIC_MVP_VALIDATOR_VERSION = "a2aj-semantic-mvp-validator-v2";
export const CASE_TARGET_MVP_VALIDATOR_VERSION = "a2aj-case-target-mvp-validator-v13";
export const CASE_TARGET_MVP_COMPILER_VERSION = "a2aj-case-target-mvp-compiler-v13";
const CASE_TARGET_OCCURRENCE_VERSION = "a2aj-case-target-occurrences-v2";
const DETERMINISTIC_VERSION = "a2aj-opinion-deterministic-v6";
const RANDOM_SELECTION_VERSION = "a2aj-random-primary-key-rejection-v1";
const RESPONSE_SCHEMA_NAME = "a2aj_opinion_votes";
const SEMANTIC_MVP_SCHEMA_NAME = "a2aj_case_semantic_mvp";
const CASE_TARGET_MVP_SCHEMA_NAME = "a2aj_case_target_mvp_v13";
const SEMANTIC_MVP_CITATION_EDGES = 2;
const MAX_LOOKUP_PARAGRAPHS = 12;
const MAX_ATTEMPTS = 20;
const MAX_CODEX_STDERR_BYTES = 16 * 1024 * 1024;
const MAX_LUNA_SOURCE_CHARS = 400_000;
const CODEX_SUBSCRIPTION_ENDPOINT = "https://chatgpt.com/backend-api/codex";
const CODEX_SUBSCRIPTION_HELPER = path.join(HERE, "codex_subscription_exec.py");

const ROLE_KEYS: Role[] = ["majority", "minority", "concurring", "unknown"];
const OPINION_ALIGNMENTS: OpinionAlignment[] = [
  "lead",
  "same_result_separate_reasons",
  "different_result",
  "mixed",
  "unknown",
];
const RESULT_SIDES: JudgeResultSide[] = ["majority", "minority", "mixed", "unknown"];
const RELATIONSHIPS: JudgeOpinionRelationship[] = [
  "authors",
  "joins_reasons",
  "concurs_in_result_only",
  "mixed",
  "unknown",
];
const RESULT_POSITIONS: ResultPosition[] = ["supports_disposition", "opposes_disposition", "mixed", "unclear"];
const OPINION_LINK_RELATIONS: OpinionLinkRelation[] = ["authors", "joins", "joins_in_part"];
const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

const ROSTER_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    disposition_quote: { type: ["string", "null"] },
    opinions: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", pattern: "^o[1-9][0-9]*$" },
          author_names: {
            type: "array",
            minItems: 0,
            maxItems: 30,
            items: { type: "string", minLength: 2 },
          },
          collective_author: { type: ["string", "null"] },
          result_position: { type: "string", enum: RESULT_POSITIONS },
          position_evidence_quote: { type: ["string", "null"] },
          start_quote: { type: "string", minLength: 12 },
          end_quote: { type: "string", minLength: 12 },
        },
        required: ["id", "author_names", "collective_author", "result_position", "position_evidence_quote", "start_quote", "end_quote"],
      },
    },
    participants: {
      type: "array",
      minItems: 0,
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          panel_evidence_quote: { type: "string", minLength: 2 },
          result_position: { type: "string", enum: RESULT_POSITIONS },
          opinion_links: {
            type: "array",
            minItems: 0,
            maxItems: 20,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                opinion_id: { type: "string", pattern: "^o[1-9][0-9]*$" },
                relation: { type: "string", enum: OPINION_LINK_RELATIONS },
                evidence_quote: { type: "string", minLength: 2 },
              },
              required: ["opinion_id", "relation", "evidence_quote"],
            },
          },
          result_only: { type: "boolean" },
          result_only_evidence_quote: { type: ["string", "null"] },
        },
        required: ["name", "panel_evidence_quote", "result_position", "opinion_links", "result_only", "result_only_evidence_quote"],
      },
    },
    nonparticipants: {
      type: "array",
      minItems: 0,
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", minLength: 2 },
          evidence_quote: { type: "string", minLength: 2 },
        },
        required: ["name", "evidence_quote"],
      },
    },
  },
  required: ["disposition_quote", "opinions", "participants", "nonparticipants"],
} as const;

/** The same schema in the Responses API `text.format` shape. */
const GPT_RESPONSES_SCHEMA = {
  type: "json_schema",
  name: RESPONSE_SCHEMA_NAME,
  strict: true,
  schema: ROSTER_JSON_SCHEMA,
} as const;

const SEMANTIC_MVP_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...ROSTER_JSON_SCHEMA.properties,
    issue_cards: {
      type: "array",
      minItems: 1,
      maxItems: 40,
      items: CASE_ISSUE_CARD_SCHEMA,
    },
    treatments: {
      type: "array",
      items: CASE_TREATMENT_ITEM_SCHEMA,
    },
  },
  required: [...ROSTER_JSON_SCHEMA.required, "issue_cards", "treatments"],
} as const;

const SEMANTIC_MVP_RESPONSES_SCHEMA = {
  type: "json_schema",
  name: SEMANTIC_MVP_SCHEMA_NAME,
  strict: true,
  schema: SEMANTIC_MVP_JSON_SCHEMA,
} as const;

export const CASE_TARGET_MVP_JSON_SCHEMA = CASE_TARGET_MVP_REDUCED_JSON_SCHEMA;

export const CASE_TARGET_MVP_RESPONSES_SCHEMA = {
  type: "json_schema",
  name: CASE_TARGET_MVP_SCHEMA_NAME,
  strict: true,
  schema: CASE_TARGET_MVP_JSON_SCHEMA,
} as const;

const SUBMIT_TOOL = {
  type: "function",
  function: {
    name: "submit_roster",
    description:
      "Submit source-grounded substantive opinion blocks and judge voting relationships.",
    parameters: ROSTER_JSON_SCHEMA,
  },
} as const;

const LOOKUP_TOOL = {
  type: "function",
  function: {
    name: "a2aj_lookup",
    description: "Look up an exact A2AJ decision paragraph or paragraph range.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        citation: { type: "string" },
        doc_type: { type: "string", enum: ["cases"] },
        locator_type: { type: "string", enum: ["paragraph"] },
        locator: { type: "string" },
        end_locator: { type: "string" },
      },
      required: ["citation", "locator_type", "locator"],
    },
  },
};

const OPINION_INSTRUCTIONS = `Extract substantive judicial opinions, the disposition, and each judge's vote from this one closed-record decision.
An opinion is a substantive body of judicial reasons. A judge name, signature, disposition-only line, "I agree", "I concur", or "concurred in by" is a vote or joinder and is never a separate opinion by itself.
Copy a distinctive exact disposition_quote stating what the court did, or null only when no such passage can be located.
Use one opinion object per independently reasoned body. result_position says whether that opinion supports or opposes the court's disposition, is mixed across issues, or is genuinely unclear. author_names contains only named judicial authors; use collective_author for labels such as "The Court" or "The Tribunal". If a heading says the reasons are "OF THE COURT" and then lists the panel, use the collective author and leave author_names empty; the grouped panel line proves participation or joinder, not an individually identified writer. For a single-member court or tribunal, identify that sole decision-maker as author when a byline or signature ties them to the reasons or decision. Do not turn institutional labels into people. If the source does not identify an opinion's writer, leave author_names empty and collective_author null; never guess. position_evidence_quote is an exact quote supporting the result classification, or null only when the classification necessarily follows from the opinion and disposition.
Every member of the deciding panel belongs in participants. Put a judge explicitly said not to participate only in nonparticipants. Do not include judges from cited cases, earlier motions, counsel lists, or case histories. An end-of-document signature block may corroborate an already identified author or joinder, but must not by itself become a new opinion or an otherwise unsupported panel member. panel_evidence_quote and every nonparticipant evidence_quote must be exact source text proving that status.
Each opinion_link records authors, joins, or joins_in_part and an exact evidence quote that locally identifies that judge and the claimed relationship. Every evidence quote is one contiguous verbatim substring: never splice a heading directly to a later judge while omitting intervening names or text. For a grouped byline or joinder, copy the whole contiguous group through that judge's name. Panel membership or bare agreement does not prove authorship. A signature proves authorship only when its local wording identifies the signed reasons as that judge's own. A bare "I agree" or "I concur" following another judge's reasons joins those reasons; record a joins link. Use result_only=true with no opinion link only when the source limits agreement to the result, outcome, disposition, or conclusion, or independently states only the order the judge would make. A judge who writes separate substantive reasons is not result-only. If all participating judges reach the same disposition, all have result_position=supports_disposition; never use unclear merely because the source does not use the word "majority".
For each opinion copy an exact, verbatim start_quote from its first heading or substantive opening and an exact, verbatim end_quote through the terminal punctuation of its final substantive sentence. Use enough distinctive words for each quote to occur only once. Exclude panel metadata, signatures, bare joinders, solicitors, and corrections from the boundaries. Do not count character offsets; the validator resolves quotes against the source.
Return only JSON matching the supplied schema.`;

const SYSTEM_PROMPT = `YOU=QWEN. ONE A2AJ DECISION. DO NOT ASK A QUESTION.
${OPINION_INSTRUCTIONS}
Use deterministic preflight only as a search hint; it does not prove an opinion or vote. Read exact source paragraphs with a2aj_lookup when paragraph structure is available, then call submit_roster. NO PROSE AFTER THE TOOL CALL.`;

const CODEX_SYSTEM_PROMPT = `Closed-record extraction. Use only the supplied case; do not use tools or external knowledge.
${OPINION_INSTRUCTIONS}
The deterministic term-search preflight is only a navigation hint and is not an answer.`;

const SEMANTIC_MVP_INSTRUCTIONS = `Also extract issue cards and treatment for the supplied citation-edge sample.
ISSUE CARDS: Emit one card for each separately answered legal question in each opinion. Keep the elements of one applied test together unless the opinion gives them distinct answers or independent grounds. Do not emit questions the opinion expressly declines to decide. The question and answer are concise normalized statements, but every answer and basis or limit must cite evidence IDs. A discussion span covers the complete part of that opinion needed to understand the issue; it may cross paragraphs. Evidence quotes and span boundary quotes must be exact and unique within that opinion. Voice classifies who is speaking in the evidence. The answer itself needs current_court evidence. relation_to_disposition describes whether deciding this issue was necessary or an independent alternative ground; non_dispositive includes dicta and background.
TREATMENT: Return exactly one treatment item for every supplied citation_edge_id, even when both event arrays are empty. Classify what the identified passage does to that cited decision, not the general relationship between the two cases. current_court means the present opinion itself adopts the characterization. Keep counsel submissions, quotations, procedural recounting, and reported decisions in their own attribution classes. Direct appellate history applies only when this source decision and the cited target are themselves successive decisions in the same case; a passage merely recounting the cited authority's relationship to a third decision is not direct history for this edge. target_proposition_as_characterized is an optional concise paraphrase of the proposition this source attributes to the target; do not invent one or create an issue card merely because a citation exists.
The citation-edge sample is deliberately incomplete. Do not add treatment records for other citations.`;

const CASE_TARGET_MVP_NESTED_INSTRUCTIONS = `Extract this one closed-record citing decision and its treatment of the named target.

OPINIONS: Return one opinion for each independently reasoned judicial body, with exact unique boundary quotes, named writers only when proved by exact authorship evidence, any collective author and its exact evidence, whole-opinion joiners, and whether it supports, opposes, or is mixed on the disposition. A signature, judge name, bare agreement, or disposition line is not a separate opinion. Do not list the same person as both author and joiner of one opinion. If every participating judge reaches the same result, that result is unanimous, not unknown. List every deciding participant and proved nonparticipant.

ISSUES: Create one issue per legal question actually answered, never one merely argued, quoted, recounted, or left undecided. Inside each issue, group positions together only when they reach the same ultimate answer. Emit a position only for an opinion that addresses it. Give its answer, disposition relation, exact evidence, material rules/applications/qualifications, and any judge who joins only that position. At least one answer-evidence item must be the current court speaking. Do not output IDs, offsets, paragraphs, hierarchy, or discussion boundaries; the harness derives them from evidence and nesting.

TARGET: Account exactly once at the root for every supplied occurrence_id. Use mention_quote only for an additional exact unique short-form or case-name mention. Classify whether the occurrence is the current court, a party submission, quoted or reported authority, procedural recounting, document metadata such as a headnote or Cases Cited list, or genuinely unclear. Repeat the same occurrence_id or exact mention_quote inside a position only when that mention concerns the position's issue. Put treatment inside that position when it bears on the issue. Use unscoped_target_treatments only for genuine treatment that cannot honestly be tied to an answered issue. Record each treatment's attribution, label, scope, exact evidence, and the target proposition only as this decision characterizes it. Direct history exists only when this source and the target are successive decisions in the same litigation. Citation alone is referred_to; applied requires use of the target proposition to decide an issue or remedy.

All quotes are contiguous source text. The target's full decision is not supplied. Use only the citing decision and return only schema JSON.`;

export type CaseTargetPromptVariant = "nested";
export const CASE_TARGET_MVP_PROMPTS: Record<CaseTargetPromptVariant, { version: string; instructions: string }> = {
  nested: { version: "a2aj-case-target-mvp-nested-v13", instructions: CASE_TARGET_MVP_NESTED_INSTRUCTIONS },
};

const CASE_TARGET_MVP_SYSTEM_PROMPT = "Closed-record legal extraction. Use only the supplied citing decision. The response schema and its nesting are authoritative; return only schema JSON.";

const PREFLIGHT_TERMS: Array<{ term: string; re: RegExp }> = [
  { term: "majority", re: /\bmajority\b/iu },
  { term: "minority", re: /\bminority\b/iu },
  { term: "dissent", re: /\bdissent(?:ing)?\b/iu },
  { term: "concurring", re: /\bconcurring\b/iu },
  { term: "reasons", re: /\breasons?\s+for\s+(?:judg(?:e)?ment|decision)\b/iu },
];

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compact(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function json(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function now() {
  return new Date().toISOString();
}

function errorMessage(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  const cause = "cause" in error ? (error as Error & { cause?: unknown }).cause : undefined;
  if (!cause) return error.message;
  if (cause instanceof Error) return `${error.message}: ${cause.message}`;
  if (typeof cause === "object" && cause && "code" in cause) {
    return `${error.message}: ${String((cause as { code?: unknown }).code ?? "unknown cause")}`;
  }
  return `${error.message}: ${String(cause)}`;
}

const appendQueues = new Map<string, Promise<void>>();

async function appendBytes(file: string, data: string | Buffer) {
  const previous = appendQueues.get(file) ?? Promise.resolve();
  const next = previous.then(async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, data);
  });
  appendQueues.set(file, next);
  try {
    await next;
  } finally {
    if (appendQueues.get(file) === next) appendQueues.delete(file);
  }
}

async function appendJsonl(file: string, event: Record<string, unknown>) {
  await appendBytes(file, `${JSON.stringify({ utc: now(), ...event })}\n`);
}

async function appendJsonlBatch(file: string, events: Record<string, unknown>[]) {
  if (!events.length) return;
  await appendBytes(file, `${events.map((event) => JSON.stringify({ utc: now(), ...event })).join("\n")}\n`);
}

export async function modelCallLedgerUsage(file: string) {
  let attempted = 0;
  await readJsonl(file, (event) => {
    if (event.kind === "call_budget_carry_forward") attempted += Math.max(0, Number(event.attempted_calls) || 0);
    if (event.kind === "model_call_started") attempted += 1;
    if (event.kind === "model_call_retry_started") attempted += 1;
  });
  return attempted;
}

function parseIntFlag(args: Args, name: string, fallback: number) {
  const value = Number(args[name]);
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function flag(args: Args, name: string, fallback: string) {
  const value = args[name];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

async function loadJudgeRegistry(args: Args): Promise<JudgeRegistryContext | null> {
  const configured = flag(args, "judge-service-file", "");
  if (!configured) return null;
  const absolutePath = path.resolve(configured);
  const raw = await readFile(absolutePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid judge registry JSON at ${absolutePath}: ${errorMessage(error)}`);
  }
  return {
    resolver: createJudgeCourtServiceResolver(parsed as JudgeCourtRegistryData),
    sha256: createHash("sha256").update(raw).digest("hex"),
    absolutePath,
  };
}

function roleMap(): Record<Role, Range[]> {
  return { majority: [], minority: [], concurring: [], unknown: [] };
}

function words(value: string): string[] {
  return value.toLocaleLowerCase().match(WORD_RE) ?? [];
}

function nameKey(value: string) {
  // `words()` splits dotted judicial suffixes (`J.A.`, `J.S.C.`, etc.) into
  // single letters. Ignore all initials/suffix components so the key remains the
  // judge's surname instead of collapsing an appellate panel to `a`.
  const ignored = new Set(["cj", "ja", "jj", "jca", "justice"]);
  const surnameFirst = value.includes(",") ? value.slice(0, value.indexOf(",")) : value;
  const tokens = words(surnameFirst).filter((token) => token.length > 1 && !ignored.has(token));
  return tokens.at(-1) ?? "";
}

function judgeIdentityKey(value: string) {
  const ignored = new Set([
    "a", "b", "c", "f", "j", "n", "o", "q", "s", "t", "acj", "cj", "ja", "jj", "jca",
    "chief", "honorable", "honourable", "judge", "justice", "madam", "madame", "mr", "mrs", "the",
  ]);
  const comma = value.indexOf(",");
  const normalized = (part: string) => words(part.normalize("NFKD").replace(/\p{M}/gu, ""))
    .filter((token) => token.length > 1 && !ignored.has(token));
  const tokens = comma >= 0
    ? [...normalized(value.slice(comma + 1)), ...normalized(value.slice(0, comma))]
    : normalized(value);
  return tokens.join(" ") || nameKey(value);
}

function uniqueJudgeMatch<T>(name: string, candidates: T[], displayedName: (candidate: T) => string): T | null {
  const exact = candidates.filter((candidate) => judgeIdentityKey(displayedName(candidate)) === judgeIdentityKey(name));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const surname = candidates.filter((candidate) => nameKey(displayedName(candidate)) === nameKey(name));
  return surname.length === 1 ? surname[0] : null;
}

function sourceNameMatches(header: string, name: string) {
  const key = nameKey(name);
  if (key.length < 2) return false;
  return words(header).includes(key);
}

function explicitNamedAuthorshipByline(quote: string, name: string) {
  if (!sourceNameMatches(quote, name)) return false;
  return /(?:^|[\r\n])\s*(?:(?:reasons?|opinion)\s+(?:for\s+(?:judg(?:e)?ment|decision)|of\s+the\s+court)(?:\s+of\s+the\s+court)?|delivered)\s+by\s*:/iu.test(quote);
}

function compressNumbers(numbers: number[]): Range[] {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const ranges: Range[] = [];
  for (const number of sorted) {
    const last = ranges.at(-1);
    if (last && number === last.to + 1) last.to = number;
    else ranges.push({ from: number, to: number });
  }
  return ranges;
}

function paragraphNumbers(paragraphs: SourceDocBlock[]) {
  return paragraphs.flatMap((block) => {
    const match = /^par(\d+)$/iu.exec(block.label);
    return match ? [Number(match[1])] : [];
  });
}

function numbersInRange(range: Range, available: number[]) {
  return available.filter((number) => number >= range.from && number <= range.to);
}

function rangeText(source: SourceDoc, paragraphs: SourceDocBlock[], range: Range) {
  const selected = paragraphs.filter((block) => {
    const match = /^par(\d+)$/iu.exec(block.label);
    const number = match ? Number(match[1]) : NaN;
    return Number.isFinite(number) && number >= range.from && number <= range.to;
  });
  return selected.length
    ? source.text.slice(selected[0].start, selected.at(-1)!.end).trim()
    : "";
}

function paragraphText(source: SourceDoc, block: SourceDocBlock) {
  return source.text.slice(block.start, block.end);
}

function extractPreflight(source: SourceDoc, paragraphs: SourceDocBlock[]): Preflight {
  const searches = PREFLIGHT_TERMS.map(({ term, re }) => {
    const paragraph_hits: string[] = [];
    const snippets: string[] = [];
    for (const block of paragraphs) {
      const text = paragraphText(source, block);
      const match = re.exec(text);
      if (!match) continue;
      paragraph_hits.push(block.label);
      const start = Math.max(0, match.index - 70);
      const end = Math.min(text.length, match.index + match[0].length + 110);
      snippets.push(`${block.label}: ${compact(text.slice(start, end))}`);
      if (snippets.length >= 8) break;
    }
    return { term, paragraph_hits, snippets };
  });
  return {
    searches,
    note: "Case-sensitive role assignment was not performed. These are paragraph-level term hits only; verify against exact source.",
  };
}

function semanticMvpCitationEdges(record: Omit<CaseRecord, "citationEdges" | "targetOccurrences">): CitationEdgeCandidate[] {
  const currentCitationKey = citationLookupKey(record.candidate.citation);
  const bodyStart = record.paragraphs[0]?.start ?? 0;
  const candidates = citationsInText(record.source.text).flatMap((match) => {
    const targetCitationKey = citationLookupKey(match.text);
    if (!targetCitationKey || targetCitationKey === currentCitationKey || match.start < bodyStart) return [];
    const contextStart = Math.max(bodyStart, match.start - 700);
    const contextEnd = Math.min(record.source.text.length, match.end + 700);
    const context = record.source.text.slice(contextStart, contextEnd);
    const excerptKind = classifyCitatorExcerpt(context).kind;
    return [{
      match,
      targetCitationKey,
      contextStart,
      contextEnd,
      context,
      contextSha256: sha256(context),
      excerptKind,
      order: sha256(`${record.sourceSha256}:${match.start}:${targetCitationKey}`),
    }];
  });
  const priority = { prose: 0, mixed: 1, insufficient: 2, authority_list: 3 } as const;
  return candidates
    .sort((left, right) => priority[left.excerptKind] - priority[right.excerptKind] || left.order.localeCompare(right.order))
    .slice(0, SEMANTIC_MVP_CITATION_EDGES)
    .sort((left, right) => left.match.start - right.match.start)
    .map((candidate, index) => ({
      id: `c${index + 1}`,
      citation: candidate.match.text,
      targetCitationKey: candidate.targetCitationKey,
      start: candidate.match.start,
      end: candidate.match.end,
      contextStart: candidate.contextStart,
      contextEnd: candidate.contextEnd,
      context: candidate.context,
      contextSha256: candidate.contextSha256,
      excerptKind: candidate.excerptKind,
      selectionRule: "prose_first_then_source_hashed_occurrence_v1",
    }));
}

function caseTargetOccurrences(source: SourceDoc, target: CaseTargetSpec | undefined): CaseTargetOccurrence[] {
  if (!target) return [];
  const bodyEnd = source.blocks.filter(({ kind }) => kind === "paragraph").at(-1)?.end ?? source.text.length;
  const targetKeys = new Set(
    [target.citation, ...target.citationAliases]
      .flatMap((citation) => citationAliasKeys(citation))
      .concat([target.citation, ...target.citationAliases].map(citationLookupKey))
      .filter(Boolean),
  );
  return citationsInText(source.text)
    .filter((match) => targetKeys.has(citationLookupKey(match.text)))
    .map((match, index) => ({
      id: `tm${index + 1}`,
      kind: "citation" as const,
      quote: match.text,
      start: match.start,
      end: match.end,
      citationKey: citationLookupKey(match.text),
      linkedContext: footnoteReferenceContext(source.text, match.start, bodyEnd),
    }));
}

function runnerRole(role: OpinionStructure["bindings"][number]["role"]): Role {
  return role === "separate" ? "unknown" : role;
}

function extractMechanicalHints(
  source: SourceDoc,
  paragraphs: SourceDocBlock[],
  structure: OpinionStructure,
): MechanicalHints {
  if (!paragraphs.length) {
    return { judgeCandidates: [], opinions: [], header: source.text.slice(0, 8_000), status: "unavailable" };
  }
  const firstParagraph = paragraphs[0].start;
  const header = source.text.slice(0, Math.min(firstParagraph, 12_000));
  const judgeCandidates: string[] = [];
  const candidateNames = [
    ...structure.panel,
    ...structure.bindings.flatMap((binding) => [...binding.names, ...binding.concurred]),
    ...structure.bodyMarkers.flatMap((marker) => (marker.name ? [marker.name] : [])),
  ];
  for (const name of candidateNames) {
    if (name && !judgeCandidates.some((item) => nameKey(item) === nameKey(name))) {
      judgeCandidates.push(name);
    }
  }
  const opinions: MechanicalOpinion[] = structure.bindings.map((binding) => ({
    role: runnerRole(binding.role),
    from: binding.from,
    to: binding.to,
    excerpt: binding.excerpt,
  }));
  return {
    judgeCandidates,
    opinions,
    header: header.slice(0, 8_000),
    status: structure.status,
  };
}

function mechanicalReference(record: DeterministicAuditRecord): MechanicalReference {
  const partition = partitionOpinionStructure(
    record.structure,
    paragraphNumbers(record.paragraphs),
  );
  const available = paragraphNumbers(record.paragraphs);
  const spans = roleMap();
  for (const [role, ranges] of Object.entries(partition.spans)) {
    const key = role === "separate" ? "unknown" : (role as Role);
    spans[key].push(...ranges);
  }
  for (const role of ROLE_KEYS) {
    spans[role] = compressNumbers(
      spans[role].flatMap((range) => numbersInRange(range, available)),
    );
  }
  return {
    source: "mechanical",
    status: partition.status,
    judges: partition.judges.map(({ name, role }) => ({ name, role: runnerRole(role) })),
    spans,
    note: partition.note,
  };
}

function deterministicPrediction(record: DeterministicAuditRecord): Prediction | null {
  if (record.deterministic.status !== "ready") return null;
  const prediction: Prediction = {
    disposition_quote: null,
    disposition_start: null,
    disposition_end_exclusive: null,
    opinions: record.deterministic.opinions.map((opinion) => ({
      id: opinion.id,
      author_names: opinion.authors,
      collective_author: null,
      result_position: resultPositionFromAlignment(opinion.alignment),
      position_evidence_quote: null,
      alignment: opinion.alignment,
      authority_position: "unknown",
      start_quote: opinion.startQuote,
      end_quote: opinion.endQuote,
      start: opinion.start,
      end_exclusive: opinion.end,
      text_sha256: sha256(record.source.text.slice(opinion.start, opinion.end)),
      substantive_words: opinion.substantiveWords,
      paragraphs: compressNumbers(record.paragraphs.flatMap((block) => {
        if (block.end <= opinion.start || block.start >= opinion.end) return [];
        const match = /^par(\d+)$/iu.exec(block.label);
        return match ? [Number(match[1])] : [];
      })),
    })),
    participants: record.deterministic.judges.map((judge) => ({
      name: judge.name,
      panel_evidence_quote: null,
      result_position: resultPositionFromSide(judge.resultSide),
      opinion_links: judge.relationship === "authors" || judge.relationship === "joins_reasons" || judge.relationship === "mixed"
        ? judge.opinionIds.map((opinionId) => ({
            opinion_id: opinionId,
            relation: judge.relationship === "authors" ? "authors" as const : judge.relationship === "joins_reasons" ? "joins" as const : "joins_in_part" as const,
            evidence_quote: null,
          }))
        : [],
      result_only: judge.relationship === "concurs_in_result_only",
      result_only_evidence_quote: null,
      result_side: judge.resultSide,
      relationship: judge.relationship,
      opinion_ids: judge.relationship === "concurs_in_result_only" ? [] : judge.opinionIds,
    })),
    nonparticipants: record.deterministic.nonparticipants.map((name) => ({ name, evidence_quote: null })),
  };
  return withDerivedAuthority(prediction);
}

function paragraphIndex(paragraphs: SourceDocBlock[]) {
  return compressNumbers(paragraphNumbers(paragraphs))
    .map(({ from, to }) => (from === to ? `par${from}` : `par${from}-par${to}`))
    .join(", ");
}

function packet(record: CaseRecord, includeBody = false, packetChars = 24_000) {
  const header = record.hints.header.slice(0, Math.max(1, packetChars));
  const hintLines = record.hints.opinions.map((opinion) => ({
    role: opinion.role,
    range: opinion.from !== null && opinion.to !== null ? [opinion.from, opinion.to] : null,
    source_excerpt: opinion.excerpt,
  }));
  const body = includeBody
    ? record.document.text.slice(0, Math.max(1, packetChars))
    : null;
  return [
    "[CASE]",
    json({
      document_id: record.candidate.documentId,
      dataset: record.candidate.dataset,
      citation: record.candidate.citation,
      name: record.candidate.name,
      date: record.candidate.date,
      source_sha256: record.sourceSha256,
    }),
    "[SOURCE PARAGRAPH INDEX]",
    paragraphIndex(record.paragraphs),
    "[SOURCE HEADER]",
    header,
    "[DETERMINISTIC SEARCH PREFLIGHT — HINTS ONLY]",
    json(record.preflight),
    "[DETERMINISTIC HEADER OBSERVATIONS — VERIFY AGAINST SOURCE]",
    json({
      judge_candidates: record.hints.judgeCandidates,
      opinion_headers: hintLines,
      body_markers: record.structure.bodyMarkers.slice(0, 60).map((marker) => ({
        paragraph: marker.paragraph,
        kind: marker.kind,
        name: marker.name,
        role: marker.role === "separate" ? "unknown" : marker.role,
        line: marker.line,
      })),
    }),
    ...(body ? ["[SOURCE TEXT PREFIX]", body] : []),
    "[TASK]",
    "Identify substantive opinion bodies and judge voting relationships. Read exact paragraphs with a2aj_lookup when available before submitting.",
  ].join("\n\n");
}

function codexPacket(record: CaseRecord) {
  return [
    CODEX_SYSTEM_PROMPT,
    "[CASE]",
    json({
      document_id: record.candidate.documentId,
      dataset: record.candidate.dataset,
      citation: record.candidate.citation,
      name: record.candidate.name,
      date: record.candidate.date,
      source_sha256: record.sourceSha256,
    }),
    "[SOURCE STRUCTURE]",
    json({
      paragraph_index: paragraphIndex(record.paragraphs) || null,
      paragraph_structure_available: record.paragraphs.length > 0,
    }),
    "[DETERMINISTIC TERM-SEARCH PREFLIGHT — HINTS ONLY]",
    json(record.preflight),
    "[SOURCE TEXT]",
    record.source.text,
  ].join("\n\n");
}

function semanticMvpPacket(record: CaseRecord) {
  return [
    CODEX_SYSTEM_PROMPT,
    SEMANTIC_MVP_INSTRUCTIONS,
    "[CASE]",
    json({
      document_id: record.candidate.documentId,
      dataset: record.candidate.dataset,
      citation: record.candidate.citation,
      name: record.candidate.name,
      date: record.candidate.date,
      source_sha256: record.sourceSha256,
    }),
    "[SOURCE STRUCTURE]",
    json({
      paragraph_index: paragraphIndex(record.paragraphs) || null,
      paragraph_structure_available: record.paragraphs.length > 0,
    }),
    "[DETERMINISTIC TERM-SEARCH PREFLIGHT — NAVIGATION HINTS ONLY]",
    json(record.preflight),
    "[CITATION-EDGE SAMPLE]",
    json(record.citationEdges.map((edge) => ({
      citation_edge_id: edge.id,
      citation: edge.citation,
      context: edge.context,
    }))),
    "[SOURCE TEXT]",
    record.source.text,
  ].join("\n\n");
}

export function caseTargetMvpPacket(record: CaseRecord, variant: CaseTargetPromptVariant) {
  if (!record.candidate.target) throw new Error("case-target MVP requires target metadata");
  return [
    CASE_TARGET_MVP_SYSTEM_PROMPT,
    CASE_TARGET_MVP_PROMPTS[variant].instructions,
    "[CITING CASE]",
    json({
      document_id: record.candidate.documentId,
      dataset: record.candidate.dataset,
      citation: record.candidate.citation,
      name: record.candidate.name,
      date: record.candidate.date,
      source_sha256: record.sourceSha256,
    }),
    "[TARGET CASE IDENTITY — IDENTITY ONLY, NOT TARGET DECISION TEXT]",
    json({
      document_id: record.candidate.target.documentId,
      citation: record.candidate.target.citation,
      citation_aliases: record.candidate.target.citationAliases,
      name: record.candidate.target.name,
      same_litigation_eligible: record.candidate.target.sameLitigationEligible,
    }),
    "[DETERMINISTIC TARGET CITATION OCCURRENCES — ACCOUNT FOR EACH ID]",
    json(record.targetOccurrences.map((occurrence) => ({
      occurrence_id: occurrence.id,
      quote: occurrence.quote,
      start: occurrence.start,
      end_exclusive: occurrence.end,
      citation_key: occurrence.citationKey,
      linked_context: occurrence.linkedContext === null ? null : {
        kind: occurrence.linkedContext.kind,
        quote: occurrence.linkedContext.quote,
        start: occurrence.linkedContext.start,
        end_exclusive: occurrence.linkedContext.end,
      },
    }))),
    "[SOURCE STRUCTURE]",
    json({
      paragraph_index: paragraphIndex(record.paragraphs) || null,
      paragraph_structure_available: record.paragraphs.length > 0,
    }),
    "[DETERMINISTIC TERM-SEARCH PREFLIGHT — NAVIGATION HINTS ONLY]",
    json(record.preflight),
    "[COMPLETE CITING DECISION TEXT]",
    record.source.text,
  ].join("\n\n");
}

function exactQuoteSpans(text: string, quote: string, limit = 3) {
  const spans: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  while (spans.length < limit) {
    const start = text.indexOf(quote, cursor);
    if (start < 0) break;
    spans.push({ start, end: start + quote.length });
    cursor = start + Math.max(1, quote.length);
  }
  return spans;
}

function groundedQuoteSpans(text: string, quote: string, limit = 3) {
  const exact = exactQuoteSpans(text, quote, limit);
  if (exact.length) return exact;
  const wanted = sourceDocQuoteWords(quote);
  if (wanted.length < 4) return [];
  const source = tokenizeSourceText(text);
  const spans: Array<{ start: number; end: number }> = [];
  for (let index = 0; index + wanted.length <= source.length && spans.length < limit; index += 1) {
    if (source[index].word !== wanted[0]) continue;
    let matches = true;
    for (let offset = 1; offset < wanted.length; offset += 1) {
      if (source[index + offset].word === wanted[offset]) continue;
      matches = false;
      break;
    }
    if (!matches) continue;
    let start = source[index].start;
    let end = source[index + wanted.length - 1].end;
    if (/^\s*\[\s*\d+\s*\]/u.test(quote)) {
      const bracket = text.lastIndexOf("[", start);
      const close = text.indexOf("]", start);
      if (bracket >= Math.max(0, start - 12) && close >= source[index].end && close - start <= 12) {
        start = bracket;
      }
    }
    if (/[.!?…]["'”’\])}]*\s*$/u.test(quote)) {
      while (end < text.length && /[.!?…"'”’\])}]/u.test(text[end])) end += 1;
    }
    spans.push({ start, end });
  }
  return spans;
}

function preferredGroundedSpans(
  text: string,
  firstParagraphStart: number | null,
  spans: Array<{ start: number; end: number }>,
  edge: "start" | "end",
  opinionCount: number,
) {
  if (spans.length <= 1) return spans;
  const marker = text.toLocaleLowerCase().lastIndexOf("decision content");
  const inBody = marker >= 0 ? spans.filter((span) => span.start > marker) : spans;
  const candidates = inBody.length ? inBody : spans;
  if (candidates.length <= 1 || opinionCount !== 1) return candidates;
  if (edge === "end") return [candidates.at(-1)!];
  if (firstParagraphStart !== null) {
    const beforeFirstParagraph = candidates.filter((span) => span.start <= firstParagraphStart);
    if (beforeFirstParagraph.length) return [beforeFirstParagraph.at(-1)!];
  }
  return [candidates[0]];
}

function expandedBoundaryQuote(
  text: string,
  span: { start: number; end: number },
  edge: "start" | "end",
  targetWords = 12,
) {
  if (edge === "start") {
    const suffix = text.slice(span.start);
    const matches = [...suffix.matchAll(WORD_RE)];
    const last = matches[Math.min(targetWords, matches.length) - 1];
    return last ? suffix.slice(0, last.index! + last[0].length).trimEnd() : text.slice(span.start, span.end);
  }
  const prefix = text.slice(0, span.end);
  const matches = [...prefix.matchAll(WORD_RE)];
  const first = matches[Math.max(0, matches.length - targetWords)];
  return first ? prefix.slice(first.index!).trimStart() : text.slice(span.start, span.end);
}

function resultPositionFromAlignment(alignment: OpinionAlignment): ResultPosition {
  if (alignment === "lead" || alignment === "same_result_separate_reasons") return "supports_disposition";
  if (alignment === "different_result") return "opposes_disposition";
  return alignment === "mixed" ? "mixed" : "unclear";
}

function resultPositionFromSide(side: JudgeResultSide): ResultPosition {
  if (side === "majority") return "supports_disposition";
  if (side === "minority") return "opposes_disposition";
  return side === "mixed" ? "mixed" : "unclear";
}

function resultSideFromPosition(position: ResultPosition): JudgeResultSide {
  if (position === "supports_disposition") return "majority";
  if (position === "opposes_disposition") return "minority";
  return position === "mixed" ? "mixed" : "unknown";
}

function withDerivedAuthority(prediction: Prediction): Prediction {
  const participantCount = prediction.participants.length;
  const fullSupporters = new Map(prediction.opinions.map((opinion) => [
    opinion.id,
    prediction.participants.filter((participant) => participant.opinion_links.some(
      (link) => link.opinion_id === opinion.id && link.relation !== "joins_in_part",
    )).length,
  ]));
  const supporting = prediction.opinions.filter((opinion) => opinion.result_position === "supports_disposition");
  const largestSupport = Math.max(0, ...supporting.map((opinion) => fullSupporters.get(opinion.id) ?? 0));
  const largestCount = supporting.filter((opinion) => (fullSupporters.get(opinion.id) ?? 0) === largestSupport).length;

  for (const opinion of prediction.opinions) {
    const supporters = fullSupporters.get(opinion.id) ?? 0;
    opinion.authority_position = opinion.result_position === "opposes_disposition"
      ? "dissenting"
      : opinion.result_position !== "supports_disposition"
        ? "unknown"
        : participantCount === 0 && prediction.opinions.length === 1 && Boolean(opinion.collective_author)
          ? "unanimous"
          : participantCount > 0 && supporters === participantCount
            ? "unanimous"
            : participantCount > 0 && supporters > participantCount / 2
              ? "majority"
              : supporters > 0 && supporters === largestSupport && largestCount === 1
                ? "plurality"
                : "concurring";
  }

  const lead = [...prediction.opinions]
    .filter((opinion) => ["unanimous", "majority", "plurality"].includes(opinion.authority_position))
    .sort((left, right) => (fullSupporters.get(right.id) ?? 0) - (fullSupporters.get(left.id) ?? 0) || left.start - right.start)[0];
  for (const opinion of prediction.opinions) {
    opinion.alignment = opinion.result_position === "opposes_disposition"
      ? "different_result"
      : opinion.result_position === "mixed"
        ? "mixed"
        : opinion.result_position === "unclear"
          ? "unknown"
          : opinion.id === lead?.id
            ? "lead"
            : "same_result_separate_reasons";
  }
  return prediction;
}

function normalizeSubmission(value: Record<string, unknown>, allowLegacy: boolean) {
  if (Array.isArray(value.participants)) return { value, legacy: false };
  if (!allowLegacy || !Array.isArray(value.judges)) return { value, legacy: false };
  const opinions = Array.isArray(value.opinions) ? value.opinions : [];
  return {
    legacy: true,
    value: {
      disposition_quote: null,
      opinions: opinions.map((item) => {
        const row = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
        const alignment = OPINION_ALIGNMENTS.includes(row.alignment as OpinionAlignment)
          ? row.alignment as OpinionAlignment
          : "unknown";
        return {
          id: row.id,
          author_names: row.authors,
          collective_author: null,
          result_position: resultPositionFromAlignment(alignment),
          position_evidence_quote: null,
          start_quote: row.start_quote,
          end_quote: row.end_quote,
        };
      }),
      participants: value.judges.map((item) => {
        const row = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
        const side = RESULT_SIDES.includes(row.result_side as JudgeResultSide)
          ? row.result_side as JudgeResultSide
          : "unknown";
        const relationship = RELATIONSHIPS.includes(row.relationship as JudgeOpinionRelationship)
          ? row.relationship as JudgeOpinionRelationship
          : "unknown";
        const relation: OpinionLinkRelation | null = relationship === "authors"
          ? "authors"
          : relationship === "joins_reasons"
            ? "joins"
            : relationship === "mixed"
              ? "joins_in_part"
              : null;
        return {
          name: row.name,
          panel_evidence_quote: null,
          result_position: resultPositionFromSide(side),
          opinion_links: relation && Array.isArray(row.opinion_ids)
            ? row.opinion_ids.map((opinionId) => ({ opinion_id: opinionId, relation, evidence_quote: null }))
            : [],
          result_only: relationship === "concurs_in_result_only",
          result_only_evidence_quote: null,
        };
      }),
      nonparticipants: [],
    } as Record<string, unknown>,
  };
}

export function validatePrediction(record: CaseRecord, raw: unknown, allowLegacy = false): { prediction: Prediction | null; validation: Validation } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { prediction: null, validation: { ok: false, error: "extraction must be an object", next: "Submit opinions, participants, and nonparticipants." } };
  }
  const normalized = normalizeSubmission(raw as Record<string, unknown>, allowLegacy);
  const value = normalized.value;
  const errors: string[] = [];
  const warnings: string[] = [];
  const candidates = [
    ...record.deterministic.panel,
    ...record.deterministic.judges.map((judge) => judge.name),
    ...record.hints.judgeCandidates,
  ];
  const canonicalName = (name: string) =>
    uniqueJudgeMatch(name, candidates, (candidate) => candidate) ?? name;
  const canonicalEvidence = (rawQuote: unknown, label: string, required: boolean, preferHeader = false) => {
    if (rawQuote === null || rawQuote === undefined || rawQuote === "") {
      if (required && !normalized.legacy) errors.push(`${label} must be an exact source quote`);
      return { quote: null, start: null, end: null };
    }
    if (typeof rawQuote !== "string") {
      errors.push(`${label} must be a string or null`);
      return { quote: null, start: null, end: null };
    }
    let spans = groundedQuoteSpans(record.source.text, rawQuote.trim(), 3);
    if (preferHeader && spans.length > 1) {
      const headerEnd = record.paragraphs[0]?.start ?? record.hints.header.length;
      const headerSpans = spans.filter(({ end }) => end <= headerEnd);
      if (headerSpans.length >= 1) spans = [headerSpans[0]];
    }
    if (spans.length !== 1) {
      errors.push(`${label} resolves ${spans.length} times; provide a unique exact quote`);
      return { quote: null, start: null, end: null };
    }
    return {
      quote: record.source.text.slice(spans[0].start, spans[0].end),
      start: spans[0].start,
      end: spans[0].end,
    };
  };
  const paragraphsFor = (start: number, end: number) => compressNumbers(
    record.paragraphs.flatMap((block) => {
      if (block.end <= start || block.start >= end) return [];
      const match = /^par(\d+)$/iu.exec(block.label);
      return match ? [Number(match[1])] : [];
    }),
  );
  const rawOpinions = Array.isArray(value.opinions) ? value.opinions : [];
  if (!rawOpinions.length) errors.push("opinions must contain each substantive opinion body");
  const opinions: Prediction["opinions"] = [];
  const opinionIds = new Set<string>();
  for (const item of rawOpinions) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push("each opinion must be an object");
      continue;
    }
    const row = item as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    const resultPosition = RESULT_POSITIONS.includes(row.result_position as ResultPosition)
      ? row.result_position as ResultPosition
      : null;
    const startQuote = typeof row.start_quote === "string" ? row.start_quote.trim() : "";
    const endQuote = typeof row.end_quote === "string" ? row.end_quote.trim() : "";
    const authors = Array.isArray(row.author_names)
      ? row.author_names.flatMap((author) => typeof author === "string" && author.trim() ? [canonicalName(author.trim())] : [])
      : [];
    const collectiveAuthor = typeof row.collective_author === "string" && row.collective_author.trim()
      ? row.collective_author.trim()
      : null;
    if (!/^o[1-9]\d*$/u.test(id) || opinionIds.has(id)) errors.push(`duplicate or invalid opinion id: ${id || "(empty)"}`);
    else opinionIds.add(id);
    if (!resultPosition) errors.push(`${id || "opinion"} has an invalid result_position`);
    if (authors.length && collectiveAuthor) errors.push(`${id || "opinion"} cannot have both named authors and a collective author`);
    for (const author of authors) {
      if (!sourceNameMatches(record.source.text, author)) errors.push(`${id || "opinion"} author not found in source: ${author}`);
    }
    if (collectiveAuthor && !compact(record.source.text).toLocaleLowerCase().includes(compact(collectiveAuthor).toLocaleLowerCase())) {
      errors.push(`${id || "opinion"} collective author not found in source: ${collectiveAuthor}`);
    }
    const positionEvidence = canonicalEvidence(row.position_evidence_quote, `${id || "opinion"} position_evidence_quote`, false).quote;
    const startWords = sourceDocQuoteWords(startQuote);
    const endWords = sourceDocQuoteWords(endQuote);
    if (!startWords.length || !endWords.length) {
      errors.push(`${id || "opinion"} boundary quotes must contain source words`);
      continue;
    }
    const firstParagraphStart = record.paragraphs[0]?.start ?? null;
    const starts = preferredGroundedSpans(
      record.source.text,
      firstParagraphStart,
      groundedQuoteSpans(record.source.text, startQuote, 10),
      "start",
      rawOpinions.length,
    );
    const ends = preferredGroundedSpans(
      record.source.text,
      firstParagraphStart,
      groundedQuoteSpans(record.source.text, endQuote, 10),
      "end",
      rawOpinions.length,
    );
    if (starts.length !== 1) errors.push(`${id || "opinion"} start_quote resolves ${starts.length} times; provide a unique exact quote`);
    if (ends.length !== 1) errors.push(`${id || "opinion"} end_quote resolves ${ends.length} times; provide a unique exact quote`);
    if (starts.length !== 1 || ends.length !== 1) continue;
    const start = starts[0].start;
    const end = ends[0].end;
    if (end <= start) {
      errors.push(`${id || "opinion"} end_quote precedes its start_quote`);
      continue;
    }
    const body = record.source.text.slice(start, end);
    const substantiveWords = words(body).length;
    if (substantiveWords < MIN_OPINION_WORDS) {
      errors.push(`${id || "opinion"} has only ${substantiveWords} substantive words; a signature, joinder, or disposition line is not an opinion`);
      continue;
    }
    opinions.push({
      id,
      author_names: [...new Map(authors.map((author) => [judgeIdentityKey(author), author])).values()],
      collective_author: collectiveAuthor,
      result_position: resultPosition ?? "unclear",
      position_evidence_quote: positionEvidence,
      alignment: resultPosition === "opposes_disposition"
        ? "different_result"
        : resultPosition === "mixed"
          ? "mixed"
          : resultPosition === "unclear"
            ? "unknown"
            : "same_result_separate_reasons",
      authority_position: "unknown",
      start_quote: startWords.length < 4
        ? expandedBoundaryQuote(record.source.text, starts[0], "start")
        : record.source.text.slice(starts[0].start, starts[0].end),
      end_quote: endWords.length < 4
        ? expandedBoundaryQuote(record.source.text, ends[0], "end")
        : record.source.text.slice(ends[0].start, ends[0].end),
      start,
      end_exclusive: end,
      text_sha256: sha256(body),
      substantive_words: substantiveWords,
      paragraphs: paragraphsFor(start, end),
    });
  }
  const ordered = [...opinions].sort((left, right) => left.start - right.start);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].start < ordered[index - 1].end_exclusive) {
      errors.push(`opinion boundaries overlap: ${ordered[index - 1].id} and ${ordered[index].id}`);
    }
  }

  const rawParticipants = Array.isArray(value.participants) ? value.participants : [];
  if (!rawParticipants.length && opinions.some((opinion) => opinion.author_names.length)) {
    errors.push("participants must list every named judicial author and deciding panel member");
  }
  const participants: Prediction["participants"] = [];
  const seenJudges = new Set<string>();
  for (const item of rawParticipants) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push("each participant must be an object");
      continue;
    }
    const row = item as Record<string, unknown>;
    const submittedName = typeof row.name === "string" ? row.name.trim() : "";
    const name = canonicalName(submittedName);
    const key = judgeIdentityKey(name);
    const resultPosition = RESULT_POSITIONS.includes(row.result_position as ResultPosition)
      ? row.result_position as ResultPosition
      : null;
    const panelEvidence = canonicalEvidence(row.panel_evidence_quote, `${submittedName || "participant"} panel_evidence_quote`, true, true).quote;
    const rawLinks = Array.isArray(row.opinion_links) ? row.opinion_links : [];
    const links: Prediction["participants"][number]["opinion_links"] = [];
    const linkKeys = new Set<string>();
    const linkedOpinionIds = new Set<string>();
    for (const rawLink of rawLinks) {
      if (!rawLink || typeof rawLink !== "object" || Array.isArray(rawLink)) {
        errors.push(`${submittedName || "participant"} opinion link must be an object`);
        continue;
      }
      const link = rawLink as Record<string, unknown>;
      const opinionId = typeof link.opinion_id === "string" ? link.opinion_id.trim() : "";
      const relation = OPINION_LINK_RELATIONS.includes(link.relation as OpinionLinkRelation)
        ? link.relation as OpinionLinkRelation
        : null;
      const evidenceQuote = canonicalEvidence(link.evidence_quote, `${submittedName || "participant"} ${opinionId || "opinion"} link evidence_quote`, true).quote;
      const linkKey = `${opinionId}|${relation}`;
      if (!opinionIds.has(opinionId)) errors.push(`${submittedName || "participant"} refers to missing opinion ${opinionId || "(empty)"}`);
      if (!relation) errors.push(`${submittedName || "participant"} has an invalid opinion link relation`);
      if (evidenceQuote && !sourceNameMatches(evidenceQuote, submittedName)) {
        errors.push(`${submittedName || "participant"} ${opinionId || "opinion"} link evidence_quote does not identify that judge`);
      }
      if (linkKeys.has(linkKey)) errors.push(`${submittedName || "participant"} repeats ${linkKey}`);
      else linkKeys.add(linkKey);
      if (linkedOpinionIds.has(opinionId)) errors.push(`${submittedName || "participant"} has more than one relationship to ${opinionId || "(empty)"}`);
      else linkedOpinionIds.add(opinionId);
      links.push({ opinion_id: opinionId, relation: relation ?? "joins_in_part", evidence_quote: evidenceQuote });
    }
    let resultOnly = row.result_only === true;
    const resultOnlyResolution = canonicalEvidence(
      row.result_only_evidence_quote,
      `${submittedName || "participant"} result_only_evidence_quote`,
      resultOnly,
    );
    let resultOnlyEvidence = resultOnlyResolution.quote;
    if (
      resultOnly && resultOnlyEvidence &&
      /\b(?:agree|concur)\b/iu.test(resultOnlyEvidence) &&
      !/\b(?:agree|concur)\b[^.!?]{0,100}\b(?:result|outcome|disposition|conclusion|order)\b/iu.test(resultOnlyEvidence)
    ) {
      const preceding = resultOnlyResolution.start === null
        ? []
        : [...opinions]
            .filter((opinion) => (
              opinion.end_exclusive <= resultOnlyResolution.start! &&
              resultOnlyResolution.start! - opinion.end_exclusive <= 2_000
            ) || (
              resultOnlyResolution.start! >= opinion.start &&
              resultOnlyResolution.start! < opinion.end_exclusive &&
              opinion.end_exclusive - resultOnlyResolution.start! <= 2_000
            ))
            .sort((left, right) => right.end_exclusive - left.end_exclusive);
      if (!links.length && preceding.length && (preceding.length === 1 || preceding[0].end_exclusive > preceding[1].end_exclusive)) {
        links.push({ opinion_id: preceding[0].id, relation: "joins", evidence_quote: resultOnlyEvidence });
        resultOnly = false;
        resultOnlyEvidence = null;
      } else {
        errors.push(`${submittedName || "participant"} bare agreement has no unique preceding opinion to join`);
      }
    }
    if (!key || seenJudges.has(key)) errors.push(`duplicate or empty judge: ${submittedName || "(empty)"}`);
    else seenJudges.add(key);
    if (!sourceNameMatches(record.source.text, submittedName)) errors.push(`judge name not found in source: ${submittedName}`);
    if (panelEvidence && !sourceNameMatches(panelEvidence, submittedName)) errors.push(`${submittedName || "participant"} panel_evidence_quote does not identify that judge`);
    if (resultOnlyEvidence && !sourceNameMatches(resultOnlyEvidence, submittedName)) errors.push(`${submittedName || "participant"} result_only_evidence_quote does not identify that judge`);
    if (!resultPosition) errors.push(`${submittedName || "participant"} has an invalid result_position`);
    if (resultOnly && links.length) errors.push(`${submittedName || "participant"} cannot be result-only and also author or join an opinion`);
    const directLinks = links.filter((link) => link.relation !== "joins_in_part");
    const expected = new Set(directLinks.flatMap((link) => {
      const opinion = opinions.find((candidate) => candidate.id === link.opinion_id);
      return opinion && opinion.result_position !== "unclear" ? [opinion.result_position] : [];
    }));
    const derivedPosition: ResultPosition = expected.size === 1
      ? [...expected][0]
      : expected.size > 1
        ? "mixed"
        : resultPosition ?? "unclear";
    if (resultPosition && resultPosition !== "unclear" && derivedPosition !== "unclear" && resultPosition !== derivedPosition) {
      errors.push(`${submittedName || "participant"} result_position=${resultPosition} conflicts with the linked opinion`);
    }
    const finalPosition = resultPosition === "unclear" && derivedPosition !== "unclear" ? derivedPosition : resultPosition ?? "unclear";
    const relationship: JudgeOpinionRelationship = resultOnly
      ? "concurs_in_result_only"
      : links.some((link) => link.relation === "authors")
        ? "authors"
        : links.some((link) => link.relation === "joins_in_part")
          ? "mixed"
          : links.length
            ? "joins_reasons"
            : "unknown";
    participants.push({
      name,
      panel_evidence_quote: panelEvidence,
      result_position: finalPosition,
      opinion_links: links,
      result_only: resultOnly,
      result_only_evidence_quote: resultOnlyEvidence,
      result_side: resultSideFromPosition(finalPosition),
      relationship,
      opinion_ids: [...new Set(links.map((link) => link.opinion_id))],
    });
  }
  for (const opinion of opinions) {
    if (opinion.author_names.length || !opinion.collective_author) continue;
    const linkedAuthors = participants.flatMap((participant) => participant.opinion_links
      .filter((link) => link.opinion_id === opinion.id && link.relation === "authors")
      .map((link) => ({ participant, evidence: link.evidence_quote })));
    if (
      !linkedAuthors.length ||
      linkedAuthors.some(({ participant, evidence }) => !evidence || !explicitNamedAuthorshipByline(evidence, participant.name))
    ) continue;
    opinion.author_names = [...new Map(linkedAuthors.map(({ participant }) => [
      judgeIdentityKey(participant.name),
      participant.name,
    ])).values()];
    opinion.collective_author = null;
    warnings.push(`${opinion.id} collective label normalized to an explicit named byline`);
  }
  for (const opinion of opinions) {
    for (const author of opinion.author_names) {
      const judge = uniqueJudgeMatch(author, participants, (candidate) => candidate.name);
      const link = judge?.opinion_links.find((candidate) => candidate.opinion_id === opinion.id && candidate.relation === "authors");
      if (!judge || !link) {
        errors.push(`${opinion.id} author ${author} must have an authors voting record referencing that opinion`);
      } else if (participants.length > 1 && link.evidence_quote) {
        const spans = groundedQuoteSpans(record.source.text, link.evidence_quote, 2);
        const nearOpening = spans.length === 1 && spans[0].end >= Math.max(0, opinion.start - 1_500) && spans[0].start <= opinion.start + 1_500;
        if (!nearOpening && !explicitNamedAuthorshipByline(link.evidence_quote, judge.name)) {
          errors.push(`${opinion.id} author ${author} is supported only outside the opinion opening/byline`);
        }
      }
    }
  }
  for (const judge of participants) {
    for (const link of judge.opinion_links.filter((candidate) => candidate.relation === "authors")) {
      const opinion = opinions.find((candidate) => candidate.id === link.opinion_id);
      if (opinion && uniqueJudgeMatch(judge.name, opinion.author_names, (author) => author) === null) {
        errors.push(`${judge.name} is linked as author of ${link.opinion_id} but is not named as its author`);
      }
    }
    for (const link of judge.opinion_links.filter((candidate) => candidate.relation === "joins")) {
      const opinion = opinions.find((candidate) => candidate.id === link.opinion_id);
      if (opinion && !opinion.collective_author && link.evidence_quote && !/\b(?:agree|concur|join|adopt)\w*\b/iu.test(link.evidence_quote)) {
        errors.push(`${judge.name} whole-opinion joinder evidence does not state agreement or joinder`);
      }
    }
  }
  for (const panelMember of record.deterministic.panel) {
    if (uniqueJudgeMatch(panelMember, participants, (judge) => judge.name) === null) {
      warnings.push(`deterministic panel candidate missing from participants: ${panelMember}`);
    }
  }

  const rawNonparticipants = Array.isArray(value.nonparticipants) ? value.nonparticipants : [];
  const nonparticipants: Prediction["nonparticipants"] = [];
  const seenNonparticipants = new Set<string>();
  for (const item of rawNonparticipants) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push("each nonparticipant must be an object");
      continue;
    }
    const row = item as Record<string, unknown>;
    const submittedName = typeof row.name === "string" ? row.name.trim() : "";
    const name = canonicalName(submittedName);
    const key = judgeIdentityKey(name);
    const evidenceQuote = canonicalEvidence(row.evidence_quote, `${submittedName || "nonparticipant"} evidence_quote`, true).quote;
    if (!key || seenNonparticipants.has(key)) errors.push(`duplicate or empty nonparticipant: ${submittedName || "(empty)"}`);
    else seenNonparticipants.add(key);
    if (!sourceNameMatches(record.source.text, submittedName)) errors.push(`nonparticipant name not found in source: ${submittedName}`);
    if (evidenceQuote && !sourceNameMatches(evidenceQuote, submittedName)) errors.push(`${submittedName || "nonparticipant"} evidence_quote does not identify that judge`);
    if (uniqueJudgeMatch(name, participants, (participant) => participant.name)) errors.push(`${submittedName} cannot be both participant and nonparticipant`);
    nonparticipants.push({ name, evidence_quote: evidenceQuote });
  }

  const disposition = canonicalEvidence(value.disposition_quote, "disposition_quote", false);
  if (errors.length) {
    return {
      prediction: null,
      validation: {
        ok: false,
        error: "opinion_extraction_invalid",
        errors,
        ...(warnings.length ? { warnings } : {}),
        next: "Correct only the named errors and resubmit exact source-grounded opinions, participants, and voting relationships.",
      },
    };
  }
  return {
    prediction: withDerivedAuthority({
      disposition_quote: disposition.quote,
      disposition_start: disposition.start,
      disposition_end_exclusive: disposition.end,
      opinions: ordered,
      participants,
      nonparticipants,
    }),
    validation: { ok: true, ...(warnings.length ? { warnings } : {}) },
  };
}

function objectRows(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

/** Put model opinion objects in source order before assigning internal IDs. */
function sourceOrderedReducedOpinions(record: CaseRecord, raw: Record<string, unknown>) {
  const submitted = objectRows(raw.opinions);
  const anchored = submitted.map((opinion, submittedIndex) => {
    const quote = typeof opinion.start_quote === "string" ? opinion.start_quote.trim() : "";
    const spans = quote ? groundedQuoteSpans(record.source.text, quote, 2) : [];
    return { opinion, submittedIndex, start: spans.length === 1 ? spans[0].start : null };
  });
  return anchored.every(({ start }) => start !== null)
    ? anchored.sort((left, right) => left.start! - right.start! || left.submittedIndex - right.submittedIndex).map(({ opinion }) => opinion)
    : submitted;
}

/** Project the nested, ID-free v13 roster into the existing grounded roster validator. */
function reducedRosterSubmission(record: CaseRecord, raw: Record<string, unknown>) {
  const submittedOpinions = sourceOrderedReducedOpinions(record, raw);
  const opinions = submittedOpinions.map((opinion, index) => ({
    id: `o${index + 1}`,
    author_names: objectRows(opinion.named_authors).flatMap((author) =>
      typeof author.name === "string" && author.name.trim() ? [author.name.trim()] : []
    ),
    collective_author: opinion.collective_author ?? null,
    result_position: opinion.result_position,
    position_evidence_quote: opinion.position_evidence_quote ?? null,
    start_quote: opinion.start_quote,
    end_quote: opinion.end_quote,
  }));
  const participants = objectRows(raw.participants).map((participant) => {
    const name = typeof participant.name === "string" ? participant.name.trim() : "";
    const links: Array<{ opinion_id: string; relation: OpinionLinkRelation; evidence_quote: unknown }> = [];
    submittedOpinions.forEach((opinion, index) => {
      const opinionId = `o${index + 1}`;
      const author = uniqueJudgeMatch(name, objectRows(opinion.named_authors), (item) => String(item.name ?? ""));
      if (author) links.push({ opinion_id: opinionId, relation: "authors", evidence_quote: author.evidence_quote });
      const joiner = uniqueJudgeMatch(name, objectRows(opinion.whole_opinion_joiners), (item) => String(item.name ?? ""));
      if (joiner) links.push({ opinion_id: opinionId, relation: "joins", evidence_quote: joiner.evidence_quote });
    });
    return {
      name,
      panel_evidence_quote: participant.panel_evidence_quote,
      result_position: participant.result_position,
      opinion_links: links,
      result_only: participant.result_only,
      result_only_evidence_quote: participant.result_only_evidence_quote ?? null,
    };
  });
  return {
    disposition_quote: raw.disposition_quote ?? null,
    opinions,
    participants,
    nonparticipants: objectRows(raw.nonparticipants),
  };
}

function reducedRosterContractErrors(record: CaseRecord, raw: Record<string, unknown>) {
  const errors: string[] = [];
  sourceOrderedReducedOpinions(record, raw).forEach((opinion, index) => {
    const label = `opinions[${index}]`;
    const collective = typeof opinion.collective_author === "string" ? opinion.collective_author.trim() : "";
    const evidence = typeof opinion.collective_author_evidence_quote === "string"
      ? opinion.collective_author_evidence_quote.trim()
      : "";
    if (collective) {
      const spans = evidence ? groundedQuoteSpans(record.source.text, evidence, 2) : [];
      if (spans.length !== 1) errors.push(`${label}.collective_author_evidence_quote must be one unique exact source quote`);
      if (evidence && !compact(evidence).toLocaleLowerCase().includes(compact(collective).toLocaleLowerCase())) {
        errors.push(`${label}.collective_author_evidence_quote does not identify ${collective}`);
      }
    } else if (opinion.collective_author_evidence_quote !== null) {
      errors.push(`${label}.collective_author_evidence_quote must be null without a collective author`);
    }
    const authors = new Set(objectRows(opinion.named_authors).map((item) => judgeIdentityKey(String(item.name ?? ""))).filter(Boolean));
    for (const joiner of objectRows(opinion.whole_opinion_joiners)) {
      if (authors.has(judgeIdentityKey(String(joiner.name ?? "")))) {
        errors.push(`${label} lists ${String(joiner.name ?? "(empty)")} as both author and joiner`);
      }
    }
  });
  return errors;
}

function addCompiledPartialLinks(
  prediction: Prediction,
  partialJoins: readonly { participant_name: string; opinion_id: string; evidence_quotes: string[] }[],
) {
  const participants = prediction.participants.map((participant) => {
    const joins = partialJoins.filter((join) =>
      uniqueJudgeMatch(join.participant_name, [participant], (candidate) => candidate.name) !== null
    );
    const opinionLinks = [...participant.opinion_links];
    for (const join of joins) {
      if (!opinionLinks.some((link) => link.opinion_id === join.opinion_id)) {
        opinionLinks.push({
          opinion_id: join.opinion_id,
          relation: "joins_in_part",
          evidence_quote: join.evidence_quotes[0] ?? null,
        });
      }
    }
    const relationship: JudgeOpinionRelationship = participant.result_only
      ? "concurs_in_result_only"
      : opinionLinks.some(({ relation }) => relation === "authors")
        ? "authors"
        : opinionLinks.some(({ relation }) => relation === "joins_in_part")
          ? "mixed"
          : opinionLinks.length
            ? "joins_reasons"
            : "unknown";
    return {
      ...participant,
      opinion_links: opinionLinks,
      relationship,
      opinion_ids: [...new Set(opinionLinks.map(({ opinion_id }) => opinion_id))],
    };
  });
  return withDerivedAuthority({ ...prediction, participants });
}

function caseTargetPanelComplete(record: CaseRecord, prediction: Prediction) {
  const deterministicPanel = record.deterministic.status === "ready"
    ? [...new Map(record.deterministic.panel.map((name) => [judgeIdentityKey(name), name])).values()]
    : [];
  if (deterministicPanel.length) {
    return prediction.participants.length === deterministicPanel.length && deterministicPanel.every((name) =>
      uniqueJudgeMatch(name, prediction.participants, (participant) => participant.name) !== null
    );
  }
  return prediction.participants.length === 1;
}

export function validateCaseTargetSubmission(record: CaseRecord, raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    const roster = validatePrediction(record, raw);
    return { prediction: roster.prediction, validation: roster.validation, case_target_mvp: null, compiler_errors: [] as string[] };
  }
  const submission = raw as Record<string, unknown>;
  const contractErrors = reducedRosterContractErrors(record, submission);
  const roster = validatePrediction(record, reducedRosterSubmission(record, submission));
  if (contractErrors.length) {
    return {
      prediction: null,
      validation: {
        ok: false as const,
        error: "opinion_extraction_invalid",
        errors: [...new Set([...(roster.validation.errors ?? []), ...contractErrors])],
        next: "Correct only the named source-grounding and opinion-role errors.",
      },
      case_target_mvp: null,
      compiler_errors: [] as string[],
    };
  }
  if (!roster.prediction) {
    return { prediction: null, validation: roster.validation, case_target_mvp: null, compiler_errors: [] as string[] };
  }
  let compiled: ReturnType<typeof compileReducedCaseTargetSubmission>;
  try {
    compiled = compileReducedCaseTargetSubmission(
      submission as ReducedCaseTargetSubmission,
      {
        sourceText: record.source.text,
        directHistoryEligible: record.candidate.target?.sameLitigationEligible === true,
        opinions: roster.prediction.opinions.map((opinion) => ({
          id: opinion.id,
          start: opinion.start,
          end: opinion.end_exclusive,
          text: record.source.text.slice(opinion.start, opinion.end_exclusive),
        })),
        participants: roster.prediction.participants.map((participant) => ({
          name: participant.name,
          opinion_links: participant.opinion_links.map(({ opinion_id, relation }) => ({ opinion_id, relation })),
          result_only: participant.result_only,
        })),
        panelComplete: caseTargetPanelComplete(record, roster.prediction),
        occurrences: record.targetOccurrences,
      },
    );
  } catch (error) {
    const compilerErrors = [`v13 submission shape: ${errorMessage(error)}`];
    return { prediction: roster.prediction, validation: roster.validation, case_target_mvp: null, compiler_errors: compilerErrors };
  }
  const partialJoinConflicts = compiled.input.partialIssueJoins.flatMap((join) => {
    const participant = uniqueJudgeMatch(join.participant_name, roster.prediction!.participants, (candidate) => candidate.name);
    if (!participant) return [`partial join names unknown participant ${join.participant_name}`];
    if (participant.result_only) return [`${participant.name} cannot be result-only and also join part of ${join.opinion_id}`];
    return join.evidence_quotes.length > 0 && join.evidence_quotes.every((quote) => sourceNameMatches(quote, participant.name))
      ? []
      : [`${participant.name} partial-join evidence does not identify that judge`];
  });
  const compilerErrors = [...new Set([...compiled.errors, ...partialJoinConflicts])];
  const prediction = addCompiledPartialLinks(roster.prediction, compiled.input.partialIssueJoins);
  const resolved = resolveCaseTargetMvp({
    ...compiled.input,
    participants: prediction.participants.map((participant) => ({
      name: participant.name,
      opinion_links: participant.opinion_links.map(({ opinion_id, relation }) => ({ opinion_id, relation })),
      result_only: participant.result_only,
    })),
  });
  const errors = [...new Set([...compilerErrors, ...resolved.errors])];
  const ok = errors.length === 0;
  const caseTargetMvp = {
    ...resolved,
    ok,
    errors,
    compiler_errors: compilerErrors,
    flat_treatment: {
      ...resolved.flat_treatment,
      status: ok ? resolved.flat_treatment.status : "partial",
      flags: {
        ...resolved.flat_treatment.flags,
        aggregation_safe: ok && resolved.flat_treatment.flags.aggregation_safe,
      },
    },
  };
  return { prediction, validation: roster.validation, case_target_mvp: caseTargetMvp, compiler_errors: compilerErrors };
}

function treatmentOpinionPosition(opinion: Prediction["opinions"][number]): OpinionPosition {
  return opinion.authority_position;
}

function validateSemanticMvp(
  record: CaseRecord,
  prediction: Prediction,
  raw: Record<string, unknown>,
) {
  const issueOutput = Array.isArray(raw.issue_cards)
    ? raw.issue_cards as ModelIssueCard[]
    : [];
  const issues = resolveIssueCards(
    prediction.opinions.map((opinion) => ({
      id: opinion.id,
      start: opinion.start,
      end: opinion.end_exclusive,
      text: record.source.text.slice(opinion.start, opinion.end_exclusive),
    })),
    issueOutput,
  );

  const treatmentOutput = Array.isArray(raw.treatments)
    ? raw.treatments as ModelTreatmentItem[]
    : [];
  const knownEdgeIds = new Set(record.citationEdges.map(({ id }) => id));
  const seenOutputIds = new Set<string>();
  const treatmentBatchErrors: Array<{ citationEdgeId: string; reason: string }> = [];
  for (const item of treatmentOutput) {
    if (!knownEdgeIds.has(item.citation_edge_id)) {
      treatmentBatchErrors.push({ citationEdgeId: item.citation_edge_id, reason: "unknown citation edge id" });
    } else if (seenOutputIds.has(item.citation_edge_id)) {
      treatmentBatchErrors.push({ citationEdgeId: item.citation_edge_id, reason: "duplicate model citation edge id" });
    }
    seenOutputIds.add(item.citation_edge_id);
  }
  for (const edge of record.citationEdges) {
    if (!seenOutputIds.has(edge.id)) {
      treatmentBatchErrors.push({ citationEdgeId: edge.id, reason: "model output missing citation edge id" });
    }
  }

  const sourceCitationKey = citationLookupKey(record.candidate.citation);
  const inputs: TreatmentInput[] = [];
  const containingOpinion = new Map<string, Prediction["opinions"][number]>();
  for (const edge of record.citationEdges) {
    const opinion = prediction.opinions.find((candidate) =>
      edge.start >= candidate.start && edge.end <= candidate.end_exclusive
    );
    if (!opinion) {
      treatmentBatchErrors.push({ citationEdgeId: edge.id, reason: "citation occurrence falls outside every resolved opinion" });
      continue;
    }
    containingOpinion.set(edge.id, opinion);
    inputs.push({
      edge: {
        id: edge.id,
        sourceCitationKey,
        target: citationTarget(edge.citation),
        context: edge.context,
      },
      opinion: {
        id: opinion.id,
        position: treatmentOpinionPosition(opinion),
        text: record.source.text.slice(opinion.start, opinion.end_exclusive),
        start: opinion.start,
      },
    });
  }
  const inputIds = new Set(inputs.map(({ edge }) => edge.id));
  const treatments = resolveTreatmentBatch(inputs, {
    treatments: treatmentOutput.filter((item) => inputIds.has(item.citation_edge_id)),
  });
  treatmentBatchErrors.push(...treatments.rejections);

  const localityRejections: Array<{ citationEdgeId: string; kind: string; reason: string }> = [];
  const treatmentEdges = treatments.edges.map((resolved) => {
    const candidate = record.citationEdges.find(({ id }) => id === resolved.citationEdgeId)!;
    const local = (event: { evidence: { start: number; end: number } }, kind: string) => {
      const ok = event.evidence.start >= candidate.contextStart && event.evidence.end <= candidate.contextEnd;
      if (!ok) localityRejections.push({
        citationEdgeId: candidate.id,
        kind,
        reason: "treatment evidence falls outside the selected citation context",
      });
      return ok;
    };
    return {
      ...resolved,
      substantive: resolved.substantive.filter((event) => local(event, "substantive")),
      directHistory: resolved.directHistory.filter((event) => local(event, "direct_history")),
    };
  });
  const treatmentEventRejections = treatmentEdges.flatMap((edge) => edge.rejections);
  const ok = issueOutput.length > 0 && issues.rejections.length === 0 &&
    treatmentBatchErrors.length === 0 && localityRejections.length === 0 &&
    treatmentEventRejections.length === 0;
  return {
    ok,
    citation_edges: record.citationEdges.map((edge) => ({
      ...edge,
      context_sha256: sha256(edge.context),
      containing_opinion_id: containingOpinion.get(edge.id)?.id ?? null,
    })),
    issues,
    treatments: {
      edges: treatmentEdges,
      batch_rejections: treatmentBatchErrors,
      locality_rejections: localityRejections,
    },
    counts: {
      submitted_issue_cards: issueOutput.length,
      accepted_issue_cards: issues.cards.length,
      submitted_treatment_edges: treatmentOutput.length,
      accepted_substantive_treatments: treatmentEdges.reduce((sum, edge) => sum + edge.substantive.length, 0),
      accepted_direct_history_events: treatmentEdges.reduce((sum, edge) => sum + edge.directHistory.length, 0),
    },
  };
}

function extractToolCall(message: Record<string, unknown>) {
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const first = calls[0];
  if (!first || typeof first !== "object") return null;
  const fn = (first as Record<string, unknown>).function;
  if (!fn || typeof fn !== "object") return null;
  const row = fn as Record<string, unknown>;
  let args: unknown = row.arguments ?? {};
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { args = { _invalid_json: args }; }
  }
  return { name: String(row.name ?? ""), args };
}

function assistantMessage(message: Record<string, unknown>) {
  return {
    role: "assistant",
    content: typeof message.content === "string" ? message.content : "",
    ...(Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls } : {}),
  };
}

async function ollamaChat(args: {
  baseUrl: string;
  hostHeader?: string;
  model: string;
  numCtx: number;
  numPredict: number;
  temperature: number;
  messages: Array<Record<string, unknown>>;
}) {
  const started = performance.now();
  let response: Response;
  try {
    response = await fetch(`${args.baseUrl.replace(/\/$/u, "")}/api/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(args.hostHeader ? { host: args.hostHeader } : {}),
      },
      body: JSON.stringify({
        model: args.model,
        messages: args.messages,
        tools: [LOOKUP_TOOL, SUBMIT_TOOL],
        stream: false,
        think: false,
        options: {
          temperature: args.temperature,
          num_ctx: args.numCtx,
          num_predict: args.numPredict,
        },
      }),
      signal: AbortSignal.timeout(900_000),
    });
  } catch (error) {
    throw new Error(`Ollama request failed: ${errorMessage(error)}`);
  }
  const raw = await response.text();
  let body: unknown = {};
  try { body = JSON.parse(raw); } catch { /* retain invalid responses verbatim */ }
  if (!response.ok) throw new Error(`Ollama ${response.status}: ${json(body)}`);
  const payload = body as Record<string, unknown>;
  return {
    raw,
    message: (payload.message && typeof payload.message === "object" ? payload.message : {}) as Record<string, unknown>,
    usage: {
      prompt_eval_count: payload.prompt_eval_count ?? null,
      eval_count: payload.eval_count ?? null,
      total_duration: payload.total_duration ?? null,
      wall_seconds: Math.round((performance.now() - started) / 10) / 100,
    },
  };
}

function compactLookupResult(lookup: Awaited<ReturnType<typeof a2ajLegalSourceProvider.lookup>>) {
  if (!lookup) return { ok: false, error: "lookup tool unavailable" };
  const evidence = a2ajLookupEvidenceBlocks(lookup, "case")
    .find(({ role }) => role === "selected")?.receipt;
  return {
    ok: lookup.status === "found",
    citation: lookup.citation,
    requested: lookup.requested,
    matches: lookup.matches,
    structure: lookup.structure,
    evidence_id: evidence?.evidence_id ?? null,
    block: lookup.block
      ? {
          kind: lookup.block.kind,
          label: lookup.block.label,
          start: lookup.block.start,
          end: lookup.block.end,
          text: lookup.block.text,
        }
      : null,
    error: lookup.status === "found" ? undefined : `lookup ${lookup.status}`,
  };
}

async function lookupForModel(record: CaseRecord, args: unknown) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return { ok: false, error: "lookup arguments must be an object" };
  const value = args as Record<string, unknown>;
  const citation = String(value.citation ?? "").trim();
  if (citation.toLocaleLowerCase() !== record.candidate.citation.toLocaleLowerCase()) {
    return { ok: false, error: "selected case is the only readable source" };
  }
  if (value.doc_type && value.doc_type !== "cases") return { ok: false, error: "only case paragraphs are available" };
  if (value.locator_type && value.locator_type !== "paragraph") return { ok: false, error: "use paragraph locators" };
  const start = paragraphNumber(value.locator);
  const endValue = value.end_locator === undefined ? start : paragraphNumber(value.end_locator);
  const available = paragraphNumbers(record.paragraphs);
  const selected = numbersInRange({ from: start, to: endValue }, available);
  if (!selected.length || selected[0] !== start || selected.at(-1) !== endValue) {
    return {
      ok: false,
      error: "paragraph locator not in source index",
      valid_paragraphs: paragraphIndex(record.paragraphs),
      next: "Use one exact paragraph number or an inclusive range from the valid paragraph index.",
    };
  }
  if (selected.length > MAX_LOOKUP_PARAGRAPHS) {
    return {
      ok: false,
      error: `read at most ${MAX_LOOKUP_PARAGRAPHS} paragraphs per lookup`,
      valid_paragraphs: paragraphIndex(record.paragraphs),
      next: `Split the range into blocks of at most ${MAX_LOOKUP_PARAGRAPHS} paragraphs.`,
    };
  }
  const lookup = await a2ajLegalSourceProvider.lookup({
    citation: record.candidate.citation,
    docType: "cases",
    language: "en",
    dataset: record.candidate.dataset,
    kind: "paragraph",
    locator: String(start),
    ...(endValue !== start ? { endLocator: String(endValue) } : {}),
    contextBlocks: 0,
  });
  return compactLookupResult(lookup);
}

function paragraphNumber(value: unknown) {
  const raw = String(value ?? "").trim();
  const match = /^(?:par(?:agraph)?[\s#:-]*)?(\d+)$/iu.exec(raw);
  return match ? Number(match[1]) : Number.NaN;
}

function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

function validUtf8String(value: string) {
  return Buffer.from(value, "utf8").toString("utf8");
}

function unpairedSurrogateCount(value: string) {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) index += 1;
      else count += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      count += 1;
    }
  }
  return count;
}

function codexSubscriptionEnvironment() {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.OPENAI_BASE_URL;
  return env;
}

function codexSubscriptionInvocation() {
  if (!existsSync(CODEX_SUBSCRIPTION_HELPER)) {
    throw new Error(`Codex subscription helper is missing: ${CODEX_SUBSCRIPTION_HELPER}`);
  }
  const command = process.env.PYTHON_CMD?.trim() || "python";
  return { command, prefix: [CODEX_SUBSCRIPTION_HELPER], shell: /\.cmd$/iu.test(command) };
}

export function codexSubscriptionPreflight() {
  const invocation = codexSubscriptionInvocation();
  const result = spawnSync(invocation.command, [...invocation.prefix, "--preflight"], {
    encoding: "utf8",
    shell: invocation.shell,
    env: codexSubscriptionEnvironment(),
  });
  if (result.status !== 0) {
    throw new Error(`Codex subscription preflight failed: ${`${result.stderr ?? result.stdout ?? ""}`.trim().slice(-1_000)}`);
  }
  let receipt: Record<string, unknown>;
  try {
    receipt = JSON.parse(`${result.stdout ?? ""}`.trim()) as Record<string, unknown>;
  } catch {
    throw new Error("Codex subscription preflight returned invalid JSON");
  }
  if (
    receipt.kind !== "subscription_preflight" ||
    receipt.endpoint !== CODEX_SUBSCRIPTION_ENDPOINT ||
    receipt.auth_mode !== "chatgpt" ||
    receipt.account_id_present !== true ||
    (typeof receipt.access_token_valid_for_seconds === "number" && receipt.access_token_valid_for_seconds <= 0)
  ) {
    throw new Error(`Codex subscription preflight was not a valid flat-subscription receipt: ${JSON.stringify(receipt)}`);
  }
  return receipt;
}

function codexSubscriptionEvents(
  events: Array<Record<string, unknown>>,
  eventCount: number,
  providerAttemptCount: number,
) {
  const preflight = events.find((event) => event.kind === "subscription_preflight");
  const completed = [...events].reverse().find((event) => event.kind === "subscription_completed");
  return {
    event_count: eventCount,
    transport_retries: Math.max(
      0,
      providerAttemptCount - 1,
      typeof completed?.transport_retries === "number" ? completed.transport_retries : 0,
    ),
    thread_id: null,
    response_id: typeof completed?.response_id === "string" ? completed.response_id : null,
    usage: completed?.usage && typeof completed.usage === "object" ? completed.usage : null,
    transport: {
      endpoint: preflight?.endpoint ?? completed?.endpoint ?? null,
      auth_mode: preflight?.auth_mode ?? completed?.auth_mode ?? null,
      account_id_present: preflight?.account_id_present ?? null,
      adapter_sha256: preflight?.adapter_sha256 ?? null,
      helper_sha256: preflight?.helper_sha256 ?? null,
      openai_sdk_version: preflight?.openai_sdk_version ?? null,
      isolated_process: true,
    },
  };
}

function codexEventSummary(event: Record<string, unknown>) {
  const providerEvent = event.kind === "subscription_provider_event" && event.event && typeof event.event === "object" && !Array.isArray(event.event)
    ? event.event as Record<string, unknown>
    : event;
  const item = providerEvent.item && typeof providerEvent.item === "object" && !Array.isArray(providerEvent.item)
    ? providerEvent.item as Record<string, unknown>
    : null;
  return {
    event_type: typeof providerEvent.type === "string"
      ? providerEvent.type
      : typeof event.kind === "string"
        ? event.kind
        : "unknown",
    attempt: typeof event.attempt === "number" ? event.attempt : null,
    thread_id: null,
    item_id: typeof item?.id === "string" ? item.id : null,
    item_type: typeof item?.type === "string" ? item.type : null,
    item_status: typeof item?.status === "string" ? item.status : null,
    error_message: providerEvent.type === "error" && typeof providerEvent.message === "string" ? providerEvent.message : null,
    item_error_message: item?.type === "error" && typeof item.message === "string" ? item.message : null,
    usage: event.usage && typeof event.usage === "object" ? event.usage : null,
  };
}

type AsyncCommandResult = {
  stdoutSha256: string;
  subscriptionEvents: Array<Record<string, unknown>>;
  providerEventCount: number;
  providerAttemptCount: number;
  stderr: string;
  status: number | null;
  error: Error | null;
};

type CodexEventHandler = (
  event: Record<string, unknown>,
  rawLine: string,
) => Promise<void>;

function spawnCodex(
  invocation: ReturnType<typeof codexSubscriptionInvocation>,
  args: string[],
  input: string,
  timeoutMs: number,
  onEvent?: CodexEventHandler,
): Promise<AsyncCommandResult> {
  return new Promise((resolve) => {
    const stdoutHash = createHash("sha256");
    const subscriptionEvents: Array<Record<string, unknown>> = [];
    let providerEventCount = 0;
    let providerAttemptCount = 0;
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let eventError: Error | null = null;
    let lineBuffer = "";
    let eventWrites = Promise.resolve();
    let timer: ReturnType<typeof setTimeout>;
    const child = spawn(invocation.command, [...invocation.prefix, ...args], {
      shell: invocation.shell,
      windowsHide: true,
      env: codexSubscriptionEnvironment(),
    });

    const queueEvent = (line: string) => {
      if (!line.trim()) return;
      let event: unknown;
      try { event = JSON.parse(line); } catch { event = { kind: "subscription_unparseable_line" }; }
      if (!event || typeof event !== "object" || Array.isArray(event)) event = { kind: "subscription_unparseable_line" };
      const record = event as Record<string, unknown>;
      if (record.kind === "subscription_provider_event") {
        providerEventCount += 1;
        providerAttemptCount = Math.max(providerAttemptCount, Number(record.attempt) || 1);
      }
      if (record.kind === "subscription_preflight" || record.kind === "subscription_completed") {
        subscriptionEvents.push(record);
      }
      if (!onEvent) return;
      eventWrites = eventWrites
        .then(() => onEvent(record, line))
        .catch((error) => { eventError ??= error instanceof Error ? error : new Error(String(error)); });
    };

    const drainEventLines = (flush = false) => {
      const lines = lineBuffer.split(/\r?\n/u);
      const remainder = lines.pop() ?? "";
      lineBuffer = flush ? "" : remainder;
      for (const line of lines) queueEvent(line);
      if (flush && remainder.trim()) queueEvent(remainder);
    };

    const finish = async (status: number | null, error: Error | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      drainEventLines(true);
      await eventWrites;
      const finalError = error
        ?? eventError
        ?? (timedOut ? new Error(`Codex subscription call timed out after ${timeoutMs / 1_000}s`) : null);
      resolve({
        stdoutSha256: stdoutHash.digest("hex"),
        subscriptionEvents,
        providerEventCount,
        providerAttemptCount,
        stderr,
        status,
        error: finalError,
      });
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutHash.update(chunk, "utf8");
      lineBuffer += chunk;
      drainEventLines();
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr, "utf8") > MAX_CODEX_STDERR_BYTES) {
        stderr = stderr.slice(-MAX_CODEX_STDERR_BYTES);
      }
    });
    child.once("error", (error) => { void finish(null, error); });
    child.once("close", (status) => { void finish(status); });
    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    try {
      child.stdin?.end(input, "utf8");
    } catch (error) {
      finish(null, error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export async function runStructuredLuna(args: {
  prompt: string;
  schema: unknown;
  schemaName: string;
  responseFormat?: unknown;
  model: string;
  effort: string;
  timeoutSeconds: number;
  onEvent?: CodexEventHandler;
}) {
  const { prompt, schema, schemaName, responseFormat, model, effort, timeoutSeconds, onEvent } = args;
  if (!/^[\w.:-]+$/u.test(model)) throw new Error(`invalid Codex model: ${model}`);
  if (!["none", "low", "medium", "high", "xhigh", "max", "ultra"].includes(effort)) {
    throw new Error(`invalid Codex effort: ${effort}`);
  }
  if (!/^[\w.-]+$/u.test(schemaName)) throw new Error(`invalid response schema name: ${schemaName}`);
  const temp = await mkdtemp(path.join(os.tmpdir(), "beaver-a2aj-codex-subscription-"));
  const answerPath = path.join(temp, "answer.json");
  const invocation = codexSubscriptionInvocation();
  const transportedPrompt = validUtf8String(prompt);
  let utf8ReplacementCount = unpairedSurrogateCount(prompt);
  const cliArgs = [
    "--output",
    answerPath,
  ];
  const requestValue = {
    model,
    effort,
    prompt_base64: Buffer.from(transportedPrompt, "utf8").toString("base64"),
    response_format: responseFormat ?? { type: "json_schema", name: schemaName, strict: true, schema },
    prompt_cache_key: `a2aj-${sha256(`${schemaName}\0${transportedPrompt}`)}`,
  };
  const request = JSON.stringify(requestValue, (_key, value) => {
    if (typeof value !== "string") return value;
    const replacements = unpairedSurrogateCount(value);
    utf8ReplacementCount += replacements;
    return replacements ? validUtf8String(value) : value;
  });
  const started = performance.now();
  try {
    const result = await spawnCodex(
      invocation,
      cliArgs,
      request,
      Math.max(1, timeoutSeconds) * 1_000,
      onEvent,
    );
    const answer = existsSync(answerPath) ? await readFile(answerPath, "utf8") : "";
    return {
      raw: answer,
      parsed: extractJsonObject(answer),
      stderr: result.stderr,
      stderrSha256: sha256(result.stderr),
      stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
      returnCode: result.status,
      error: result.error
        ? errorMessage(result.error)
        : result.status === 0
          ? null
          : `Codex subscription child exited ${result.status ?? "without a status"}`,
      elapsedSeconds: Math.round((performance.now() - started) / 10) / 100,
      promptSha256: sha256(transportedPrompt),
      promptChars: transportedPrompt.length,
      utf8ReplacementCount,
      outputSha256: sha256(answer),
      stdoutSha256: result.stdoutSha256,
      ...codexSubscriptionEvents(
        result.subscriptionEvents,
        result.providerEventCount,
        result.providerAttemptCount,
      ),
      cli: {
        model,
        effort,
        transport: "codex_chatgpt_subscription",
        endpoint: CODEX_SUBSCRIPTION_ENDPOINT,
        auth_mode: "chatgpt",
        isolated_process: true,
        output_schema: schemaName,
        response_format: responseFormat,
      },
    };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function runLuna(
  prompt: string,
  model: string,
  effort: string,
  timeoutSeconds: number,
  semanticMvp = false,
  caseTargetMvp = false,
  directHistoryEligible = false,
  onEvent?: CodexEventHandler,
) {
  if (semanticMvp && caseTargetMvp) throw new Error("Luna schema modes are mutually exclusive");
  const caseTargetSchema = caseTargetMvp
    ? structuredClone(CASE_TARGET_MVP_JSON_SCHEMA) as any
    : null;
  if (caseTargetSchema && !directHistoryEligible) {
    caseTargetSchema.properties.direct_history.maxItems = 0;
  }
  const schema = caseTargetMvp
    ? caseTargetSchema
    : semanticMvp
      ? SEMANTIC_MVP_JSON_SCHEMA
      : SUBMIT_TOOL.function.parameters;
  const schemaName = caseTargetMvp
    ? CASE_TARGET_MVP_SCHEMA_NAME
    : semanticMvp
      ? SEMANTIC_MVP_SCHEMA_NAME
      : RESPONSE_SCHEMA_NAME;
  const responseFormat = caseTargetMvp
    ? { ...CASE_TARGET_MVP_RESPONSES_SCHEMA, schema: caseTargetSchema }
    : semanticMvp
      ? SEMANTIC_MVP_RESPONSES_SCHEMA
      : GPT_RESPONSES_SCHEMA;
  return runStructuredLuna({
    prompt,
    schema,
    schemaName,
    responseFormat,
    model,
    effort,
    timeoutSeconds,
    onEvent,
  });
}

async function hydratePrediction(record: CaseRecord, prediction: Prediction) {
  return prediction.opinions.map((opinion) => ({
    opinion_id: opinion.id,
    alignment: opinion.alignment,
    result_position: opinion.result_position,
    start: opinion.start,
    end_exclusive: opinion.end_exclusive,
    text_sha256: opinion.text_sha256,
    source_sha256: record.sourceSha256,
    source_evidence_id: record.sourceEvidence.evidence_id,
    paragraphs: opinion.paragraphs,
  }));
}

function predictionSpans(prediction: Prediction) {
  const spans = roleMap();
  for (const opinion of prediction.opinions) {
    const role: Role = opinion.alignment === "lead"
      ? "majority"
      : opinion.alignment === "different_result"
        ? "minority"
        : opinion.alignment === "same_result_separate_reasons"
          ? "concurring"
          : "unknown";
    spans[role].push(...opinion.paragraphs);
  }
  for (const role of ROLE_KEYS) {
    spans[role] = compressNumbers(spans[role].flatMap((range) => {
      const numbers: number[] = [];
      for (let number = range.from; number <= range.to; number += 1) numbers.push(number);
      return numbers;
    }));
  }
  return spans;
}

function score(prediction: Prediction, reference: Reference | null, available: number[]) {
  if (!reference || reference.status !== "ready") return { reference: null };
  if (reference.source === "human") {
    return {
      reference: "human",
      opinion_exact: JSON.stringify(prediction.opinions) === JSON.stringify(reference.prediction.opinions),
      judge_exact: JSON.stringify(prediction.participants) === JSON.stringify(reference.prediction.participants),
    };
  }
  const spans = predictionSpans(prediction);
  const exact = ROLE_KEYS.every((role) => JSON.stringify(spans[role]) === JSON.stringify(reference.spans[role]));
  const gold = new Map<number, Role>();
  const predicted = new Map<number, Role>();
  for (const role of ROLE_KEYS) {
    for (const range of reference.spans[role]) for (const number of numbersInRange(range, available)) gold.set(number, role);
    for (const range of spans[role]) for (const number of numbersInRange(range, available)) predicted.set(number, role);
  }
  const matches = available.filter((number) => gold.get(number) === predicted.get(number)).length;
  const predictedJudges = prediction.participants.map((judge) => ({
    name: judge.name,
    role: judge.result_side === "minority"
      ? "minority"
      : judge.relationship === "authors" && judge.opinion_ids.some((id) =>
          prediction.opinions.some((opinion) => opinion.id === id && opinion.alignment === "same_result_separate_reasons"),
        )
        ? "concurring"
        : judge.result_side === "majority"
          ? "majority"
          : "unknown",
  }));
  const judgeExact = reference.judges.length > 0 && JSON.stringify(predictedJudges) === JSON.stringify(reference.judges);
  return {
    reference: reference.source,
    span_exact: exact,
    paragraph_accuracy: available.length ? Math.round((matches / available.length) * 1_000_000) / 1_000_000 : null,
    judge_exact: judgeExact,
  };
}

async function initSidecar(file: string) {
  const { DatabaseSync } = await import("node:sqlite");
  await mkdir(path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  database.exec(`
    CREATE TABLE IF NOT EXISTS opinion_run (
      run_id TEXT PRIMARY KEY, created_utc TEXT NOT NULL, seed INTEGER NOT NULL,
      sample_size INTEGER NOT NULL, scope TEXT NOT NULL, provider TEXT NOT NULL,
      model TEXT NOT NULL, effort TEXT NOT NULL, num_ctx INTEGER NOT NULL,
      num_predict INTEGER NOT NULL, prompt_version TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opinion_decision (
      run_id TEXT NOT NULL, document_id INTEGER NOT NULL, source_sha256 TEXT NOT NULL,
      dataset TEXT NOT NULL, citation TEXT NOT NULL, name TEXT, decision_date TEXT,
      structure_status TEXT NOT NULL, paragraph_count INTEGER NOT NULL,
      deterministic_status TEXT NOT NULL,
      result_status TEXT NOT NULL, source_evidence_id TEXT, prediction_json TEXT,
      reference_json TEXT, validation_json TEXT NOT NULL, metrics_json TEXT,
      PRIMARY KEY (run_id, document_id)
    );
    CREATE TABLE IF NOT EXISTS opinion_judge (
      run_id TEXT NOT NULL, document_id INTEGER NOT NULL, ordinal INTEGER NOT NULL,
      name TEXT NOT NULL, result_side TEXT NOT NULL, relationship TEXT NOT NULL,
      opinion_ids_json TEXT NOT NULL, provenance TEXT NOT NULL,
      PRIMARY KEY (run_id, document_id, ordinal)
    );
    CREATE TABLE IF NOT EXISTS opinion_text (
      run_id TEXT NOT NULL, document_id INTEGER NOT NULL, opinion_id TEXT NOT NULL,
      alignment TEXT NOT NULL, authors_json TEXT NOT NULL,
      start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL,
      start_quote TEXT NOT NULL, end_quote TEXT NOT NULL,
      text_sha256 TEXT NOT NULL, paragraphs_json TEXT NOT NULL,
      source_evidence_id TEXT, provenance TEXT NOT NULL,
      PRIMARY KEY (run_id, document_id, opinion_id)
    );
    CREATE TABLE IF NOT EXISTS opinion_reference (
      document_id INTEGER PRIMARY KEY, source_sha256 TEXT NOT NULL,
      prediction_json TEXT NOT NULL, created_utc TEXT NOT NULL
    );
  `);
  return database;
}

function saveCase(
  database: InstanceType<typeof import("node:sqlite").DatabaseSync>,
  runId: string,
  record: CaseRecord,
  prediction: Prediction | null,
  evidence: Awaited<ReturnType<typeof hydratePrediction>>,
  reference: Reference,
  validation: Validation,
  metrics: Record<string, unknown>,
  resultStatus: string,
  provenance: string,
) {
  database.prepare("DELETE FROM opinion_judge WHERE run_id=? AND document_id=?").run(runId, record.candidate.documentId);
  database.prepare("DELETE FROM opinion_text WHERE run_id=? AND document_id=?").run(runId, record.candidate.documentId);
  database.prepare(`
    INSERT OR REPLACE INTO opinion_decision
    (run_id,document_id,source_sha256,dataset,citation,name,decision_date,structure_status,paragraph_count,deterministic_status,result_status,source_evidence_id,prediction_json,reference_json,validation_json,metrics_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    runId,
    record.candidate.documentId,
    record.sourceSha256,
    record.candidate.dataset,
    record.candidate.citation,
    record.candidate.name,
    record.candidate.date,
    record.source.status,
    record.paragraphs.length,
    record.deterministic.status,
    resultStatus,
    record.sourceEvidence.evidence_id,
    prediction ? JSON.stringify(prediction) : null,
    JSON.stringify(reference),
    JSON.stringify(validation),
    JSON.stringify(metrics),
  );
  for (const [ordinal, judge] of (prediction?.participants ?? []).entries()) {
    database.prepare("INSERT INTO opinion_judge VALUES (?,?,?,?,?,?,?,?)").run(
      runId,
      record.candidate.documentId,
      ordinal,
      judge.name,
      judge.result_side,
      judge.relationship,
      JSON.stringify(judge.opinion_ids),
      provenance,
    );
  }
  for (const opinion of prediction?.opinions ?? []) {
    const item = evidence.find((candidate) => candidate.opinion_id === opinion.id);
    database.prepare("INSERT INTO opinion_text VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      runId,
      record.candidate.documentId,
      opinion.id,
      opinion.alignment,
      JSON.stringify(opinion.author_names),
      opinion.start,
      opinion.end_exclusive,
      opinion.start_quote,
      opinion.end_quote,
      opinion.text_sha256,
      JSON.stringify(opinion.paragraphs),
      item?.source_evidence_id ?? record.sourceEvidence.evidence_id,
      provenance,
    );
  }
}

export function candidatePoolIds(scope: string, database: import("node:sqlite").DatabaseSync): number[] {
  const params: string[] = [];
  const filters = [
    "doc_type = 'cases'",
    "unofficial_text_en IS NOT NULL",
    "COALESCE(NULLIF(citation_en, ''), NULLIF(citation2_en, '')) IS NOT NULL",
  ];
  if (scope.toLocaleUpperCase() !== "ALL") {
    filters.push("UPPER(dataset) = UPPER(?)");
    params.push(scope);
  }
  const where = filters.join(" AND ");
  return (
    database.prepare(`SELECT id FROM document WHERE ${where} ORDER BY id`).all(...params) as Array<{ id: number }>
  ).map((row) => Number(row.id));
}

function candidatesForIds(
  database: import("node:sqlite").DatabaseSync,
  documentIds: number[],
  eligibleOnly = false,
): Candidate[] {
  const rows = new Map<number, Record<string, unknown>>();
  for (let index = 0; index < documentIds.length; index += 500) {
    const chunk = documentIds.slice(index, index + 500);
    const marks = chunk.map(() => "?").join(",");
    for (const row of database.prepare(`
      SELECT id, dataset,
        COALESCE(NULLIF(citation_en, ''), NULLIF(citation2_en, '')) AS citation,
        name_en, document_date_en
      FROM document
      WHERE id IN (${marks}) AND doc_type='cases'
        ${eligibleOnly ? "AND unofficial_text_en IS NOT NULL AND COALESCE(NULLIF(citation_en, ''), NULLIF(citation2_en, '')) IS NOT NULL" : ""}
    `).all(...chunk) as Array<Record<string, unknown>>) {
      rows.set(Number(row.id), row);
    }
  }
  const missing = documentIds.filter((id) => !rows.has(id));
  if (!eligibleOnly && missing.length) throw new Error(`A2AJ case document IDs not found: ${missing.join(", ")}`);
  return documentIds.flatMap((documentId) => {
    const row = rows.get(documentId);
    if (!row) return [];
    return {
      documentId,
      dataset: String(row.dataset ?? ""),
      citation: String(row.citation ?? ""),
      name: row.name_en ? String(row.name_en) : null,
      date: row.document_date_en ? String(row.document_date_en) : null,
    };
  });
}

function randomEligibleCandidates(
  database: import("node:sqlite").DatabaseSync,
  seed: number,
  size: number,
) {
  const extent = database.prepare("SELECT MIN(id) AS first, MAX(id) AS last FROM document").get() as
    { first?: number; last?: number } | undefined;
  const first = Number(extent?.first);
  const last = Number(extent?.last);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last < first) return [];
  const range = last - first + 1;
  const found = new Map<number, Candidate>();
  let drawn = 0;
  let wanted = Math.min(range, Math.max(size + 256, Math.ceil(size * 1.02)));
  while (drawn < wanted) {
    const offsets = drawOffsets(seed, wanted, range);
    const documentIds = offsets.slice(drawn).map((offset) => first + offset);
    for (const candidate of candidatesForIds(database, documentIds, true)) {
      found.set(candidate.documentId, candidate);
    }
    drawn = wanted;
    if (found.size >= size || wanted === range) {
      return offsets.flatMap((offset) => {
        const candidate = found.get(first + offset);
        return candidate ? [candidate] : [];
      }).slice(0, size);
    }
    wanted = Math.min(range, Math.max(wanted + 256, Math.ceil(wanted * 1.1)));
  }
  return [];
}

export function drawOffsets(seed: number, size: number, poolLength: number): number[] {
  const wanted = Math.min(Math.max(1, size), poolLength);
  let state = (seed >>> 0) || 1;
  const next = () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  const offsets = new Set<number>();
  while (offsets.size < wanted) offsets.add(Math.floor(next() * poolLength));
  // Set preserves pseudo-random draw order. Do not sort: sorted offsets make
  // partial corpus runs systematically overrepresent early dataset blocks.
  return [...offsets];
}

export function selectedCandidates(
  seed: number,
  size: number,
  scope: string,
  database?: import("node:sqlite").DatabaseSync,
): Candidate[] {
  if (!database) {
    return withReadonlySqlite(
      a2ajLocalBulkPath(),
      (open) => selectedCandidates(seed, size, scope, open),
    ) ?? [];
  }
  if (scope.toLocaleUpperCase() === "ALL") {
    const selected = randomEligibleCandidates(database, seed, size);
    if (!selected.length) throw new Error("no A2AJ cases found for scope ALL");
    return selected;
  }
  const allIds = candidatePoolIds(scope, database);
  if (!allIds.length) throw new Error(`no A2AJ cases found for scope ${scope}`);
  const drawn = drawOffsets(seed, size, allIds.length).map((offset) => allIds[offset]);
  return candidatesForIds(database, drawn);
}

function datasetSeed(seed: number, dataset: string) {
  let value = seed >>> 0;
  for (const character of dataset.toLocaleUpperCase()) {
    value = Math.imul(value ^ character.codePointAt(0)!, 16_777_619) >>> 0;
  }
  return value || 1;
}

function stratifiedCandidates(seed: number, perDataset: number) {
  return withReadonlySqlite(a2ajLocalBulkPath(), (database) => {
    const eligible = database.prepare(`
      SELECT id, dataset
      FROM document
      WHERE doc_type='cases'
        AND unofficial_text_en IS NOT NULL
        AND COALESCE(NULLIF(citation_en, ''), NULLIF(citation2_en, '')) IS NOT NULL
        AND dataset IS NOT NULL AND dataset <> ''
      ORDER BY id
    `).all() as Array<{ id: number; dataset: string }>;
    const byDataset = new Map<string, number[]>();
    for (const { id, dataset } of eligible) {
      const bucket = byDataset.get(String(dataset)) ?? [];
      bucket.push(Number(id));
      byDataset.set(String(dataset), bucket);
    }
    const buckets = [...byDataset.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([dataset, ids]) =>
        drawOffsets(datasetSeed(seed, dataset), perDataset, ids.length).map((offset) => ids[offset]),
      );
    const interleavedIds: number[] = [];
    for (let index = 0; buckets.some((bucket) => index < bucket.length); index += 1) {
      for (const bucket of buckets) {
        const documentId = bucket[index];
        if (documentId) interleavedIds.push(documentId);
      }
    }
    return candidatesForIds(database, interleavedIds);
  }) ?? [];
}

export function parseDocumentIds(value: string) {
  const tokens = value.split(/[\s,]+/u).filter(Boolean);
  const ids = tokens.map(Number);
  if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    throw new Error("case selectors must contain positive integer A2AJ document IDs");
  }
  return [...new Set(ids)];
}

export function candidatesByDocumentIds(documentIds: number[]) {
  const selected = withReadonlySqlite(a2ajLocalBulkPath(), (database) => candidatesForIds(database, documentIds));
  if (!selected) throw new Error(`A2AJ database not found: ${a2ajLocalBulkPath()}`);
  return selected;
}

async function documentIdsFromFile(file: string) {
  const raw = await readFile(path.resolve(file), "utf8");
  let value = raw;
  try {
    const parsed = JSON.parse(raw) as unknown;
    value = Array.isArray(parsed)
      ? parsed.join(",")
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { document_ids?: unknown }).document_ids)
        ? (parsed as { document_ids: unknown[] }).document_ids.join(",")
        : raw;
  } catch { /* newline/comma-delimited text is also accepted */ }
  return parseDocumentIds(value);
}

export async function candidatesFromPairFile(file: string) {
  const absolutePath = path.resolve(file);
  const parsed = JSON.parse(await readFile(absolutePath, "utf8")) as unknown;
  const rows = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as { pairs?: unknown }).pairs
    : null;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("--pair-file must contain a nonempty pairs array");
  }
  const pairs = rows.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`pair ${index + 1} must be an object`);
    }
    const row = value as Record<string, unknown>;
    const documentId = Number(row.document_id);
    const target = row.target;
    if (!Number.isSafeInteger(documentId) || documentId < 1) {
      throw new Error(`pair ${index + 1} has an invalid document_id`);
    }
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      throw new Error(`pair ${index + 1} has no target object`);
    }
    const targetRow = target as Record<string, unknown>;
    const citation = typeof targetRow.citation === "string" ? targetRow.citation.trim() : "";
    if (!citation || !citationLookupKey(citation)) {
      throw new Error(`pair ${index + 1} has an invalid target citation`);
    }
    const targetDocumentId = targetRow.document_id === null || targetRow.document_id === undefined
      ? null
      : Number(targetRow.document_id);
    if (targetDocumentId !== null && (!Number.isSafeInteger(targetDocumentId) || targetDocumentId < 1)) {
      throw new Error(`pair ${index + 1} has an invalid target document_id`);
    }
    const aliases = targetRow.citation_aliases === undefined
      ? []
      : targetRow.citation_aliases;
    if (!Array.isArray(aliases) || aliases.some((alias) => typeof alias !== "string" || !alias.trim())) {
      throw new Error(`pair ${index + 1} has invalid target citation_aliases`);
    }
    if (targetRow.same_litigation_eligible !== undefined && typeof targetRow.same_litigation_eligible !== "boolean") {
      throw new Error(`pair ${index + 1} has invalid target same_litigation_eligible`);
    }
    return {
      documentId,
      target: {
        documentId: targetDocumentId,
        citation,
        citationAliases: [...new Set((aliases as string[]).map((alias) => alias.trim()))],
        name: typeof targetRow.name === "string" && targetRow.name.trim() ? targetRow.name.trim() : null,
        sameLitigationEligible: targetRow.same_litigation_eligible === true,
      } satisfies CaseTargetSpec,
    };
  });
  const uniqueSources = new Set(pairs.map(({ documentId }) => documentId));
  if (uniqueSources.size !== pairs.length) {
    throw new Error("--pair-file currently permits one target per citing decision");
  }
  const byId = new Map(candidatesByDocumentIds(pairs.map(({ documentId }) => documentId))
    .map((candidate) => [candidate.documentId, candidate]));
  return pairs.map(({ documentId, target }) => ({ ...byId.get(documentId)!, target }));
}

async function selectedRunCandidates(args: Args, seed: number, sampleSize: number, scope: string) {
  const direct = flag(args, "document-ids", "");
  const caseFile = flag(args, "case-file", "");
  const pairFile = flag(args, "pair-file", "");
  if ([direct, caseFile, pairFile].filter(Boolean).length > 1) {
    throw new Error("use only one of --document-ids, --case-file, or --pair-file");
  }
  if (pairFile) return candidatesFromPairFile(pairFile);
  if (direct) return candidatesByDocumentIds(parseDocumentIds(direct));
  if (caseFile) {
    return candidatesByDocumentIds(await documentIdsFromFile(caseFile));
  }
  return selectedCandidates(seed, sampleSize, scope);
}

export async function loadCase(candidate: Candidate): Promise<CaseRecord | null> {
  const document = fetchLocalA2AJDocument({
    citation: candidate.citation,
    dataset: candidate.dataset,
    docType: "cases",
    language: "en",
    maxChars: Number.MAX_SAFE_INTEGER,
  });
  if (!document) return null;
  return buildCaseRecord(candidate, document);
}

async function compileCaseSource(document: A2AJDocument) {
  return a2ajLegalSourceProvider.source(document) ?? deriveA2AJSourceDoc({
    citation: document.citation,
    docType: document.docType ?? "cases",
    text: document.text,
    url: document.url,
    alternateCitation: document.alternateCitation,
    dataset: document.dataset,
    name: document.name,
  });
}

async function buildCaseRecord(candidate: Candidate, document: A2AJDocument): Promise<CaseRecord> {
  const source = await compileCaseSource(document);
  const paragraphs = source.blocks.filter((block) => block.kind === "paragraph");
  const sourceEvidence = createA2AJDocumentEvidence(document);
  const analysis = analyzeTextOpinionStructure({
    text: source.text,
    paragraphs,
    firstParagraphStart: paragraphs[0]?.start ?? 0,
  });
  const { structure, deterministic } = analysis;
  const record = {
    candidate,
    document,
    source,
    paragraphs,
    sourceEvidence,
    sourceSha256: sha256(source.text),
    structure,
    deterministic,
    hints: extractMechanicalHints(source, paragraphs, structure),
    preflight: extractPreflight(source, paragraphs),
  } satisfies Omit<CaseRecord, "citationEdges" | "targetOccurrences">;
  const targetOccurrences = caseTargetOccurrences(source, candidate.target);
  if (candidate.target && targetOccurrences.length === 0) {
    throw new Error(`target citation ${candidate.target.citation} was not found in the citing decision`);
  }
  return {
    ...record,
    citationEdges: semanticMvpCitationEdges(record),
    targetOccurrences,
  };
}

async function humanReference(database: InstanceType<typeof import("node:sqlite").DatabaseSync>, record: CaseRecord) {
  const row = database.prepare("SELECT prediction_json FROM opinion_reference WHERE document_id=? AND source_sha256=?").get(record.candidate.documentId, record.sourceSha256) as Record<string, unknown> | undefined;
  if (!row) return null;
  const normalized = validatePrediction(record, JSON.parse(String(row.prediction_json)), true);
  return normalized.prediction && normalized.validation.ok
    ? { source: "human", status: "ready", prediction: normalized.prediction } satisfies HumanReference
    : null;
}

async function runCase(args: {
  record: CaseRecord;
  runId: string;
  provider: Provider;
  model: string;
  effort: string;
  timeoutSeconds: number;
  baseUrl: string;
  hostHeader?: string;
  numCtx: number;
  numPredict: number;
  temperature: number;
  packetChars: number;
  progress: string;
  rawOutputs: string;
  callLedger?: string;
  maxAttempts: number;
  forceLlm: boolean;
  semanticMvp: boolean;
  caseTargetMvp: boolean;
  caseTargetPrompt: CaseTargetPromptVariant;
  referenceOverride?: Reference | null;
}) {
  const { record } = args;
  const mechanical = mechanicalReference(record);
  const reference = args.referenceOverride ?? mechanical;
  const deterministic = deterministicPrediction(record);
  if (args.provider === "luna" && deterministic && !args.forceLlm && !args.semanticMvp && !args.caseTargetMvp) {
    const evidence = await hydratePrediction(record, deterministic);
    return {
      status: "accepted",
      route: "deterministic",
      prediction: deterministic,
      evidence,
      reference,
      validation: { ok: true } satisfies Validation,
      metrics: score(deterministic, reference, paragraphNumbers(record.paragraphs)),
      attempts: [],
      raw_model_output_sha256s: [],
    };
  }
  if (args.provider === "dry") {
    await appendJsonl(args.progress, {
      kind: "dry_skip",
      phase: "roster",
      validation: { ok: false, error: "dry_run" },
      mechanical_status: mechanical.status,
      mechanical_note: mechanical.note ?? null,
      deterministic_status: record.deterministic.status,
      deterministic_opinions: record.deterministic.opinions.length,
    });
    return {
      status: "dry",
      route: "dry",
      prediction: null,
      evidence: [],
      reference: mechanical,
      validation: { ok: false, error: "dry_run" },
      metrics: { reference: null },
      attempts: [],
      raw_model_output_sha256s: [],
    };
  }
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: packet(record, args.provider === "luna", args.packetChars) },
  ];
  const attempts: Array<Record<string, unknown>> = [];
  let prediction: Prediction | null = null;
  let validation: Validation = { ok: false, error: "no_submission" };
  let semanticMvpResult: ReturnType<typeof validateSemanticMvp> | null = null;
  let caseTargetMvpResult: NonNullable<ReturnType<typeof validateCaseTargetSubmission>["case_target_mvp"]> | null = null;
  let modelReceipt: Record<string, unknown> | null = null;
  let canonicalModelOutputSha256: string | null = null;
  const rawModelOutputSha256s: string[] = [];
  if (args.provider === "luna") {
    const prompt = args.caseTargetMvp
      ? caseTargetMvpPacket(record, args.caseTargetPrompt)
      : args.semanticMvp
        ? semanticMvpPacket(record)
        : codexPacket(record);
    const phase = args.caseTargetMvp ? "case_target_mvp" : args.semanticMvp ? "semantic_mvp" : "roster";
    const callId = randomUUID();
    if (args.callLedger) await appendJsonl(args.callLedger, {
      kind: "model_call_started",
      call_id: callId,
      run_id: args.runId,
      purpose: phase,
      document: record.candidate.documentId,
      citation: record.candidate.citation,
      provider: "codex_subscription",
      model: args.model,
      effort: args.effort,
      prompt_version: args.caseTargetMvp
        ? CASE_TARGET_MVP_PROMPTS[args.caseTargetPrompt].version
        : args.semanticMvp
          ? SEMANTIC_MVP_PROMPT_VERSION
          : CODEX_PROMPT_VERSION,
      prompt_sha256: sha256(prompt),
      prompt_chars: prompt.length,
    });
    let teacher: Awaited<ReturnType<typeof runLuna>>;
    const seenProviderAttempts = new Set([1]);
    try {
      teacher = await runLuna(
        prompt,
        args.model,
        args.effort,
        args.timeoutSeconds,
        args.semanticMvp,
        args.caseTargetMvp,
        record.candidate.target?.sameLitigationEligible === true,
        async (event, rawLine) => {
          const summary = codexEventSummary(event);
          const providerAttempt = summary.attempt;
          if (
            args.callLedger && typeof providerAttempt === "number" && providerAttempt > 1 &&
            !seenProviderAttempts.has(providerAttempt)
          ) {
            seenProviderAttempts.add(providerAttempt);
            await appendJsonl(args.callLedger, {
              kind: "model_call_retry_started",
              call_id: callId,
              run_id: args.runId,
              purpose: phase,
              document: record.candidate.documentId,
              citation: record.candidate.citation,
              provider: "codex_subscription",
              model: args.model,
              effort: args.effort,
              attempt: providerAttempt,
            });
          }
          await appendJsonl(args.rawOutputs, {
            kind: "codex_event_raw",
            document: record.candidate.documentId,
            citation: record.candidate.citation,
            phase,
            provider: "luna",
            raw_event_line: rawLine,
          });
          await appendJsonl(args.progress, {
            kind: "codex_event",
            document: record.candidate.documentId,
            citation: record.candidate.citation,
            phase,
            provider: "luna",
            ...summary,
          });
        },
      );
    } catch (error) {
      if (args.callLedger) await appendJsonl(args.callLedger, {
        kind: "model_call_finished",
        call_id: callId,
        run_id: args.runId,
        purpose: phase,
        document: record.candidate.documentId,
        status: "runner_error",
        error: errorMessage(error),
      });
      throw error;
    }
    if (args.callLedger) await appendJsonl(args.callLedger, {
      kind: "model_call_finished",
      call_id: callId,
      run_id: args.runId,
      purpose: phase,
      document: record.candidate.documentId,
      status: teacher.returnCode === 0 && !teacher.error ? "completed" : "failed",
      return_code: teacher.returnCode,
      error: teacher.error,
      output_sha256: teacher.outputSha256,
      stderr_sha256: teacher.stderrSha256,
      stderr_bytes: teacher.stderrBytes,
      elapsed_seconds: teacher.elapsedSeconds,
      usage: teacher.usage,
      transport_retries: teacher.transport_retries,
    });
    rawModelOutputSha256s.push(teacher.outputSha256);
    await appendJsonl(args.rawOutputs, {
      kind: "model_output",
      document: record.candidate.documentId,
      citation: record.candidate.citation,
      phase,
      provider: "luna",
      raw_model_output: teacher.raw,
      output_sha256: teacher.outputSha256,
    });
    await appendJsonl(args.rawOutputs, {
      kind: "model_stderr",
      document: record.candidate.documentId,
      citation: record.candidate.citation,
      phase,
      provider: "luna",
      raw_model_stderr: teacher.stderr,
      stderr_sha256: teacher.stderrSha256,
      stderr_bytes: teacher.stderrBytes,
    });
    await appendJsonl(args.progress, {
      kind: "model_output_saved",
      document: record.candidate.documentId,
      citation: record.candidate.citation,
      phase,
      provider: "luna",
      raw_output_stream: args.rawOutputs,
      output_sha256: teacher.outputSha256,
      output_bytes: Buffer.byteLength(teacher.raw),
    });
    const parsedRecord = teacher.parsed && typeof teacher.parsed === "object" && !Array.isArray(teacher.parsed)
      ? teacher.parsed as Record<string, unknown>
      : null;
    if (args.caseTargetMvp) {
      const result = validateCaseTargetSubmission(record, teacher.parsed);
      prediction = result.prediction;
      validation = result.validation;
      caseTargetMvpResult = result.case_target_mvp;
      const canonical = {
        compiler_version: CASE_TARGET_MVP_COMPILER_VERSION,
        validator_version: CASE_TARGET_MVP_VALIDATOR_VERSION,
        source_sha256: record.sourceSha256,
        raw_output_sha256: teacher.outputSha256,
        prediction,
        case_target_mvp: caseTargetMvpResult,
        compiler_errors: result.compiler_errors,
      };
      canonicalModelOutputSha256 = sha256(JSON.stringify(canonical));
      await appendJsonl(args.rawOutputs, {
        kind: "canonical_model_output",
        document: record.candidate.documentId,
        citation: record.candidate.citation,
        phase,
        provider: "luna",
        ...canonical,
        canonical_output_sha256: canonicalModelOutputSha256,
      });
    } else {
      const result = validatePrediction(record, teacher.parsed);
      prediction = result.prediction;
      validation = result.validation;
      if (args.semanticMvp && prediction && parsedRecord) {
        semanticMvpResult = validateSemanticMvp(record, prediction, parsedRecord);
      }
    }
    modelReceipt = {
      runner: "codex_subscription_exec",
      prompt_version: args.caseTargetMvp
        ? CASE_TARGET_MVP_PROMPTS[args.caseTargetPrompt].version
        : args.semanticMvp
          ? SEMANTIC_MVP_PROMPT_VERSION
          : CODEX_PROMPT_VERSION,
      validator_version: args.caseTargetMvp
        ? CASE_TARGET_MVP_VALIDATOR_VERSION
        : args.semanticMvp
          ? SEMANTIC_MVP_VALIDATOR_VERSION
          : VALIDATOR_VERSION,
      prompt_sha256: teacher.promptSha256,
      prompt_chars: teacher.promptChars,
      utf8_replacement_count: teacher.utf8ReplacementCount,
      output_sha256: teacher.outputSha256,
      stdout_sha256: teacher.stdoutSha256,
      stderr_sha256: teacher.stderrSha256,
      stderr_bytes: teacher.stderrBytes,
      return_code: teacher.returnCode,
      error: teacher.error,
      stderr: teacher.stderr,
      elapsed_seconds: teacher.elapsedSeconds,
      event_count: teacher.event_count,
      transport_retries: teacher.transport_retries,
      thread_id: teacher.thread_id,
      response_id: teacher.response_id,
      usage: teacher.usage,
      transport: teacher.transport,
      cli: teacher.cli,
      canonical_output_sha256: canonicalModelOutputSha256,
      compiler_version: args.caseTargetMvp ? CASE_TARGET_MVP_COMPILER_VERSION : null,
    };
    attempts.push({ provider: "luna", validation, ...modelReceipt });
    await appendJsonl(args.progress, {
      kind: "model_call",
      document: record.candidate.documentId,
      citation: record.candidate.citation,
      phase,
      provider: "luna",
      tool_calls: [],
      validation,
      semantic_mvp_ok: semanticMvpResult?.ok ?? null,
      case_target_mvp_ok: caseTargetMvpResult?.ok ?? null,
      ...modelReceipt,
    });
  } else {
    for (let attempt = 1; attempt <= args.maxAttempts; attempt += 1) {
      const response = await ollamaChat({
        baseUrl: args.baseUrl,
        hostHeader: args.hostHeader,
        model: args.model,
        numCtx: args.numCtx,
        numPredict: args.numPredict,
        temperature: args.temperature,
        messages,
      });
      const outputSha256 = sha256(response.raw);
      rawModelOutputSha256s.push(outputSha256);
      await appendJsonl(args.rawOutputs, {
        kind: "model_output",
        document: record.candidate.documentId,
        citation: record.candidate.citation,
        phase: "roster",
        round: attempt,
        provider: "ollama",
        raw_model_output: response.raw,
        output_sha256: outputSha256,
      });
      await appendJsonl(args.progress, {
        kind: "model_output_saved",
        document: record.candidate.documentId,
        citation: record.candidate.citation,
        phase: "roster",
        round: attempt,
        provider: "ollama",
        raw_output_stream: args.rawOutputs,
        output_sha256: outputSha256,
        output_bytes: Buffer.byteLength(response.raw),
      });
      const call = extractToolCall(response.message);
      const assistant = assistantMessage(response.message);
      messages.push(assistant);
      await appendJsonl(args.progress, {
        kind: "model_call",
        document: record.candidate.documentId,
        citation: record.candidate.citation,
        phase: "roster",
        round: attempt,
        provider: "ollama",
        tool_calls: call ? [call.name] : [],
        tool_call: call,
        message_keys: Object.keys(response.message),
        usage: response.usage,
      });
      if (!call) {
        validation = { ok: false, error: "tool_required", next: "Call submit_roster now. No prose." };
        messages.push({ role: "user", content: JSON.stringify(validation) });
      } else if (call.name === "a2aj_lookup") {
        const result = await lookupForModel(record, call.args);
        messages.push({ role: "tool", tool_name: call.name, content: JSON.stringify(result) });
        validation = { ok: false, error: "lookup_completed", next: "Continue reading source, then call submit_roster." };
        await appendJsonl(args.progress, {
          kind: "tool_result",
          document: record.candidate.documentId,
          citation: record.candidate.citation,
          phase: "roster",
          round: attempt,
          tool: call.name,
          tool_args: call.args,
          result_preview: JSON.stringify(result).slice(0, 1_500),
          result_audit: JSON.stringify(result).slice(0, 4_000),
        });
        continue;
      } else if (call.name === "submit_roster") {
        const result = validatePrediction(record, call.args);
        prediction = result.prediction;
        validation = result.validation;
        messages.push({ role: "tool", tool_name: call.name, content: JSON.stringify(validation) });
      } else {
        validation = { ok: false, error: `unknown tool ${call.name}`, next: "Call submit_roster." };
        messages.push({ role: "user", content: JSON.stringify(validation) });
      }
      attempts.push({ attempt, tool: call?.name ?? null, validation });
      await appendJsonl(args.progress, {
        kind: "tool_result",
        document: record.candidate.documentId,
        citation: record.candidate.citation,
        phase: "roster",
        round: attempt,
        tool: call?.name ?? null,
        tool_args: call?.args ?? null,
        result_preview: JSON.stringify(validation).slice(0, 1_500),
        result_audit: JSON.stringify(validation).slice(0, 4_000),
      });
      if (prediction && validation.ok) break;
    }
  }
  const evidence = prediction ? await hydratePrediction(record, prediction) : [];
  const metrics = prediction ? score(prediction, reference, paragraphNumbers(record.paragraphs)) : { reference: null };
  return {
    status: prediction
      ? args.caseTargetMvp && !caseTargetMvpResult?.ok
        ? "accepted_with_target_rejections"
        : args.semanticMvp && !semanticMvpResult?.ok
          ? "accepted_with_semantic_rejections"
          : "accepted"
      : "rejected",
    route: args.provider,
    prediction,
    evidence,
    reference,
    validation,
    metrics,
    attempts,
    raw_model_output_sha256s: rawModelOutputSha256s,
    ...(semanticMvpResult ? { semantic_mvp: semanticMvpResult } : {}),
    ...(caseTargetMvpResult ? { case_target_mvp: caseTargetMvpResult } : {}),
    ...(modelReceipt ? { model_receipt: modelReceipt } : {}),
  };
}

async function mapPool<T, R>(
  items: T[],
  workerCount: number,
  fn: (item: T, index: number) => Promise<R>,
  onResult?: (result: R, index: number) => Promise<void>,
) {
  const results = onResult ? [] : new Array<R>(items.length);
  let next = 0;
  const count = Math.min(Math.max(1, Math.trunc(workerCount)), items.length);
  const worker = async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      const result = await fn(items[index], index);
      if (onResult) await onResult(result, index);
      else results[index] = result;
    }
  };
  await Promise.all(Array.from({ length: count }, () => worker()));
  return results;
}

type LunaCaseConfig = Omit<Parameters<typeof runCase>[0], "record" | "referenceOverride">;
type LunaCaseWork = {
  candidate: Candidate;
  record: CaseRecord | null;
  result: Awaited<ReturnType<typeof runCase>> | null;
  error: string | null;
};

async function dispatchLunaCase(
  candidate: Candidate,
  index: number,
  sampleSize: number,
  config: LunaCaseConfig,
): Promise<LunaCaseWork> {
  console.log(`[${index + 1}/${sampleSize}] ${candidate.citation} (${candidate.documentId})`);
  await appendJsonl(config.progress, {
    kind: "case_started",
    document: candidate.documentId,
    citation: candidate.citation,
    worker_case: 1,
  });
  try {
    const record = await loadCase(candidate);
    if (!record) {
      await appendJsonl(config.progress, {
        kind: "case_finished",
        document: candidate.documentId,
        status: "load_failed",
      });
      console.log("  load_failed");
      return { candidate, record: null, result: null, error: "load_failed" };
    }
    await appendJsonl(config.progress, {
      kind: "case_loaded",
      document: candidate.documentId,
      citation: candidate.citation,
      structure_status: record.source.status,
      paragraph_count: record.paragraphs.length,
      source_sha256: record.sourceSha256,
      deterministic_status: record.deterministic.status,
      deterministic_opinions: record.deterministic.opinions.length,
      needs_llm: record.deterministic.status !== "ready",
      judge_candidates: record.hints.judgeCandidates,
      opinion_candidates: record.hints.opinions.map(({ role, from, to }) => ({ role, from, to })),
      citation_edges: config.semanticMvp
        ? record.citationEdges.map(({ id, citation, start, end, contextSha256 }) => ({ id, citation, start, end, context_sha256: contextSha256 }))
        : [],
      target: config.caseTargetMvp ? record.candidate.target ?? null : null,
      target_occurrence_version: config.caseTargetMvp ? CASE_TARGET_OCCURRENCE_VERSION : null,
      target_occurrences: config.caseTargetMvp ? record.targetOccurrences : [],
      preflight: record.preflight,
    });
    const result = await runCase({ ...config, record, referenceOverride: null });
    await appendJsonl(config.progress, {
      kind: "case_finished",
      document: candidate.documentId,
      status: result.status,
      metrics: result.metrics,
    });
    console.log(`  ${result.status}`);
    return { candidate, record, result, error: null };
  } catch (error) {
    const message = errorMessage(error);
    await appendJsonl(config.progress, {
      kind: "case_failed",
      document: candidate.documentId,
      error: message,
    });
    console.log(`  failed: ${message}`);
    return { candidate, record: null, result: null, error: message };
  }
}

type ReceiptMode = "full" | "compact";

type JudgeCourtServiceReceipt = {
  registry_sha256: string;
  dataset: string;
  decision_date: string | null;
} & (
  | { status: "unavailable"; reason: "prediction_unavailable" | "exact_decision_date_unavailable" }
  | {
      status: "resolved";
      participants: Array<{ displayed_name: string; resolution: ReturnType<JudgeCourtServiceResolver> }>;
      nonparticipants: Array<{ displayed_name: string; resolution: ReturnType<JudgeCourtServiceResolver> }>;
    }
);

function judgeCourtServiceReceipt(
  candidate: Candidate,
  prediction: Prediction | null,
  registry: JudgeRegistryContext | null,
): JudgeCourtServiceReceipt | null {
  if (!registry) return null;
  const base = {
    registry_sha256: registry.sha256,
    dataset: candidate.dataset,
    decision_date: candidate.date,
  };
  if (!prediction) return { ...base, status: "unavailable", reason: "prediction_unavailable" };
  if (!candidate.date || !/^\d{4}-\d{2}-\d{2}$/u.test(candidate.date)) {
    return { ...base, status: "unavailable", reason: "exact_decision_date_unavailable" };
  }
  const resolve = (name: string) => ({
    displayed_name: name,
    resolution: registry.resolver({
      displayedName: name,
      dataset: candidate.dataset,
      decisionDate: candidate.date!,
    }),
  });
  return {
    ...base,
    status: "resolved",
    participants: prediction.participants.map(({ name }) => resolve(name)),
    nonparticipants: prediction.nonparticipants.map(({ name }) => resolve(name)),
  };
}

function fullCaseReceipt(
  candidate: Candidate,
  record: CaseRecord,
  result: Awaited<ReturnType<typeof runCase>>,
  registry: JudgeRegistryContext | null = null,
) {
  return {
    source: {
      document_id: candidate.documentId,
      dataset: candidate.dataset,
      citation: candidate.citation,
      name: candidate.name,
      date: candidate.date,
      source_sha256: record.sourceSha256,
      source_evidence_id: record.sourceEvidence.evidence_id,
    },
    structure: {
      status: record.source.status,
      paragraph_count: record.paragraphs.length,
      paragraph_index: paragraphIndex(record.paragraphs),
      source_chars: record.source.text.length,
    },
    deterministic: record.deterministic,
    mechanical: record.hints,
    preflight: record.preflight,
    citation_edges: record.citationEdges,
    target: candidate.target ? {
      document_id: candidate.target.documentId,
      citation: candidate.target.citation,
      citation_aliases: candidate.target.citationAliases,
      name: candidate.target.name,
      occurrence_version: CASE_TARGET_OCCURRENCE_VERSION,
      occurrences: record.targetOccurrences,
    } : null,
    judge_court_service: judgeCourtServiceReceipt(candidate, result.prediction, registry),
    ...result,
  };
}

function compactModelReceipt(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const cli = row.cli && typeof row.cli === "object" && !Array.isArray(row.cli)
    ? row.cli as Record<string, unknown>
    : null;
  const transport = row.transport && typeof row.transport === "object" && !Array.isArray(row.transport)
    ? row.transport as Record<string, unknown>
    : null;
  return {
    runner: row.runner ?? null,
    prompt_version: row.prompt_version ?? null,
    validator_version: row.validator_version ?? null,
    prompt_sha256: row.prompt_sha256 ?? null,
    prompt_chars: row.prompt_chars ?? null,
    utf8_replacement_count: row.utf8_replacement_count ?? null,
    output_sha256: row.output_sha256 ?? null,
    stdout_sha256: row.stdout_sha256 ?? null,
    stderr_sha256: row.stderr_sha256 ?? null,
    stderr_bytes: row.stderr_bytes ?? null,
    stderr_tail: typeof row.stderr === "string" && row.stderr ? row.stderr.slice(-4_000) : null,
    return_code: row.return_code ?? null,
    error: row.error ?? null,
    elapsed_seconds: row.elapsed_seconds ?? null,
    event_count: row.event_count ?? null,
    transport_retries: row.transport_retries ?? 0,
    thread_id: row.thread_id ?? null,
    response_id: row.response_id ?? null,
    usage: row.usage ?? null,
    transport,
    cli: cli ? {
      model: cli.model ?? null,
      effort: cli.effort ?? null,
      transport: cli.transport ?? null,
      endpoint: cli.endpoint ?? null,
      auth_mode: cli.auth_mode ?? null,
      isolated_process: cli.isolated_process ?? null,
      output_schema: cli.output_schema ?? null,
    } : null,
  };
}

function compactCaseReceipt(
  full: Record<string, unknown>,
) {
  const source = full.source as Record<string, unknown> | undefined;
  const structure = full.structure as Record<string, unknown> | undefined;
  const deterministic = full.deterministic as Record<string, unknown> | undefined;
  return {
    source: source ? {
      document_id: source.document_id ?? null,
      dataset: source.dataset ?? null,
      citation: source.citation ?? null,
      name: source.name ?? null,
      date: source.date ?? null,
      source_sha256: source.source_sha256 ?? null,
      source_evidence_id: source.source_evidence_id ?? null,
    } : null,
    structure: structure ? {
      status: structure.status ?? null,
      paragraph_count: structure.paragraph_count ?? null,
      source_chars: structure.source_chars ?? null,
    } : null,
    deterministic: deterministic ? {
      status: deterministic.status ?? null,
      panel: deterministic.panel ?? [],
      nonparticipants: deterministic.nonparticipants ?? [],
      opinions: deterministic.opinions ?? [],
      judges: deterministic.judges ?? [],
      refusals: deterministic.refusals ?? [],
    } : null,
    judge_court_service: full.judge_court_service ?? null,
    semantic_mvp: full.semantic_mvp ?? null,
    target: full.target ?? null,
    case_target_mvp: full.case_target_mvp ?? null,
    status: full.status ?? null,
    route: full.route ?? null,
    prediction: full.prediction ?? null,
    raw_model_output_sha256s: Array.isArray(full.raw_model_output_sha256s) ? full.raw_model_output_sha256s : [],
    evidence: full.evidence ?? [],
    reference: full.reference ?? null,
    validation: full.validation ?? null,
    metrics: full.metrics ?? null,
    model_receipt: compactModelReceipt(full.model_receipt),
  };
}

async function readJsonl(file: string, visit: (event: Record<string, unknown>) => void) {
  if (!existsSync(file)) return;
  const lines = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try { visit(JSON.parse(line) as Record<string, unknown>); } catch { /* resume retries a truncated final line */ }
  }
}

async function readReceiptEvents(file: string, visit: (event: Record<string, unknown>) => void) {
  if (!file.toLocaleLowerCase().endsWith(".json")) {
    await readJsonl(file, visit);
    return;
  }
  const value = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  const receipts = Array.isArray(value.receipts) ? value.receipts : [];
  receipts.forEach((receipt, index) => {
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return;
    const row = receipt as Record<string, unknown>;
    const source = row.source && typeof row.source === "object" && !Array.isArray(row.source)
      ? row.source as Record<string, unknown>
      : {};
    visit({ kind: "case_receipt", index, document: source.document_id ?? null, receipt: row });
  });
}

async function readReceiptStreamIds(file: string) {
  const ids = new Set<number>();
  await readJsonl(file, (event) => {
    if (event.kind !== "case_receipt") return;
    const receipt = event.receipt as Record<string, unknown> | undefined;
    const source = receipt?.source as Record<string, unknown> | undefined;
    const documentId = Number(source?.document_id ?? event.document);
    if (Number.isSafeInteger(documentId) && documentId > 0) ids.add(documentId);
  });
  return ids;
}

async function run(args: Args) {
  const seed = Number.isFinite(Number(args.seed)) ? Number(args.seed) : randomInt(0, 2 ** 31 - 1);
  const requestedSampleSize = Math.max(1, parseIntFlag(args, "sample-size", 1));
  const scope = flag(args, "scope", "ALL");
  const provider = flag(args, "provider", "ollama") as Provider;
  if (provider !== "ollama" && provider !== "luna" && provider !== "dry")
    throw new Error("--provider must be ollama, luna, or dry");
  const semanticMvp = args["semantic-mvp"] === true || String(args["semantic-mvp"] ?? "").toLocaleLowerCase() === "true";
  const caseTargetMvp = args["case-target-mvp"] === true || String(args["case-target-mvp"] ?? "").toLocaleLowerCase() === "true";
  if (semanticMvp && caseTargetMvp) throw new Error("--semantic-mvp and --case-target-mvp are mutually exclusive");
  if (semanticMvp && provider !== "luna") throw new Error("--semantic-mvp requires --provider luna");
  if (caseTargetMvp && provider !== "luna") throw new Error("--case-target-mvp requires --provider luna");
  if (caseTargetMvp && !flag(args, "pair-file", "")) throw new Error("--case-target-mvp requires --pair-file");
  const requestedCaseTargetPrompt = flag(args, "case-target-prompt", "nested");
  if (!(requestedCaseTargetPrompt in CASE_TARGET_MVP_PROMPTS)) {
    throw new Error(`--case-target-prompt must be ${Object.keys(CASE_TARGET_MVP_PROMPTS).join(", ")}`);
  }
  const caseTargetPrompt = requestedCaseTargetPrompt as CaseTargetPromptVariant;
  const model = flag(args, "model", provider === "luna" ? DEFAULT_CODEX_MODEL : DEFAULT_MODEL);
  const richMvp = semanticMvp || caseTargetMvp;
  const effort = flag(args, "effort", richMvp ? "max" : provider === "luna" ? DEFAULT_CODEX_EFFORT : "none");
  if (richMvp && !MVP_CODEX_MODELS.has(model)) {
    throw new Error(`MVP modes require --model ${[...MVP_CODEX_MODELS].join(" or ")}`);
  }
  if (richMvp && effort !== "max") throw new Error("MVP modes require --effort max");
  const activePromptVersion = caseTargetMvp
    ? CASE_TARGET_MVP_PROMPTS[caseTargetPrompt].version
    : semanticMvp
      ? SEMANTIC_MVP_PROMPT_VERSION
      : CODEX_PROMPT_VERSION;
  const activeValidatorVersion = caseTargetMvp
    ? CASE_TARGET_MVP_VALIDATOR_VERSION
    : semanticMvp
      ? SEMANTIC_MVP_VALIDATOR_VERSION
      : VALIDATOR_VERSION;
  const activeMode = caseTargetMvp ? "case_target_mvp" : semanticMvp ? "combined_semantic_mvp" : "opinion_roster";
  const activeResponseSchema = caseTargetMvp
    ? CASE_TARGET_MVP_RESPONSES_SCHEMA
    : semanticMvp
      ? SEMANTIC_MVP_RESPONSES_SCHEMA
      : GPT_RESPONSES_SCHEMA;
  const runId = flag(args, "run-id", provider === "dry" ? `a2aj-roster-dry-${seed}` : `a2aj-roster-${provider}-${model.replaceAll(":", "-")}-${seed}`);
  const output = flag(args, "out", path.join(RUN_DIR, `${runId}.json`));
  const progress = output.endsWith(".json")
    ? output.replace(/\.json$/u, ".progress.jsonl")
    : `${output}.progress.jsonl`;
  const receiptStream = output.endsWith(".json")
    ? output.replace(/\.json$/u, ".receipts.jsonl")
    : `${output}.receipts.jsonl`;
  const rawOutputStream = output.endsWith(".json")
    ? output.replace(/\.json$/u, ".outputs.jsonl")
    : `${output}.outputs.jsonl`;
  const requestedCallLedger = flag(args, "call-ledger", "");
  const callLedger = requestedCallLedger ? path.resolve(requestedCallLedger) : undefined;
  const callBudget = callLedger ? Math.max(1, parseIntFlag(args, "call-budget", 15_000)) : null;
  const requestedReceiptMode = flag(args, "receipt-mode", "compact").toLocaleLowerCase();
  if (requestedReceiptMode !== "full" && requestedReceiptMode !== "compact") {
    throw new Error("--receipt-mode must be full or compact");
  }
  const receiptMode = requestedReceiptMode as ReceiptMode;
  const resume = args.resume === true || String(args.resume ?? "").toLocaleLowerCase() === "true";
  const forceLlm = richMvp || args.force === true || String(args.force ?? "").toLocaleLowerCase() === "true";
  const sidecar = flag(args, "sidecar-db", DEFAULT_SIDECAR);
  const numCtx = parseIntFlag(args, "num-ctx", DEFAULT_NUM_CTX);
  const numPredict = parseIntFlag(args, "num-predict", DEFAULT_NUM_PREDICT);
  const packetChars = parseIntFlag(args, "packet-chars", 24_000);
  const temperature = Number(args.temperature ?? 0);
  const baseUrl = flag(args, "base-url", DEFAULT_BASE_URL);
  const hostHeader = flag(args, "host-header", process.env.OLLAMA_HOST_HEADER?.trim() || "");
  const maxAttempts = Math.max(1, parseIntFlag(args, "max-attempts", MAX_ATTEMPTS));
  const timeoutSeconds = Math.max(1, parseIntFlag(args, "timeout-seconds", 900));
  const workers = provider === "luna"
    ? Math.min(10, Math.max(1, parseIntFlag(args, "workers", richMvp ? 5 : 8)))
    : 1;
  // Fail before candidate selection or output mutation unless the exact
  // ChatGPT-subscription endpoint and auth mode are proven.
  const codexSubscription = provider === "luna" ? codexSubscriptionPreflight() : null;
  // Load and validate once in the parent before candidate selection or output mutation.
  const judgeRegistry = await loadJudgeRegistry(args);
  const selected = await selectedRunCandidates(args, seed, requestedSampleSize, scope);
  const completedIds = resume ? await readReceiptStreamIds(receiptStream) : new Set<number>();
  if (resume && receiptMode !== "compact") {
    throw new Error("--resume requires --receipt-mode compact");
  }
  const candidates = selected.filter((candidate) => !completedIds.has(candidate.documentId));
  const sampleSize = candidates.length;
  const cohortSize = selected.length;
  const callsUsedBeforeRun = callLedger ? await modelCallLedgerUsage(callLedger) : 0;
  const plannedAttemptCeiling = sampleSize * 2;
  if (callLedger && callBudget !== null && callsUsedBeforeRun + plannedAttemptCeiling > callBudget) {
    throw new Error(`call budget exceeded: ${callsUsedBeforeRun} used + ${plannedAttemptCeiling} maximum attempts planned > ${callBudget}`);
  }
  const selection = flag(args, "document-ids", "")
    ? { kind: "document_ids", value: selected.map((candidate) => candidate.documentId) }
    : flag(args, "case-file", "")
      ? { kind: "case_file", value: path.resolve(flag(args, "case-file", "")), document_ids: selected.map((candidate) => candidate.documentId) }
      : flag(args, "pair-file", "")
        ? {
            kind: "case_target_pairs",
            value: path.resolve(flag(args, "pair-file", "")),
            pairs: selected.map((candidate) => ({ document_id: candidate.documentId, target: candidate.target })),
          }
      : {
          kind: "seeded_sample",
          seed,
          scope,
          requested_sample_size: requestedSampleSize,
          order: "seeded_pseudorandom_draw",
          algorithm: scope.toLocaleUpperCase() === "ALL" ? RANDOM_SELECTION_VERSION : "eligible_offset_draw_v1",
        };
  await mkdir(path.dirname(progress), { recursive: true });
  if (callLedger) await mkdir(path.dirname(callLedger), { recursive: true });
  if (callLedger) await appendJsonl(callLedger, {
    kind: "call_budget_checked",
    run_id: runId,
    budget: callBudget,
    attempted_before_run: callsUsedBeforeRun,
    planned_calls: sampleSize,
    planned_attempt_ceiling: plannedAttemptCeiling,
    remaining_after_attempt_ceiling: Number(callBudget) - callsUsedBeforeRun - plannedAttemptCeiling,
  });
  if (!resume) {
    await writeFile(progress, "", "utf8");
    await writeFile(receiptStream, "", "utf8");
    await writeFile(rawOutputStream, "", "utf8");
    await appendJsonl(receiptStream, {
      kind: "receipt_stream_started",
      run_id: runId,
      raw_output_stream: rawOutputStream,
      call_ledger: callLedger ?? null,
      call_budget: callBudget,
      call_budget_attempted_before_run: callsUsedBeforeRun,
    });
  }
  const database = await initSidecar(sidecar);
  const receipts: unknown[] = [];
  let processedCount = completedIds.size;
  try {
    database.prepare("INSERT OR REPLACE INTO opinion_run VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
      runId, now(), seed, cohortSize, scope, provider, model,
      effort, numCtx, numPredict, provider === "luna" ? activePromptVersion : PROMPT_VERSION,
    );
    await appendJsonl(progress, {
      kind: "run_started",
      run_id: runId,
      arm: "a2aj_decision_roster",
      provider,
      model,
      effort,
      num_ctx: numCtx,
      sample_size: cohortSize,
      pending_sample_size: sampleSize,
      resumed: resume,
      already_completed: completedIds.size,
      seed,
      scope,
      workers,
      dispatch: provider === "luna" ? "one-case-per-isolated-codex-subscription-process" : "serial",
      routing: richMvp
        ? "luna-max-all; deterministic-parallel-observation"
        : provider === "luna" && !forceLlm
          ? "deterministic-ready-local; unresolved-to-luna"
          : "forced",
      mode: activeMode,
      case_target_prompt: caseTargetMvp ? caseTargetPrompt : null,
      receipt_mode: receiptMode,
      receipt_stream: receiptStream,
      raw_output_stream: rawOutputStream,
      call_ledger: callLedger ?? null,
      selection,
      codex_subscription: codexSubscription,
      prompt_version: provider === "luna" ? activePromptVersion : PROMPT_VERSION,
      validator_version: activeValidatorVersion,
      target_occurrence_version: caseTargetMvp ? CASE_TARGET_OCCURRENCE_VERSION : null,
      deterministic_version: DETERMINISTIC_VERSION,
      judge_service_file: judgeRegistry?.absolutePath ?? null,
      judge_service_sha256: judgeRegistry?.sha256 ?? null,
    });
    if (provider === "luna") {
      const config: LunaCaseConfig = {
        runId,
        provider,
        model,
        effort,
        timeoutSeconds,
        baseUrl,
        hostHeader,
        numCtx,
        numPredict,
        temperature,
        packetChars,
        progress,
        rawOutputs: rawOutputStream,
        callLedger,
        maxAttempts,
        forceLlm,
        semanticMvp,
        caseTargetMvp,
        caseTargetPrompt,
      };
      await mapPool(
        candidates,
        workers,
        (candidate, index) => dispatchLunaCase(candidate, index, sampleSize, config),
        async (item, index) => {
          let receipt: Record<string, unknown>;
          if (!item.record || !item.result) {
            receipt = {
              source: {
                document_id: item.candidate.documentId,
                dataset: item.candidate.dataset,
                citation: item.candidate.citation,
                name: item.candidate.name,
                date: item.candidate.date,
              },
              target: item.candidate.target ?? null,
              status: item.error ?? "case_failed",
              judge_court_service: judgeCourtServiceReceipt(item.candidate, null, judgeRegistry),
            };
          } else {
            const { candidate, record, result } = item;
            saveCase(database, runId, record, result.prediction, result.evidence, result.reference, result.validation, result.metrics, result.status, result.route ?? provider);
            receipt = fullCaseReceipt(candidate, record, result, judgeRegistry);
          }
          const persisted = receiptMode === "compact" ? compactCaseReceipt(receipt) : receipt;
          if (receiptMode === "full") receipts[index] = persisted;
          processedCount += 1;
          await appendJsonl(receiptStream, {
            kind: "case_receipt",
            run_id: runId,
            index,
            document: item.candidate.documentId,
            receipt: persisted,
          });
        },
      );
    } else {
      for (const [index, candidate] of candidates.entries()) {
        console.log(`[${index + 1}/${sampleSize}] ${candidate.citation} (${candidate.documentId})`);
        await appendJsonl(progress, { kind: "case_started", document: candidate.documentId, citation: candidate.citation });
        const record = await loadCase(candidate);
        if (!record) {
          const failed = {
            source: {
              document_id: candidate.documentId,
              dataset: candidate.dataset,
              citation: candidate.citation,
              name: candidate.name,
              date: candidate.date,
            },
            target: candidate.target ?? null,
            status: "load_failed",
            judge_court_service: judgeCourtServiceReceipt(candidate, null, judgeRegistry),
          };
          const persisted = receiptMode === "compact" ? compactCaseReceipt(failed) : failed;
          if (receiptMode === "full") receipts.push(persisted);
          processedCount += 1;
          await appendJsonl(receiptStream, {
            kind: "case_receipt",
            run_id: runId,
            index,
            document: candidate.documentId,
            receipt: persisted,
          });
          await appendJsonl(progress, { kind: "case_finished", document: candidate.documentId, status: "load_failed" });
          console.log(`  load_failed`);
          continue;
        }
        await appendJsonl(progress, {
          kind: "case_loaded",
          document: candidate.documentId,
          citation: candidate.citation,
          structure_status: record.source.status,
          paragraph_count: record.paragraphs.length,
          source_sha256: record.sourceSha256,
          deterministic_status: record.deterministic.status,
          deterministic_opinions: record.deterministic.opinions.length,
          needs_llm: record.deterministic.status !== "ready",
          judge_candidates: record.hints.judgeCandidates,
          opinion_candidates: record.hints.opinions.map(({ role, from, to }) => ({ role, from, to })),
          preflight: record.preflight,
        });
        const result = await runCase({
          record,
          runId,
          provider,
          model,
          effort,
          timeoutSeconds,
          baseUrl,
          hostHeader,
          numCtx,
          numPredict,
          temperature,
          packetChars,
          progress,
          rawOutputs: rawOutputStream,
          callLedger,
          maxAttempts,
          forceLlm,
          semanticMvp,
          caseTargetMvp,
          caseTargetPrompt,
          referenceOverride: await humanReference(database, record),
        });
        saveCase(database, runId, record, result.prediction, result.evidence, result.reference, result.validation, result.metrics, result.status, result.route ?? provider);
        const full = fullCaseReceipt(candidate, record, result, judgeRegistry);
        const persisted = receiptMode === "compact" ? compactCaseReceipt(full) : full;
        if (receiptMode === "full") receipts.push(persisted);
        processedCount += 1;
        await appendJsonl(receiptStream, {
          kind: "case_receipt",
          run_id: runId,
          index,
          document: candidate.documentId,
          receipt: persisted,
        });
        await appendJsonl(progress, { kind: "case_finished", document: candidate.documentId, status: result.status, metrics: result.metrics });
        console.log(`  ${result.status}`);
      }
    }
    const receipt = {
      run_id: runId,
      created_utc: now(),
      status: "finished",
      seed,
      sample_size: cohortSize,
      processed_cases: processedCount,
      scope,
      provider,
      model,
      effort,
      num_ctx: numCtx,
      num_predict: numPredict,
      workers,
      dispatch: provider === "luna" ? "one-case-per-isolated-codex-subscription-process" : "serial",
      routing: richMvp
        ? "luna-max-all; deterministic-parallel-observation"
        : provider === "luna" && !forceLlm
          ? "deterministic-ready-local; unresolved-to-luna"
          : "forced",
      mode: activeMode,
      case_target_prompt: caseTargetMvp ? caseTargetPrompt : null,
      prompt_version: provider === "luna" ? activePromptVersion : PROMPT_VERSION,
      validator_version: activeValidatorVersion,
      target_occurrence_version: caseTargetMvp ? CASE_TARGET_OCCURRENCE_VERSION : null,
      deterministic_version: DETERMINISTIC_VERSION,
      judge_service_file: judgeRegistry?.absolutePath ?? null,
      judge_service_sha256: judgeRegistry?.sha256 ?? null,
      response_schema: provider === "luna" ? activeResponseSchema : null,
      receipt_mode: receiptMode,
      receipt_stream: receiptStream,
      raw_output_stream: rawOutputStream,
      call_ledger: callLedger ?? null,
      resumed: resume,
      selection,
      codex_subscription: codexSubscription,
      sidecar_db: sidecar,
      base_url: baseUrl,
      host_header: hostHeader || null,
      receipts: receiptMode === "compact" ? [] : receipts,
    };
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    await appendJsonl(progress, { kind: "run_finished", run_id: runId, ok: true, cases: processedCount, output, receipt_stream: receiptStream });
    database.close();
    console.log(`wrote ${output}`);
    console.log(`progress ${progress}`);
    console.log(`sidecar ${sidecar}`);
  } catch (error) {
    const message = errorMessage(error);
    try { database.close(); } catch { /* already closed */ }
    const receipt = {
      run_id: runId,
      created_utc: now(),
      status: "failed",
      error: message,
      seed,
      sample_size: cohortSize,
      processed_cases: processedCount,
      scope,
      provider,
      model,
      effort,
      num_ctx: numCtx,
      num_predict: numPredict,
      workers,
      dispatch: provider === "luna" ? "one-case-per-isolated-codex-subscription-process" : "serial",
      routing: richMvp
        ? "luna-max-all; deterministic-parallel-observation"
        : provider === "luna" && !forceLlm
          ? "deterministic-ready-local; unresolved-to-luna"
          : "forced",
      mode: activeMode,
      case_target_prompt: caseTargetMvp ? caseTargetPrompt : null,
      prompt_version: provider === "luna" ? activePromptVersion : PROMPT_VERSION,
      validator_version: activeValidatorVersion,
      target_occurrence_version: caseTargetMvp ? CASE_TARGET_OCCURRENCE_VERSION : null,
      deterministic_version: DETERMINISTIC_VERSION,
      judge_service_file: judgeRegistry?.absolutePath ?? null,
      judge_service_sha256: judgeRegistry?.sha256 ?? null,
      response_schema: provider === "luna" ? activeResponseSchema : null,
      receipt_mode: receiptMode,
      receipt_stream: receiptStream,
      raw_output_stream: rawOutputStream,
      call_ledger: callLedger ?? null,
      resumed: resume,
      selection,
      codex_subscription: codexSubscription,
      sidecar_db: sidecar,
      base_url: baseUrl,
      host_header: hostHeader || null,
      receipts: receiptMode === "compact" ? [] : receipts,
    };
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    await appendJsonl(progress, { kind: "run_finished", run_id: runId, ok: false, error: message, output });
    throw error;
  }
}

type LegacySignals = {
  status: string;
  classes: string[];
  one_paragraph_secondary_ranges: number;
};

function legacySignals(receipt: Record<string, unknown>): LegacySignals {
  const status = String(receipt.status ?? "unknown");
  const prediction = receipt.prediction && typeof receipt.prediction === "object" && !Array.isArray(receipt.prediction)
    ? receipt.prediction as Record<string, unknown>
    : {};
  const rawPeople = Array.isArray(prediction.participants) ? prediction.participants : prediction.judges;
  const judges = Array.isArray(rawPeople)
    ? rawPeople.filter((judge): judge is Record<string, unknown> => Boolean(judge) && typeof judge === "object" && !Array.isArray(judge))
    : [];
  const opinions = Array.isArray(prediction.opinions)
    ? prediction.opinions.filter((opinion): opinion is Record<string, unknown> => Boolean(opinion) && typeof opinion === "object" && !Array.isArray(opinion))
    : [];
  const spans = prediction.spans && typeof prediction.spans === "object" && !Array.isArray(prediction.spans)
    ? prediction.spans as Record<string, unknown>
    : {};
  const ranges = (role: string) => Array.isArray(spans[role])
    ? (spans[role] as unknown[]).flatMap((range) => {
        if (Array.isArray(range) && range.length === 2) return [{ from: Number(range[0]), to: Number(range[1]) }];
        if (range && typeof range === "object" && !Array.isArray(range)) {
          const row = range as Record<string, unknown>;
          return [{ from: Number(row.from), to: Number(row.to) }];
        }
        return [];
      }).filter((range) => Number.isInteger(range.from) && Number.isInteger(range.to))
    : [];
  const secondary = [...ranges("minority"), ...ranges("concurring")];
  const secondaryJudge = judges.some((judge) => ["minority", "concurring"].includes(compatibleJudgeRole(judge, opinions)));
  const classes: string[] = [];
  if (status === "structure_unavailable") classes.push("paragraph_structure_blocked_model");
  if (judges.length && judges.every((judge) => compatibleJudgeRole(judge, opinions) === "unknown")) classes.push("all_judges_unknown");
  if (secondaryJudge && !secondary.length) classes.push("secondary_judge_without_secondary_opinion");
  const oneParagraph = secondary.filter((range) => range.from === range.to).length;
  if (oneParagraph) classes.push("one_paragraph_secondary_opinion");
  if (status === "rejected") classes.push("schema_rejected");
  return { status, classes, one_paragraph_secondary_ranges: oneParagraph };
}

function llmReasons(record: DeterministicAuditRecord) {
  if (record.deterministic.status === "ready") return [];
  const reasons: string[] = [];
  if (!record.deterministic.opinions.length) reasons.push("no_substantive_opinion_boundary");
  if (record.deterministic.opinions.some((opinion) => !opinion.authors.length)) reasons.push("opinion_author_unresolved");
  if (record.deterministic.opinions.some((opinion) => opinion.alignment === "unknown")) reasons.push("opinion_alignment_unresolved");
  if (record.deterministic.judges.some((judge) => judge.resultSide === "unknown")) reasons.push("judge_vote_unresolved");
  if (!record.paragraphs.length) reasons.push("no_paragraph_structure");
  if (!reasons.length) reasons.push("deterministic_evidence_conflict");
  return reasons;
}

type AuditCounts = {
  total: number;
  load_failed: number;
  ready: number;
  unresolved: number;
  unavailable: number;
  needs_llm: number;
  oracle_ready: number;
  oracle_span_exact: number;
  by_dataset: Record<string, AuditBreakdown>;
  legacy_classes: Record<string, number>;
  legacy_class_routing: Record<string, AuditBreakdown>;
  llm_reasons: Record<string, number>;
  receipt_cases: number;
  receipt_accepted: number;
  receipt_source_hash_match: number;
  receipt_oracle_ready: number;
  receipt_oracle_text_exact: number;
  receipt_oracle_paragraph_exact: number;
  receipt_oracle_judges_exact: number;
};

type AuditBreakdown = {
  total: number;
  load_failed: number;
  ready: number;
  unresolved: number;
  unavailable: number;
  needs_llm: number;
};

function emptyAuditBreakdown(): AuditBreakdown {
  return { total: 0, load_failed: 0, ready: 0, unresolved: 0, unavailable: 0, needs_llm: 0 };
}

function emptyAuditCounts(): AuditCounts {
  return {
    total: 0,
    load_failed: 0,
    ready: 0,
    unresolved: 0,
    unavailable: 0,
    needs_llm: 0,
    oracle_ready: 0,
    oracle_span_exact: 0,
    by_dataset: {},
    legacy_classes: {},
    legacy_class_routing: {},
    llm_reasons: {},
    receipt_cases: 0,
    receipt_accepted: 0,
    receipt_source_hash_match: 0,
    receipt_oracle_ready: 0,
    receipt_oracle_text_exact: 0,
    receipt_oracle_paragraph_exact: 0,
    receipt_oracle_judges_exact: 0,
  };
}

function countBreakdown(target: AuditBreakdown, status: string, needsLlm: boolean) {
  target.total += 1;
  if (status === "load_failed") target.load_failed += 1;
  else if (status === "ready" || status === "unresolved" || status === "unavailable") target[status] += 1;
  if (needsLlm) target.needs_llm += 1;
}

function countAudit(counts: AuditCounts, receipt: Record<string, unknown>) {
  counts.total += 1;
  const source = receipt.source && typeof receipt.source === "object" ? receipt.source as Record<string, unknown> : {};
  const dataset = String(source.dataset ?? "unknown");
  const datasetCounts = counts.by_dataset[dataset] ?? emptyAuditBreakdown();
  counts.by_dataset[dataset] = datasetCounts;
  if (receipt.status === "load_failed") {
    counts.load_failed += 1;
    countBreakdown(datasetCounts, "load_failed", false);
    return;
  }
  const deterministic = receipt.deterministic && typeof receipt.deterministic === "object"
    ? receipt.deterministic as Record<string, unknown>
    : {};
  const status = String(deterministic.status ?? "unavailable") as "ready" | "unresolved" | "unavailable";
  if (status in counts) counts[status] += 1;
  const routing = receipt.routing && typeof receipt.routing === "object" ? receipt.routing as Record<string, unknown> : {};
  const needsLlm = routing.needs_llm === true;
  if (needsLlm) counts.needs_llm += 1;
  countBreakdown(datasetCounts, status, needsLlm);
  for (const reason of Array.isArray(routing.reasons) ? routing.reasons : []) {
    const key = String(reason);
    counts.llm_reasons[key] = (counts.llm_reasons[key] ?? 0) + 1;
  }
  const legacy = receipt.legacy && typeof receipt.legacy === "object" ? receipt.legacy as Record<string, unknown> : {};
  for (const name of Array.isArray(legacy.classes) ? legacy.classes : []) {
    const key = String(name);
    counts.legacy_classes[key] = (counts.legacy_classes[key] ?? 0) + 1;
    const classCounts = counts.legacy_class_routing[key] ?? emptyAuditBreakdown();
    counts.legacy_class_routing[key] = classCounts;
    countBreakdown(classCounts, status, needsLlm);
  }
  const oracle = receipt.oracle && typeof receipt.oracle === "object" ? receipt.oracle as Record<string, unknown> : {};
  if (oracle.status === "ready") counts.oracle_ready += 1;
  if (oracle.span_exact === true) counts.oracle_span_exact += 1;
  const comparison = receipt.receipt_comparison && typeof receipt.receipt_comparison === "object"
    ? receipt.receipt_comparison as Record<string, unknown>
    : null;
  if (comparison) {
    counts.receipt_cases += 1;
    if (comparison.receipt_status === "accepted") counts.receipt_accepted += 1;
    if (comparison.source_hash_match === true) counts.receipt_source_hash_match += 1;
    if (comparison.oracle_ready === true) counts.receipt_oracle_ready += 1;
    if (comparison.text_exact === true) counts.receipt_oracle_text_exact += 1;
    if (comparison.paragraph_exact === true) counts.receipt_oracle_paragraph_exact += 1;
    if (comparison.judges_exact === true) counts.receipt_oracle_judges_exact += 1;
  }
}

function mergeAuditCounts(target: AuditCounts, source: AuditCounts) {
  const totals = [
    "total", "load_failed", "ready", "unresolved", "unavailable", "needs_llm",
    "oracle_ready", "oracle_span_exact", "receipt_cases", "receipt_accepted",
    "receipt_source_hash_match", "receipt_oracle_ready", "receipt_oracle_text_exact",
    "receipt_oracle_paragraph_exact", "receipt_oracle_judges_exact",
  ] as const;
  for (const key of totals) target[key] += source[key];
  for (const [key, value] of Object.entries(source.llm_reasons)) {
    target.llm_reasons[key] = (target.llm_reasons[key] ?? 0) + value;
  }
  for (const [key, value] of Object.entries(source.legacy_classes)) {
    target.legacy_classes[key] = (target.legacy_classes[key] ?? 0) + value;
  }
  for (const [key, value] of Object.entries(source.by_dataset)) {
    const out = target.by_dataset[key] ?? emptyAuditBreakdown();
    target.by_dataset[key] = out;
    for (const field of ["total", "load_failed", "ready", "unresolved", "unavailable", "needs_llm"] as const) {
      out[field] += value[field];
    }
  }
  for (const [key, value] of Object.entries(source.legacy_class_routing)) {
    const out = target.legacy_class_routing[key] ?? emptyAuditBreakdown();
    target.legacy_class_routing[key] = out;
    for (const field of ["total", "load_failed", "ready", "unresolved", "unavailable", "needs_llm"] as const) {
      out[field] += value[field];
    }
  }
}

function opinionBoundaryKeys(prediction: Record<string, unknown> | null) {
  if (!prediction || !Array.isArray(prediction.opinions)) return null;
  const keys: string[] = [];
  for (const raw of prediction.opinions) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const opinion = raw as Record<string, unknown>;
    const start = Number(opinion.start);
    const end = Number(opinion.end_exclusive);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
    const position = RESULT_POSITIONS.includes(opinion.result_position as ResultPosition)
      ? opinion.result_position as ResultPosition
      : OPINION_ALIGNMENTS.includes(opinion.alignment as OpinionAlignment)
        ? resultPositionFromAlignment(opinion.alignment as OpinionAlignment)
        : "unclear";
    keys.push(`${start}|${end}|${position}|${String(opinion.text_sha256 ?? "")}`);
  }
  return keys.sort();
}

function judgeVoteKeys(prediction: Record<string, unknown> | null) {
  const rawPeople = prediction && (Array.isArray(prediction.participants) ? prediction.participants : prediction.judges);
  if (!Array.isArray(rawPeople)) return null;
  return rawPeople.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const judge = raw as Record<string, unknown>;
    const links = Array.isArray(judge.opinion_links)
      ? judge.opinion_links.filter((link): link is Record<string, unknown> => Boolean(link) && typeof link === "object" && !Array.isArray(link))
      : [];
    const ids = links.length
      ? links.map((link) => String(link.opinion_id)).sort()
      : Array.isArray(judge.opinion_ids) ? judge.opinion_ids.map(String).sort() : [];
    const side = RESULT_POSITIONS.includes(judge.result_position as ResultPosition)
      ? resultSideFromPosition(judge.result_position as ResultPosition)
      : String(judge.result_side ?? judge.role ?? "unknown");
    const relationship = judge.result_only === true
      ? "concurs_in_result_only"
      : links.some((link) => link.relation === "authors")
        ? "authors"
        : links.some((link) => link.relation === "joins_in_part")
          ? "mixed"
          : links.length ? "joins_reasons" : String(judge.relationship ?? "unknown");
    return [`${nameKey(String(judge.name ?? ""))}|${side}|${relationship}|${ids.join(",")}`];
  }).sort();
}

function frozenReceiptComparison(
  record: DeterministicAuditRecord,
  frozen: Record<string, unknown> | undefined,
  oraclePrediction: Prediction | null,
) {
  if (!frozen) return null;
  const frozenSource = frozen.source && typeof frozen.source === "object" && !Array.isArray(frozen.source)
    ? frozen.source as Record<string, unknown>
    : {};
  const modelPrediction = predictionFromReceipt(frozen);
  const oracleRecord = oraclePrediction as unknown as Record<string, unknown> | null;
  const modelBoundaries = opinionBoundaryKeys(modelPrediction);
  const oracleBoundaries = opinionBoundaryKeys(oracleRecord);
  const available = paragraphNumbers(record.paragraphs);
  const modelRoles = predictionRoleMap(modelPrediction, available);
  const oracleRoles = predictionRoleMap(oracleRecord, available);
  const modelJudges = judgeVoteKeys(modelPrediction);
  const oracleJudges = judgeVoteKeys(oracleRecord);
  return {
    receipt_status: String(frozen.status ?? "unknown"),
    source_hash_match: typeof frozenSource.source_sha256 === "string"
      ? frozenSource.source_sha256 === record.sourceSha256
      : null,
    oracle_ready: Boolean(oraclePrediction),
    text_exact: modelBoundaries && oracleBoundaries
      ? JSON.stringify(modelBoundaries) === JSON.stringify(oracleBoundaries)
      : null,
    paragraph_exact: modelPrediction && oraclePrediction && available.length
      ? available.every((number) => modelRoles.get(number) === oracleRoles.get(number))
      : null,
    judges_exact: modelJudges && oracleJudges
      ? JSON.stringify(modelJudges) === JSON.stringify(oracleJudges)
      : null,
  };
}

async function deterministicAudit(args: Args) {
  const auditStarted = performance.now();
  const seed = Number.isFinite(Number(args.seed)) ? Number(args.seed) : 1;
  const scope = flag(args, "scope", "ALL");
  const receiptInput = flag(args, "receipt-stream", "");
  const all = args.all === true || String(args.all ?? "").toLocaleLowerCase() === "true";
  const perDataset = Math.max(0, parseIntFlag(args, "per-dataset", 0));
  const requested = Math.max(1, parseIntFlag(args, "sample-size", 30_000));
  const output = path.resolve(flag(args, "out", path.join(RUN_DIR, `deterministic-audit-${scope.toLocaleLowerCase()}-${seed}.json`)));
  const resultsFile = output.replace(/\.json$/u, ".results.jsonl");
  const progressFile = output.replace(/\.json$/u, ".progress.jsonl");
  const resume = args.resume === true || String(args.resume ?? "").toLocaleLowerCase() === "true";
  const defaultWorkers = Math.min(10, os.availableParallelism());
  const workers = Math.min(16, Math.max(1, parseIntFlag(args, "workers", defaultWorkers)));
  const legacy = new Map<number, LegacySignals>();
  const frozenReceipts = new Map<number, Record<string, unknown>>();
  const receiptIds: number[] = [];
  if (receiptInput) {
    await readReceiptEvents(path.resolve(receiptInput), (event) => {
      if (event.kind !== "case_receipt") return;
      const receipt = event.receipt && typeof event.receipt === "object" && !Array.isArray(event.receipt)
        ? event.receipt as Record<string, unknown>
        : {};
      const source = receipt.source && typeof receipt.source === "object" ? receipt.source as Record<string, unknown> : {};
      const documentId = Number(source.document_id ?? event.document);
      if (!Number.isSafeInteger(documentId) || documentId < 1 || legacy.has(documentId)) return;
      receiptIds.push(documentId);
      legacy.set(documentId, legacySignals(receipt));
      frozenReceipts.set(documentId, receipt);
    });
  }
  const canPrewarm = requested >= 1_000 && !receiptInput && !all && !perDataset &&
    !flag(args, "document-ids", "") && !flag(args, "case-file", "");
  const poolStarted = performance.now();
  const prewarmedPool = canPrewarm ? DeterministicScreenPool.create(workers) : null;
  const selectionStarted = performance.now();
  let selected: Candidate[];
  try {
    selected = receiptIds.length
      ? candidatesByDocumentIds(receiptIds)
      : all
        ? candidatesByDocumentIds(withReadonlySqlite(a2ajLocalBulkPath(), (database) => candidatePoolIds(scope, database)) ?? [])
        : perDataset
          ? stratifiedCandidates(seed, perDataset)
          : await selectedRunCandidates(args, seed, requested, scope);
  } catch (error) {
    await prewarmedPool?.then((pool) => pool.close(), () => undefined);
    throw error;
  }
  const selectionMs = performance.now() - selectionStarted;
  const sourceLabel = receiptInput
    ? path.resolve(receiptInput)
    : all
      ? "all_local_cases"
      : perDataset
        ? `stratified:${perDataset}_per_dataset`
        : "selection";
  const completed = new Set<number>();
  const counts = emptyAuditCounts();
  await mkdir(path.dirname(output), { recursive: true });
  if (resume) {
    await readJsonl(resultsFile, (event) => {
      if (event.kind !== "audit_result") return;
      const documentId = Number(event.document);
      if (Number.isSafeInteger(documentId)) completed.add(documentId);
      if (event.receipt && typeof event.receipt === "object" && !Array.isArray(event.receipt)) {
        countAudit(counts, event.receipt as Record<string, unknown>);
      }
    });
  } else {
    await writeFile(resultsFile, "", "utf8");
    await writeFile(progressFile, "", "utf8");
  }
  const candidates = selected.filter((candidate) => !completed.has(candidate.documentId));
  const partDirectory = candidates.length
    ? await mkdtemp(path.join(path.dirname(output), ".audit-parts-"))
    : null;
  await appendJsonl(progressFile, {
    kind: "audit_started",
    source: sourceLabel,
    selected: selected.length,
    pending: candidates.length,
    resumed: resume,
    workers,
  });
  let persisted = counts.total;
  let workerMs = 0;
  let resultWriteMs = 0;
  let progressWriteMs = 0;
  const pool = candidates.length
    ? prewarmedPool
      ? await prewarmedPool
      : await DeterministicScreenPool.create(Math.min(workers, candidates.length))
    : null;
  if (!candidates.length) await prewarmedPool?.then((ready) => ready.close());
  const poolReadyMs = performance.now() - poolStarted;
  let completedRun = false;
  try {
    const batchSize = Math.max(32, parseIntFlag(args, "batch-size", 15_000));
    for (let offset = 0; offset < candidates.length; offset += batchSize) {
      const batch = candidates.slice(offset, offset + batchSize);
      const workerStarted = performance.now();
      const replies = await pool!.runAudit(batch.map((candidate, batchIndex) => ({
        documentId: candidate.documentId,
        candidate,
        auditIndex: offset + batchIndex,
        legacy: legacy.get(candidate.documentId),
        frozen: frozenReceipts.get(candidate.documentId),
      })), partDirectory!, offset);
      workerMs += performance.now() - workerStarted;
      const progressEvents: Record<string, unknown>[] = [];
      const resultWriteStarted = performance.now();
      for (const reply of replies) {
        if (!reply.completed) continue;
        await appendFile(resultsFile, await readFile(reply.partFile));
        mergeAuditCounts(counts, reply.counts);
        persisted += reply.completed;
        console.log(`[${persisted}/${selected.length}] ready=${counts.ready} needs_luna=${counts.needs_llm}`);
        progressEvents.push({ kind: "audit_progress", completed: persisted, total: selected.length, counts: structuredClone(counts) });
      }
      resultWriteMs += performance.now() - resultWriteStarted;
      const progressWriteStarted = performance.now();
      await appendJsonlBatch(progressFile, progressEvents);
      progressWriteMs += performance.now() - progressWriteStarted;
    }
    completedRun = true;
  } finally {
    await pool?.close();
    if (completedRun && partDirectory) await rm(partDirectory, { recursive: true, force: true });
  }
  const summary = {
    format: "a2aj-opinion-deterministic-audit-v2",
    created_utc: now(),
    source: sourceLabel,
    seed,
    scope,
    selected_cases: selected.length,
    results_file: resultsFile,
    minimum_opinion_words: MIN_OPINION_WORDS,
    deterministic_version: DETERMINISTIC_VERSION,
    counts,
    timing_ms: {
      selection: Math.round(selectionMs),
      pool_ready: Math.round(poolReadyMs),
      worker_batches: Math.round(workerMs),
      result_writes: Math.round(resultWriteMs),
      progress_writes: Math.round(progressWriteMs),
      total: Math.round(performance.now() - auditStarted),
    },
  };
  await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await appendJsonl(progressFile, { kind: "audit_finished", output, counts });
  console.log(`wrote ${output}`);
  console.log(`results ${resultsFile}`);
}

function parsedObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function revalidateFrozenReceipts(args: Args) {
  const receiptStream = path.resolve(flag(args, "receipt-stream", ""));
  if (!flag(args, "receipt-stream", "")) throw new Error("revalidate requires --receipt-stream");
  const progressStream = path.resolve(flag(
    args,
    "progress-stream",
    receiptStream.replace(/\.receipts\.jsonl$/iu, ".progress.jsonl"),
  ));
  const rawOutputStream = path.resolve(flag(
    args,
    "raw-output-stream",
    receiptStream.replace(/\.receipts\.jsonl$/iu, ".outputs.jsonl"),
  ));
  const output = path.resolve(flag(
    args,
    "out",
    receiptStream.replace(/\.receipts\.jsonl$/iu, `.revalidated-${VALIDATOR_VERSION}.json`),
  ));
  const resultsFile = output.replace(/\.json$/iu, ".results.jsonl");
  const resume = args.resume === true || String(args.resume ?? "").toLocaleLowerCase() === "true";
  const rawByHash = new Map<string, Record<string, unknown>>();
  for (const stream of new Set([rawOutputStream, progressStream])) {
    await readJsonl(stream, (event) => {
      if (typeof event.output_sha256 !== "string") return;
      const parsed = event.kind === "model_output"
        ? parsedObject(event.raw_model_output)
        : event.kind === "model_call"
          ? parsedObject(event.assistant_text_preview)
          : null;
      if (parsed) rawByHash.set(event.output_sha256, parsed);
    });
  }
  const work = new Map<number, {
    receipt: Record<string, unknown>;
    submission: Record<string, unknown> | null;
  }>();
  await readReceiptEvents(receiptStream, (event) => {
    const receipt = event.receipt && typeof event.receipt === "object" && !Array.isArray(event.receipt)
      ? event.receipt as Record<string, unknown>
      : null;
    if (!receipt || receipt.status !== "rejected") return;
    const source = receipt.source && typeof receipt.source === "object" && !Array.isArray(receipt.source)
      ? receipt.source as Record<string, unknown>
      : {};
    const documentId = Number(source.document_id ?? event.document);
    if (!Number.isSafeInteger(documentId) || documentId < 1 || work.has(documentId)) return;
    const modelReceipt = receipt.model_receipt && typeof receipt.model_receipt === "object" && !Array.isArray(receipt.model_receipt)
      ? receipt.model_receipt as Record<string, unknown>
      : {};
    const outputHashes = Array.isArray(receipt.raw_model_output_sha256s)
      ? receipt.raw_model_output_sha256s.map(String)
      : [];
    const exactOutputs = Array.isArray(receipt.raw_model_outputs) ? receipt.raw_model_outputs : [];
    const submission = [...outputHashes].reverse().map((hash) => rawByHash.get(hash) ?? null).find(Boolean)
      ?? [...exactOutputs].reverse().map(parsedObject).find(Boolean) ?? parsedObject(receipt.rejected_submission)
      ?? (typeof modelReceipt.output_sha256 === "string" ? rawByHash.get(modelReceipt.output_sha256) ?? null : null);
    work.set(documentId, { receipt, submission });
  });
  await mkdir(path.dirname(output), { recursive: true });
  const completed = new Set<number>();
  if (resume) {
    await readJsonl(resultsFile, (event) => {
      const documentId = Number(event.document);
      if (event.kind === "revalidation_result" && Number.isSafeInteger(documentId)) completed.add(documentId);
    });
  } else {
    await writeFile(resultsFile, "", "utf8");
  }
  const pendingIds = [...work.keys()].filter((documentId) => !completed.has(documentId));
  const candidates = new Map(candidatesByDocumentIds(pendingIds).map((candidate) => [candidate.documentId, candidate]));
  let persisted = completed.size;
  for (let offset = 0; offset < pendingIds.length; offset += 64) {
    const ids = pendingIds.slice(offset, offset + 64);
    const documents = fetchLocalA2AJDocumentsByIds({
      ids,
      docType: "cases",
      language: "en",
      maxChars: Number.MAX_SAFE_INTEGER,
    });
    for (const documentId of ids) {
      const item = work.get(documentId)!;
      const candidate = candidates.get(documentId);
      const document = documents.get(documentId);
      const frozenSource = item.receipt.source && typeof item.receipt.source === "object" && !Array.isArray(item.receipt.source)
        ? item.receipt.source as Record<string, unknown>
        : {};
      let result: Record<string, unknown>;
      if (!item.submission) {
        result = { status: "raw_submission_unavailable", source_hash_match: null, validation: null, prediction: null };
      } else if (!candidate || !document) {
        result = { status: "source_unavailable", source_hash_match: null, validation: null, prediction: null };
      } else {
        const record = await buildCaseRecord(candidate, document);
        const sourceHashMatch = typeof frozenSource.source_sha256 === "string"
          ? frozenSource.source_sha256 === record.sourceSha256
          : null;
        if (sourceHashMatch === false) {
          result = { status: "source_hash_mismatch", source_hash_match: false, validation: null, prediction: null };
        } else {
          const revalidated = validatePrediction(record, item.submission, true);
          result = {
            status: revalidated.validation.ok ? "salvaged" : "still_rejected",
            source_hash_match: sourceHashMatch,
            validation: revalidated.validation,
            prediction: revalidated.prediction,
          };
        }
      }
      persisted += 1;
      await appendJsonl(resultsFile, {
        kind: "revalidation_result",
        document: documentId,
        citation: frozenSource.citation ?? candidate?.citation ?? null,
        old_validation: item.receipt.validation ?? null,
        submission: item.submission,
        validator_version: VALIDATOR_VERSION,
        result,
      });
      if (persisted % 100 === 0 || persisted === work.size) {
        console.log(`[revalidate ${persisted}/${work.size}]`);
      }
    }
  }
  const counts: Record<string, number> = {};
  const newErrors: Record<string, number> = {};
  await readJsonl(resultsFile, (event) => {
    if (event.kind !== "revalidation_result") return;
    const result = event.result && typeof event.result === "object" && !Array.isArray(event.result)
      ? event.result as Record<string, unknown>
      : {};
    const status = String(result.status ?? "unknown");
    counts[status] = (counts[status] ?? 0) + 1;
    const validation = result.validation && typeof result.validation === "object" && !Array.isArray(result.validation)
      ? result.validation as Record<string, unknown>
      : {};
    for (const error of Array.isArray(validation.errors) ? validation.errors : []) {
      const key = String(error);
      newErrors[key] = (newErrors[key] ?? 0) + 1;
    }
  });
  const summary = {
    format: "a2aj-opinion-revalidation-v1",
    created_utc: now(),
    receipt_stream: receiptStream,
    progress_stream: progressStream,
    validator_version: VALIDATOR_VERSION,
    frozen_rejections: work.size,
    completed: Object.values(counts).reduce((sum, count) => sum + count, 0),
    counts,
    top_errors: Object.entries(newErrors)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 50)
      .map(([error, count]) => ({ error, count })),
    results_file: resultsFile,
  };
  await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`wrote ${output}`);
  console.log(`results ${resultsFile}`);
}

function llmEligibleRows(scope: string) {
  return withReadonlySqlite(a2ajLocalBulkPath(), (database) => {
    const params: string[] = [];
    const scopeFilter = scope.toLocaleUpperCase() === "ALL"
      ? ""
      : (params.push(scope), " AND UPPER(dataset)=UPPER(?)");
    return database.prepare(`
      SELECT id, dataset
      FROM document INDEXED BY document_dataset_idx
      WHERE doc_type='cases'${scopeFilter}
      ORDER BY dataset, id
    `).all(...params) as Array<{ id: number; dataset: string }>;
  }) ?? [];
}

function broadRandomSample(candidates: Candidate[], seed: number, target: number) {
  const byDataset = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const bucket = byDataset.get(candidate.dataset) ?? [];
    bucket.push(candidate);
    byDataset.set(candidate.dataset, bucket);
  }
  const broadBuckets = [...byDataset.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([dataset, bucket]) =>
      drawOffsets(datasetSeed(seed, dataset), Math.min(100, bucket.length), bucket.length)
        .map((offset) => bucket[offset]),
    );
  const broad: Candidate[] = [];
  for (let index = 0; broadBuckets.some((bucket) => index < bucket.length); index += 1) {
    for (const bucket of broadBuckets) {
      const candidate = bucket[index];
      if (candidate) broad.push(candidate);
    }
  }
  const seen = new Set(broad.map((candidate) => candidate.documentId));
  const remaining = candidates.filter((candidate) => !seen.has(candidate.documentId));
  const needed = Math.max(0, target - broad.length);
  const random = drawOffsets(seed, needed, remaining.length).map((offset) => remaining[offset]);
  return [...broad, ...random].slice(0, target);
}

function llmScreenOrder(seed: number, eligible: Array<{ id: number; dataset: string }>) {
  return (() => {
    const byDataset = new Map<string, number[]>();
    for (const { id, dataset } of eligible) {
      const bucket = byDataset.get(String(dataset)) ?? [];
      bucket.push(Number(id));
      byDataset.set(String(dataset), bucket);
    }
    const broadBuckets = [...byDataset.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([dataset, ids]) =>
        drawOffsets(datasetSeed(seed, dataset), Math.min(100, ids.length), ids.length).map((offset) => ids[offset]),
      );
    const broad: number[] = [];
    for (let index = 0; broadBuckets.some((bucket) => index < bucket.length); index += 1) {
      for (const bucket of broadBuckets) {
        const documentId = bucket[index];
        if (documentId) broad.push(documentId);
      }
    }
    const seen = new Set(broad);
    const globalIds = eligible.map(({ id }) => Number(id));
    const random = drawOffsets(seed, globalIds.length, globalIds.length)
      .map((offset) => globalIds[offset])
      .filter((documentId) => !seen.has(documentId));
    return [...broad, ...random];
  })();
}

type DeterministicScreenItem = {
  documentId: number;
  candidate?: Candidate;
  document?: A2AJDocument;
};

type DeterministicAuditItem = DeterministicScreenItem & {
  auditIndex: number;
  legacy?: LegacySignals;
  frozen?: Record<string, unknown>;
};

async function deterministicAuditReceipt(item: DeterministicAuditItem): Promise<Record<string, unknown>> {
  if (!item.candidate || !item.document) {
    return {
      source: {
        document_id: item.documentId,
        dataset: item.candidate?.dataset ?? null,
        citation: item.candidate?.citation ?? null,
      },
      status: "load_failed",
      legacy: item.legacy ?? null,
    };
  }
  const source = await compileCaseSource(item.document);
  const paragraphs = source.blocks.filter((block) => block.kind === "paragraph");
  const { structure, deterministic } = analyzeTextOpinionStructure({
    text: source.text,
    paragraphs,
    firstParagraphStart: paragraphs[0]?.start ?? 0,
  });
  const record: DeterministicAuditRecord = {
    candidate: item.candidate,
    source,
    paragraphs,
    sourceSha256: sha256(source.text),
    structure,
    deterministic,
  };
  const prediction = deterministicPrediction(record);
  const reference = mechanicalReference(record);
  const spans = prediction ? predictionSpans(prediction) : null;
  const spanExact = reference.status === "ready" && spans
    ? ROLE_KEYS.every((role) => JSON.stringify(spans[role]) === JSON.stringify(reference.spans[role]))
    : null;
  const reasons = llmReasons(record);
  return {
    source: {
      document_id: item.candidate.documentId,
      dataset: item.candidate.dataset,
      citation: item.candidate.citation,
      name: item.candidate.name,
      date: item.candidate.date,
      source_sha256: record.sourceSha256,
    },
    status: "audited",
    structure: { paragraph_count: record.paragraphs.length, source_chars: record.source.text.length },
    deterministic: record.deterministic,
    routing: { needs_llm: reasons.length > 0, reasons },
    oracle: {
      status: reference.status,
      span_exact: spanExact,
      note: "note" in reference ? reference.note ?? null : null,
    },
    receipt_comparison: frozenReceiptComparison(record, item.frozen, prediction),
    legacy: item.legacy ?? null,
  };
}

async function deterministicScreenEvent(item: DeterministicScreenItem): Promise<Record<string, unknown>> {
  if (!item.candidate || !item.candidate.citation || !item.document) {
    return { kind: "screen_case", document: item.documentId, status: "load_failed", source_chars: 0, needs_llm: false };
  }
  const source = await compileCaseSource(item.document);
  if (!source.text.length) {
    return {
      kind: "screen_case",
      document: item.documentId,
      source: item.candidate,
      status: "source_empty",
      source_chars: 0,
      needs_llm: false,
    };
  }
  if (source.text.length > MAX_LUNA_SOURCE_CHARS) {
    return {
      kind: "screen_case",
      document: item.documentId,
      source: item.candidate,
      status: "source_too_large",
      source_chars: source.text.length,
      needs_llm: false,
    };
  }
  const paragraphs = source.blocks.filter((block) => block.kind === "paragraph");
  const deterministic = deriveTextOpinionStructure({
    text: source.text,
    paragraphs,
    firstParagraphStart: paragraphs[0]?.start ?? 0,
  });
  return {
    kind: "screen_case",
    document: item.documentId,
    source: item.candidate,
    source_chars: source.text.length,
    deterministic_status: deterministic.status,
    deterministic_opinions: deterministic.opinions.length,
    needs_llm: deterministic.status !== "ready",
  };
}

function hydrateDeterministicItems<T extends DeterministicScreenItem>(items: T[]): T[] {
  const missing = items.filter((item) => !item.document).map((item) => item.documentId);
  if (!missing.length) return items;
  const documents = fetchLocalA2AJDocumentsByIds({
    ids: missing,
    docType: "cases",
    language: "en",
    maxChars: Number.MAX_SAFE_INTEGER,
  });
  return items.map((item) => item.document
    ? item
    : { ...item, document: documents.get(item.documentId) });
}

type ScreenWorkerReply = {
  kind: "screen_result";
  events: Record<string, unknown>[];
};

type AuditWorkerReply = {
  kind: "audit_result";
  partFile: string;
  completed: number;
  counts: AuditCounts;
};

class DeterministicScreenPool {
  private readonly workers: ChildProcess[];

  private constructor(workers: ChildProcess[]) {
    this.workers = workers;
  }

  static async create(size: number) {
    const workers = await Promise.all(Array.from({ length: size }, () => new Promise<ChildProcess>((resolve, reject) => {
      const worker = fork(__filename, ["deterministic-screen-worker"], {
        execArgv: process.execArgv,
        serialization: "json",
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      });
      const onError = (error: Error) => reject(error);
      worker.once("error", onError);
      worker.once("message", (message: Record<string, unknown>) => {
        worker.off("error", onError);
        if (message.kind !== "screen_ready") {
          reject(new Error("deterministic screen worker did not become ready"));
          return;
        }
        resolve(worker);
      });
    })));
    return new DeterministicScreenPool(workers);
  }

  async run(items: DeterministicScreenItem[]) {
    const chunks = this.workers.map(() => [] as DeterministicScreenItem[]);
    items.forEach((item, index) => chunks[index % chunks.length].push(item));
    const replies = await Promise.all(this.workers.map((worker, index) => new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      worker.once("error", onError);
      worker.once("message", (message: ScreenWorkerReply) => {
        worker.off("error", onError);
        if (message.kind !== "screen_result") {
          reject(new Error("unexpected deterministic screen worker reply"));
          return;
        }
        resolve(message.events);
      });
      worker.send({ kind: "screen_batch", items: chunks[index] });
    })));
    const byDocument = new Map(replies.flat().map((event) => [Number(event.document), event]));
    return items.map((item) => byDocument.get(item.documentId) ?? {
      kind: "screen_case",
      document: item.documentId,
      status: "worker_result_missing",
      source_chars: 0,
      needs_llm: false,
    });
  }

  async runAudit(items: DeterministicAuditItem[], partDirectory: string, batchOffset: number) {
    const chunkSize = Math.ceil(items.length / this.workers.length);
    const chunks = this.workers.map((_, index) => items.slice(index * chunkSize, (index + 1) * chunkSize));
    return Promise.all(this.workers.map((worker, index) => new Promise<AuditWorkerReply>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      worker.once("error", onError);
      worker.once("message", (message: AuditWorkerReply & { error?: string }) => {
        worker.off("error", onError);
        if (message.kind !== "audit_result" || message.error) {
          reject(new Error(message.error ?? "unexpected deterministic audit worker reply"));
          return;
        }
        resolve(message);
      });
      worker.send({
        kind: "audit_batch",
        items: chunks[index],
        partFile: path.join(partDirectory, `${String(batchOffset).padStart(8, "0")}-${String(index).padStart(2, "0")}.jsonl`),
      });
    })));
  }

  async close() {
    for (const worker of this.workers) worker.kill();
  }
}

async function needsLlmManifestCandidates(args: {
  seed: number;
  scope: string;
  target: number;
  screenFile: string;
  resume: boolean;
  excludedIds: Set<number>;
  workers: number;
}) {
  const completed = new Map<number, Record<string, unknown>>();
  if (args.resume) {
    await readJsonl(args.screenFile, (event) => {
      if (event.kind !== "screen_case") return;
      const documentId = Number(event.document);
      if (Number.isSafeInteger(documentId) && documentId > 0) completed.set(documentId, event);
    });
  }
  const eligibleStarted = performance.now();
  const eligibleRows = llmEligibleRows(args.scope);
  console.log(`[screen setup] eligible=${eligibleRows.length} metadata_ms=${Math.round(performance.now() - eligibleStarted)}`);
  const eligibleIds = new Set(eligibleRows.map(({ id }) => Number(id)));
  const cached = [...completed.entries()].flatMap(([documentId, event]) => {
    if (event.needs_llm !== true || !eligibleIds.has(documentId) || args.excludedIds.has(documentId)) return [];
    const source = event.source as Candidate | undefined;
    return source ? [source] : [];
  });
  if (cached.length >= args.target) {
    const selected = broadRandomSample(cached, args.seed, args.target);
    console.log(`[screen cache] eligible_needs_luna=${cached.length} selected=${selected.length}`);
    return selected;
  }
  const orderStarted = performance.now();
  const order = llmScreenOrder(args.seed, eligibleRows).filter((documentId) => !args.excludedIds.has(documentId));
  console.log(`[screen setup] order=${order.length} randomize_ms=${Math.round(performance.now() - orderStarted)}`);
  const selected: Candidate[] = [];
  let considered = 0;
  const batchSize = 128;
  const poolStarted = performance.now();
  const pool = await DeterministicScreenPool.create(args.workers);
  console.log(`[screen setup] workers=${args.workers} startup_ms=${Math.round(performance.now() - poolStarted)}`);
  try {
    for (let offset = 0; offset < order.length && selected.length < args.target; offset += batchSize) {
      const ids = order.slice(offset, offset + batchSize);
      const missing = ids.filter((documentId) => !completed.has(documentId));
      const candidates = missing.length ? candidatesByDocumentIds(missing) : [];
      const byId = new Map(candidates.map((candidate) => [candidate.documentId, candidate]));
      const events = missing.length
        ? await pool.run(missing.map((documentId) => ({
            documentId,
            candidate: byId.get(documentId),
          })))
        : [];
      for (const event of events) completed.set(Number(event.document), event);
      for (const documentId of ids) {
        considered += 1;
        const event = completed.get(documentId)!;
        if (event.needs_llm === true) {
          const source = event.source as Candidate | undefined;
          if (source) selected.push(source);
        }
        if (selected.length >= args.target) break;
      }
      if (events.length) {
        await appendFile(
          args.screenFile,
          events.map((event) => JSON.stringify({ utc: now(), ...event })).join("\n") + "\n",
          "utf8",
        );
      }
      if (considered % 512 < batchSize || selected.length >= args.target) {
        console.log(`[screen ${considered}/${order.length}] needs_luna=${selected.length}/${args.target}`);
      }
    }
  } finally {
    await pool.close();
  }
  if (selected.length < args.target) {
    throw new Error(`only ${selected.length} deterministic-unresolved cases exist in the selected ${args.scope} corpus; requested ${args.target}`);
  }
  return selected.slice(0, args.target);
}

async function manifest(args: Args) {
  const seed = Number.isFinite(Number(args.seed)) ? Number(args.seed) : randomInt(1, 2 ** 31 - 1);
  const requestedSampleSize = Math.max(1, parseIntFlag(args, "sample-size", 30_000));
  const scope = flag(args, "scope", "ALL");
  if (flag(args, "document-ids", "") || flag(args, "case-file", "")) {
    throw new Error("manifest creates a random cohort; do not pass --document-ids or --case-file");
  }
  const output = flag(
    args,
    "out",
    path.join(RUN_DIR, `luna-low-${scope.toLocaleLowerCase()}-${seed}-manifest.json`),
  );
  const needsLlm = args["needs-llm"] === true || String(args["needs-llm"] ?? "").toLocaleLowerCase() === "true";
  const resume = args.resume === true || String(args.resume ?? "").toLocaleLowerCase() === "true";
  const screenWorkers = Math.min(10, Math.max(1, parseIntFlag(args, "workers", 10)));
  const excludeCaseFile = flag(args, "exclude-case-file", "");
  const excludedIds = excludeCaseFile ? new Set(await documentIdsFromFile(excludeCaseFile)) : new Set<number>();
  const screenFile = output.replace(/\.json$/u, ".screen.jsonl");
  await mkdir(path.dirname(output), { recursive: true });
  if (needsLlm && !resume) await writeFile(screenFile, "", "utf8");
  const candidates = needsLlm
    ? await needsLlmManifestCandidates({
        seed,
        scope,
        target: requestedSampleSize,
        screenFile,
        resume,
        excludedIds,
        workers: screenWorkers,
      })
    : selectedCandidates(seed, requestedSampleSize, scope);
  const datasetCounts = Object.fromEntries(
    [...new Set(candidates.map((candidate) => candidate.dataset))]
      .sort()
      .map((dataset) => [dataset, candidates.filter((candidate) => candidate.dataset === dataset).length]),
  );
  const value = {
    format: "a2aj-luna-manifest-v2",
    created_utc: now(),
    seed,
    scope,
    requested_sample_size: requestedSampleSize,
    sample_size: candidates.length,
    selection_order: "seeded_pseudorandom_draw",
    selection_algorithm: needsLlm
      ? "deterministic_screen_broad_random_v1"
      : scope.toLocaleUpperCase() === "ALL" ? RANDOM_SELECTION_VERSION : "eligible_offset_draw_v1",
    selection_filter: needsLlm ? "deterministic_status_not_ready" : "none",
    deterministic_version: DETERMINISTIC_VERSION,
    deterministic_screen_workers: needsLlm ? screenWorkers : null,
    maximum_source_chars: needsLlm ? MAX_LUNA_SOURCE_CHARS : null,
    screen_file: needsLlm ? screenFile : null,
    excluded_case_file: excludeCaseFile ? path.resolve(excludeCaseFile) : null,
    excluded_case_count: excludedIds.size,
    dataset_counts: datasetCounts,
    document_ids: candidates.map((candidate) => candidate.documentId),
    cases: candidates.map((candidate) => ({
      document_id: candidate.documentId,
      dataset: candidate.dataset,
      citation: candidate.citation,
      name: candidate.name,
      date: candidate.date,
    })),
  };
  await writeFile(output, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  console.log(`wrote ${output}`);
  console.log(`seed ${seed} scope ${scope} cases ${candidates.length}`);
}

async function annotate(args: Args) {
  const documentId = parseIntFlag(args, "document-id", 0);
  const file = flag(args, "file", "");
  const sidecar = flag(args, "sidecar-db", DEFAULT_SIDECAR);
  if (!documentId || !file) throw new Error("annotate requires --document-id and --file");
  const candidate = withReadonlySqlite(a2ajLocalBulkPath(), (database) => {
    const row = database.prepare(`
      SELECT id, dataset, COALESCE(NULLIF(citation_en,''),NULLIF(citation2_en,'')) AS citation,
             name_en, document_date_en FROM document WHERE id=? AND doc_type='cases'
    `).get(documentId) as Record<string, unknown> | undefined;
    return row ? {
      documentId: Number(row.id), dataset: String(row.dataset ?? ""), citation: String(row.citation ?? ""),
      name: row.name_en ? String(row.name_en) : null, date: row.document_date_en ? String(row.document_date_en) : null,
    } satisfies Candidate : null;
  });
  if (!candidate) throw new Error(`A2AJ case ${documentId} not found`);
  const record = await loadCase(candidate);
  if (!record) throw new Error(`A2AJ case ${documentId} could not be loaded`);
  const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
  const result = validatePrediction(record, raw, true);
  if (!result.prediction || !result.validation.ok) throw new Error(json(result.validation));
  const database = await initSidecar(sidecar);
  database.prepare("INSERT OR REPLACE INTO opinion_reference VALUES (?,?,?,?)").run(
    documentId,
    record.sourceSha256,
    JSON.stringify(result.prediction),
    now(),
  );
  database.close();
  console.log(`stored human reference for ${documentId}`);
}

function runReceiptPath(value: string) {
  return path.isAbsolute(value)
    ? value
    : value.toLocaleLowerCase().endsWith(".json")
      ? path.resolve(value)
      : path.join(RUN_DIR, `${value}.json`);
}

function predictionFromReceipt(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prediction = (value as Record<string, unknown>).prediction;
  if (!prediction || typeof prediction !== "object" || Array.isArray(prediction)) return null;
  return prediction as Record<string, unknown>;
}

function compatibleJudgeRole(judge: Record<string, unknown>, opinions: Array<Record<string, unknown>>): Role {
  if (typeof judge.role === "string" && ROLE_KEYS.includes(judge.role as Role)) return judge.role as Role;
  if (judge.result_position === "opposes_disposition") return "minority";
  if (judge.result_side === "minority") return "minority";
  const links = Array.isArray(judge.opinion_links)
    ? judge.opinion_links.filter((link): link is Record<string, unknown> => Boolean(link) && typeof link === "object" && !Array.isArray(link))
    : [];
  const opinionIds = links.length
    ? links.map((link) => String(link.opinion_id))
    : Array.isArray(judge.opinion_ids) ? judge.opinion_ids.map(String) : [];
  const authors = links.length ? links.some((link) => link.relation === "authors") : judge.relationship === "authors";
  if (
    authors &&
    opinions.some((opinion) => opinionIds.includes(String(opinion.id)) && opinion.alignment === "same_result_separate_reasons")
  ) return "concurring";
  if (judge.result_position === "supports_disposition") return "majority";
  if (judge.result_side === "majority") return "majority";
  return "unknown";
}

function judgeKeySet(prediction: Record<string, unknown> | null) {
  const opinions = Array.isArray(prediction?.opinions)
    ? prediction.opinions.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
  const rawPeople = prediction && (Array.isArray(prediction.participants) ? prediction.participants : prediction.judges);
  const judges = Array.isArray(rawPeople)
    ? rawPeople.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
  return new Set(judges.map((judge) =>
    `${compact(String(judge.name ?? "")).toLocaleLowerCase()}|${compatibleJudgeRole(judge, opinions)}`,
  ));
}

function sameSet(left: Set<string>, right: Set<string>) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function parseParagraphIndex(value: unknown) {
  if (typeof value !== "string") return [];
  const numbers: number[] = [];
  for (const token of value.split(",")) {
    const match = /^\s*par(\d+)(?:-par(\d+))?\s*$/iu.exec(token);
    if (!match) continue;
    const from = Number(match[1]);
    const to = match[2] ? Number(match[2]) : from;
    for (let number = from; number <= to; number += 1) numbers.push(number);
  }
  return numbers;
}

function predictionRoleMap(prediction: Record<string, unknown> | null, available: number[]) {
  const roles = new Map<number, Role>();
  if (!prediction) return roles;
  const spans = prediction.spans && typeof prediction.spans === "object" && !Array.isArray(prediction.spans)
    ? prediction.spans as Record<string, unknown>
    : null;
  if (spans) {
    for (const role of ROLE_KEYS) {
      const ranges = Array.isArray(spans[role]) ? spans[role] as unknown[] : [];
      for (const raw of ranges) {
        const range = Array.isArray(raw) && raw.length === 2
          ? { from: Number(raw[0]), to: Number(raw[1]) }
          : raw && typeof raw === "object" && !Array.isArray(raw)
            ? { from: Number((raw as Record<string, unknown>).from), to: Number((raw as Record<string, unknown>).to) }
            : null;
        if (range && Number.isInteger(range.from) && Number.isInteger(range.to)) {
          for (const number of numbersInRange(range, available)) roles.set(number, role);
        }
      }
    }
    return roles;
  }
  const opinions = Array.isArray(prediction.opinions)
    ? prediction.opinions.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
  for (const opinion of opinions) {
    const authorityPosition = String(opinion.authority_position ?? "");
    let role: Role;
    if (authorityPosition) {
      role = authorityPosition === "unanimous" || authorityPosition === "majority"
        ? "majority"
        : authorityPosition === "dissenting"
          ? "minority"
          : authorityPosition === "concurring"
            ? "concurring"
            : "unknown";
    } else {
      role = opinion.alignment === "lead"
        ? "majority"
        : opinion.alignment === "different_result"
          ? "minority"
          : opinion.alignment === "same_result_separate_reasons"
            ? "concurring"
            : opinion.result_position === "supports_disposition"
              ? "majority"
              : opinion.result_position === "opposes_disposition"
                ? "minority"
                : "unknown";
    }
    for (const raw of Array.isArray(opinion.paragraphs) ? opinion.paragraphs : []) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const range = { from: Number((raw as Record<string, unknown>).from), to: Number((raw as Record<string, unknown>).to) };
      if (!Number.isInteger(range.from) || !Number.isInteger(range.to)) continue;
      for (const number of numbersInRange(range, available)) roles.set(number, role);
    }
  }
  return roles;
}

async function compareRuns(args: Args) {
  const lunaValue = flag(args, "luna-run", "");
  const qwenValue = flag(args, "qwen-run", "");
  if (!lunaValue || !qwenValue) throw new Error("compare requires --luna-run and --qwen-run (run IDs or receipt paths)");
  const lunaPath = runReceiptPath(lunaValue);
  const qwenPath = runReceiptPath(qwenValue);
  const luna = JSON.parse(await readFile(lunaPath, "utf8")) as Record<string, unknown>;
  const qwen = JSON.parse(await readFile(qwenPath, "utf8")) as Record<string, unknown>;
  const lunaRows = Array.isArray(luna.receipts) ? luna.receipts : [];
  const qwenRows = Array.isArray(qwen.receipts) ? qwen.receipts : [];
  const qwenByDocument = new Map(
    qwenRows.map((row) => [Number((row as Record<string, unknown>).source && ((row as Record<string, unknown>).source as Record<string, unknown>).document_id), row]),
  );
  const cases = lunaRows.map((lunaRow) => {
    const source = (lunaRow as Record<string, unknown>).source as Record<string, unknown> | undefined;
    const documentId = Number(source?.document_id);
    const qwenRow = qwenByDocument.get(documentId) as Record<string, unknown> | undefined;
    const lunaPrediction = predictionFromReceipt(lunaRow);
    const qwenPrediction = predictionFromReceipt(qwenRow);
    const available = parseParagraphIndex((lunaRow as Record<string, unknown>).structure && ((lunaRow as Record<string, unknown>).structure as Record<string, unknown>).paragraph_index);
    const lunaRoles = predictionRoleMap(lunaPrediction, available);
    const qwenRoles = predictionRoleMap(qwenPrediction, available);
    const roleMatches = available.filter((number) => lunaRoles.get(number) === qwenRoles.get(number)).length;
    return {
      document_id: documentId,
      citation: source?.citation ?? null,
      luna_status: (lunaRow as Record<string, unknown>).status ?? null,
      qwen_status: qwenRow?.status ?? "missing",
      judge_agreement: sameSet(judgeKeySet(lunaPrediction), judgeKeySet(qwenPrediction)),
      span_exact: Boolean(lunaPrediction && qwenPrediction && available.every((number) => lunaRoles.get(number) === qwenRoles.get(number))),
      paragraph_role_accuracy: available.length ? Math.round((roleMatches / available.length) * 1_000_000) / 1_000_000 : null,
      luna_prediction: lunaPrediction,
      qwen_prediction: qwenPrediction,
    };
  });
  const comparison = {
    luna_run: luna.run_id ?? lunaValue,
    qwen_run: qwen.run_id ?? qwenValue,
    same_case_count: cases.filter((item) => item.qwen_status !== "missing").length,
    cases,
  };
  const output = typeof args.out === "string" && args.out.trim() ? args.out.trim() : "";
  if (output) {
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(comparison, null, 2)}\n`, "utf8");
    console.log(`wrote ${output}`);
  }
  console.log(json(comparison));
}

async function selfTest() {
  if (validUtf8String(`before\uD800after`) !== "before�after") {
    throw new Error("UTF-8 transport normalization self-test failed");
  }
  const recordText = [
    "Example Decision\nJudges\nAlpha J.; Beta J.; Gamma J.\nJoint Reasons for Judgment: (paras. 1 to 2)\nAlpha J. and Beta J.\nDissenting Reasons: (paras. 3 to 4)\nGamma J.\n",
    "[1] Majority reasoning contains enough ordinary substantive source text to establish a reliable paragraph block for this structural self test and to exercise the canonical A2AJ paragraph compiler. Applying 2098 SCC 2, the first majority proposition concerns jurisdiction and the governing statutory language.\n",
    "[2] More majority reasoning contains enough ordinary substantive source text to establish a reliable paragraph block without experiment-local paragraph parsing. The majority finally dismisses the appeal and awards ordinary costs to the respondent.\n",
    "Beta J.: I agree.\n",
    "[3] Dissent reasoning contains enough ordinary substantive source text to establish a reliable paragraph block for this structural self test and to exercise the canonical A2AJ paragraph compiler. The dissent instead applies a different standard of review.\n",
    "[4] More dissent reasoning contains enough ordinary substantive source text to establish a reliable paragraph block without experiment-local paragraph parsing. The dissent would allow the appeal, set aside the order, and remit the matter for reconsideration.\n",
    "Alpha J.; Beta J.; Gamma J.\n",
  ].join("");
  const { deriveA2AJSourceDoc } = await import("../../backend/src/lib/sourceDocStructureHost");
  const source = await deriveA2AJSourceDoc({ citation: "2099 SCC 1", dataset: "SCC", docType: "cases", text: recordText });
  const paragraphs = source.blocks.filter((block) => block.kind === "paragraph");
  if (paragraphs.map((block) => block.label).join(",") !== "par1,par2,par3,par4") throw new Error(`SourceDoc self-test failed: ${paragraphs.map((block) => block.label).join(",")}`);
  const candidate: Candidate = {
    documentId: 1,
    dataset: "SCC",
    citation: "2099 SCC 1",
    name: "Example",
    date: "2099-01-01",
    target: { documentId: 2, citation: "2098 SCC 2", citationAliases: [], name: "Target Example", sameLitigationEligible: false },
  };
  const document = { docType: "cases", dataset: "SCC", citation: candidate.citation, alternateCitation: null, name: candidate.name, date: candidate.date, url: null, text: recordText, language: "en", upstreamLicense: null, structure: { status: "usable", source: "flat_text", counts: { paragraph: 4, page: 0, section: 0 } } } satisfies A2AJDocument;
  const { structure, deterministic } = analyzeTextOpinionStructure({
    text: source.text,
    paragraphs,
    firstParagraphStart: paragraphs[0]?.start ?? 0,
  });
  const record: CaseRecord = {
    candidate,
    document,
    source,
    paragraphs,
    sourceEvidence: createA2AJDocumentEvidence(document),
    sourceSha256: sha256(recordText),
    structure,
    deterministic,
    hints: extractMechanicalHints(source, paragraphs, structure),
    preflight: extractPreflight(source, paragraphs),
    citationEdges: [],
    targetOccurrences: caseTargetOccurrences(source, candidate.target),
  };
  if (record.targetOccurrences.length !== 1 || record.targetOccurrences[0].quote !== "2098 SCC 2") {
    throw new Error(`case-target occurrence self-test failed: ${json(record.targetOccurrences)}`);
  }
  const targetPacket = caseTargetMvpPacket(record, "nested");
  if (!targetPacket.includes('"occurrence_id": "tm1"') || !targetPacket.includes("[COMPLETE CITING DECISION TEXT]")) {
    throw new Error("case-target packet self-test failed");
  }
  const raw = {
    disposition_quote: "The majority finally dismisses the appeal and awards ordinary costs to the respondent.",
    opinions: deterministic.opinions.map((opinion) => ({
      id: opinion.id,
      author_names: opinion.authors,
      collective_author: null,
      result_position: resultPositionFromAlignment(opinion.alignment),
      position_evidence_quote: opinion.endQuote,
      start_quote: opinion.startQuote,
      end_quote: opinion.endQuote,
    })),
    participants: deterministic.judges.map((judge) => ({
      name: judge.name,
      panel_evidence_quote: "Alpha J.; Beta J.; Gamma J.",
      result_position: resultPositionFromSide(judge.resultSide),
      opinion_links: judge.opinionIds.map((opinionId) => ({
        opinion_id: opinionId,
        relation: judge.relationship === "authors" ? "authors" : judge.relationship === "joins_reasons" ? "joins" : "joins_in_part",
        evidence_quote: judge.name.startsWith("Gamma")
          ? "Dissenting Reasons: (paras. 3 to 4)\nGamma J."
          : "Alpha J. and Beta J.",
      })),
      result_only: false,
      result_only_evidence_quote: null,
    })),
    nonparticipants: [],
  };
  const result = validatePrediction(record, raw);
  if (!result.validation.ok || !result.prediction) throw new Error(json(result.validation));
  if (
    result.prediction.opinions[0].authority_position !== "majority" ||
    result.prediction.opinions[1].authority_position !== "dissenting"
  ) {
    throw new Error(`explicit vote counts did not derive majority/dissent: ${json(result.prediction.opinions)}`);
  }
  const nestedSubmission: ReducedCaseTargetSubmission = {
    disposition_quote: raw.disposition_quote,
    opinions: raw.opinions.map((opinion, index) => ({
      named_authors: opinion.author_names.map((name) => ({
        name,
        evidence_quote: index === 0 ? "Alpha J. and Beta J." : "Dissenting Reasons: (paras. 3 to 4)\nGamma J.",
      })),
      collective_author: opinion.collective_author,
      collective_author_evidence_quote: null,
      result_position: opinion.result_position,
      position_evidence_quote: opinion.position_evidence_quote,
      start_quote: opinion.start_quote,
      end_quote: opinion.end_quote,
      whole_opinion_joiners: [],
    })),
    participants: raw.participants.map(({ opinion_links: _, ...participant }) => participant),
    nonparticipants: [],
    target_mentions: [{ occurrence_id: "tm1", mention_quote: null, voice: "current_court" }],
    issues: [{
      question: "Should the appeal be dismissed?",
      answer_groups: [
        {
          answer: "Yes.",
          positions: [{
            relation_to_disposition: "dispositive",
            answer_evidence: [{
              quote: "The majority finally dismisses the appeal and awards ordinary costs to the respondent.",
              voice: "current_court",
            }],
            basis_and_limits: [{
              kind: "application",
              text: "The target rule supports dismissal.",
              evidence: [{
                quote: "Applying 2098 SCC 2, the first majority proposition concerns jurisdiction and the governing statutory language.",
                voice: "current_court",
              }],
            }],
            partial_joins: [],
            target_mentions: [{ occurrence_id: "tm1", mention_quote: null }],
            target_treatments: [{
              target_mentions: [{ occurrence_id: "tm1", mention_quote: null }],
              attribution: "current_court",
              label: "applied",
              scope: "specific_proposition",
              evidence_quote: "Applying 2098 SCC 2, the first majority proposition concerns jurisdiction and the governing statutory language.",
              target_proposition_as_characterized: "The governing jurisdictional rule.",
            }],
          }],
        },
        {
          answer: "No.",
          positions: [{
            relation_to_disposition: "dispositive",
            answer_evidence: [{
              quote: "The dissent would allow the appeal, set aside the order, and remit the matter for reconsideration.",
              voice: "current_court",
            }],
            basis_and_limits: [],
            partial_joins: [],
            target_mentions: [],
            target_treatments: [],
          }],
        },
      ],
    }],
    unscoped_target_treatments: [],
    direct_history: [],
  };
  const nested = validateCaseTargetSubmission(record, nestedSubmission);
  if (
    !nested.validation.ok || !nested.prediction || !nested.case_target_mvp?.ok ||
    nested.case_target_mvp.target_treatments.length !== 1 ||
    nested.case_target_mvp.issue_authority[0]?.status !== "authority_ambiguous" ||
    nested.case_target_mvp.flat_treatment.flags.aggregation_safe
  ) {
    throw new Error(`nested v13 compilation failed: ${json(nested)}`);
  }
  const bareAgreement = structuredClone(raw) as Record<string, unknown>;
  const bareOpinions = bareAgreement.opinions as Array<Record<string, unknown>>;
  const bareParticipants = bareAgreement.participants as Array<Record<string, unknown>>;
  bareOpinions[0].author_names = ["Alpha J."];
  bareParticipants[1].opinion_links = [];
  bareParticipants[1].result_only = true;
  bareParticipants[1].result_only_evidence_quote = "Beta J.: I agree.";
  const normalizedAgreement = validatePrediction(record, bareAgreement);
  const normalizedBeta = normalizedAgreement.prediction?.participants.find(({ name }) => name.startsWith("Beta"));
  if (
    !normalizedAgreement.validation.ok || normalizedBeta?.result_only ||
    normalizedBeta?.opinion_links[0]?.relation !== "joins"
  ) {
    throw new Error(`bare agreement was not deterministically normalized to a joinder: ${json({ validation: normalizedAgreement.validation, beta: normalizedBeta })}`);
  }
  const plurality = structuredClone(result.prediction);
  plurality.opinions[1].result_position = "supports_disposition";
  plurality.participants[2].result_position = "supports_disposition";
  plurality.participants.push({
    name: "Delta J.",
    panel_evidence_quote: null,
    result_position: "supports_disposition",
    opinion_links: [],
    result_only: true,
    result_only_evidence_quote: null,
    result_side: "majority",
    relationship: "concurs_in_result_only",
    opinion_ids: [],
  });
  withDerivedAuthority(plurality);
  if (
    plurality.opinions[0].authority_position !== "plurality" ||
    plurality.opinions[1].authority_position !== "concurring"
  ) {
    throw new Error(`largest disposition bloc was mislabeled as majority: ${json(plurality.opinions)}`);
  }
  const legacyRaw = {
    opinions: deterministic.opinions.map((opinion) => ({
      id: opinion.id,
      authors: opinion.authors,
      alignment: opinion.alignment,
      start_quote: opinion.startQuote,
      end_quote: opinion.endQuote,
    })),
    judges: deterministic.judges.map((judge) => ({
      name: judge.name,
      result_side: judge.resultSide,
      relationship: judge.relationship,
      opinion_ids: judge.opinionIds,
    })),
  };
  if (validatePrediction(record, legacyRaw).validation.ok) throw new Error("live extraction accepted the retired schema");
  const legacyResult = validatePrediction(record, legacyRaw, true);
  if (!legacyResult.validation.ok || !legacyResult.prediction) throw new Error(`legacy receipt normalization failed: ${json(legacyResult.validation)}`);
  if (
    nameKey("Sharlow J.A.") !== "sharlow" ||
    nameKey("Dawson D.J.C.A.") !== "dawson" ||
    nameKey("Chipman, J.A.") !== "chipman" ||
    nameKey("Clarke, C.J.N.S.") !== "clarke" ||
    nameKey("Feldman, Kathryn N.") !== "feldman"
  ) {
    throw new Error("dotted judicial suffixes changed judge-name identity");
  }
  if (
    !explicitNamedAuthorshipByline("REASONS FOR JUDGMENT OF THE COURT BY:\nGOYETTE J.A.", "Goyette J.A.") ||
    explicitNamedAuthorshipByline("The reasons of the Court were quoted by counsel for Goyette J.A.", "Goyette J.A.")
  ) {
    throw new Error("explicit named-authorship byline detection changed");
  }
  if (
    judgeIdentityKey("Feldman, Kathryn N.") !== judgeIdentityKey("Kathryn N. Feldman J.A.") ||
    judgeIdentityKey("Jane Smith J.") === judgeIdentityKey("John Smith J.") ||
    uniqueJudgeMatch("Smith J.", ["Jane Smith J.", "John Smith J."], (name) => name) !== null
  ) {
    throw new Error("judge identity collapsed or guessed between same-surname judges");
  }
  const unsupportedLink = structuredClone(raw);
  unsupportedLink.participants[0].opinion_links[0].evidence_quote = "The majority finally dismisses the appeal";
  if (validatePrediction(record, unsupportedLink).validation.ok) {
    throw new Error("opinion link evidence that did not identify the judge was accepted");
  }
  record.deterministic.panel.push("Prothonotary");
  const noisyPanel = validatePrediction(record, raw);
  record.deterministic.panel.pop();
  if (!noisyPanel.validation.ok || !noisyPanel.validation.warnings?.some((warning) => warning.includes("Prothonotary"))) {
    throw new Error(`noisy deterministic panel candidate still rejected the extraction: ${json(noisyPanel.validation)}`);
  }
  const unresolvedAuthor = structuredClone(raw);
  unresolvedAuthor.opinions[0].author_names = [];
  for (const participant of unresolvedAuthor.participants) {
    participant.opinion_links = participant.opinion_links.filter((link) => link.opinion_id !== "o1");
  }
  if (!validatePrediction(record, unresolvedAuthor).validation.ok) {
    throw new Error("genuinely unresolved opinion authorship was rejected");
  }
  if (resultPositionFromAlignment("lead") !== "supports_disposition" || resultPositionFromAlignment("different_result") !== "opposes_disposition") {
    throw new Error("opinion result-position compatibility changed");
  }
  const duplicateText = "REASONS FOR JUDGMENT\nDisposition.\nDecision Content\nREASONS FOR JUDGMENT\n[1] Reasons.\nDisposition.";
  const preferredStart = preferredGroundedSpans(
    duplicateText,
    duplicateText.indexOf("[1]"),
    exactQuoteSpans(duplicateText, "REASONS FOR JUDGMENT", 10),
    "start",
    1,
  );
  const preferredEnd = preferredGroundedSpans(
    duplicateText,
    duplicateText.indexOf("[1]"),
    exactQuoteSpans(duplicateText, "Disposition.", 10),
    "end",
    1,
  );
  if (
    preferredStart.length !== 1 || preferredStart[0].start !== duplicateText.lastIndexOf("REASONS FOR JUDGMENT") ||
    preferredEnd.length !== 1 || preferredEnd[0].start !== duplicateText.lastIndexOf("Disposition.")
  ) {
    throw new Error("decision-body duplicate anchors were not disambiguated");
  }
  const shortAnchors = structuredClone(raw);
  shortAnchors.opinions[0].start_quote = "Majority reasoning";
  shortAnchors.opinions[0].end_quote = "respondent.";
  const expanded = validatePrediction(record, shortAnchors);
  if (
    !expanded.validation.ok ||
    !expanded.prediction ||
    sourceDocQuoteWords(expanded.prediction.opinions[0].start_quote).length < 4 ||
    sourceDocQuoteWords(expanded.prediction.opinions[0].end_quote).length < 4
  ) {
    throw new Error(`unique short boundary anchors were not expanded: ${json(expanded.validation)}`);
  }
  const normalizedAnchors = structuredClone(raw);
  normalizedAnchors.opinions[0].start_quote = normalizedAnchors.opinions[0].start_quote.replace("[1]", "[ 1 ]");
  const grounded = validatePrediction(record, normalizedAnchors);
  if (
    !grounded.validation.ok ||
    !grounded.prediction ||
    grounded.prediction.opinions[0].start !== result.prediction.opinions[0].start ||
    grounded.prediction.opinions[0].start_quote !== result.prediction.opinions[0].start_quote
  ) {
    throw new Error(`word-grounded boundary anchors changed the source span: ${json(grounded.validation)}`);
  }
  const oracle = mechanicalReference(record);
  if (oracle.status !== "ready") throw new Error("mechanical reference self-test failed");
  if (JSON.stringify(oracle.spans) !== JSON.stringify(predictionSpans(result.prediction))) {
    throw new Error(`mechanical reference ranges changed: ${json(predictionSpans(result.prediction))}`);
  }
  if (parseDocumentIds("7, 7 9\n11").join(",") !== "7,9,11") throw new Error("case selector self-test failed");
  const randomDraw = drawOffsets(285949255, 20, 100);
  if (
    randomDraw.length !== 20 ||
    new Set(randomDraw).size !== 20 ||
    JSON.stringify(randomDraw) !== JSON.stringify(drawOffsets(285949255, 20, 100)) ||
    JSON.stringify(randomDraw) === JSON.stringify([...randomDraw].sort((left, right) => left - right))
  ) {
    throw new Error(`seeded random order self-test failed: ${randomDraw.join(",")}`);
  }
  if (codexPacket(record).includes("opinion_headers")) throw new Error("Codex packet leaked oracle output");
  let active = 0;
  let peak = 0;
  const pooled = await mapPool(Array.from({ length: 23 }, (_, index) => index), 10, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;
    return value * 2;
  });
  if (peak !== 10 || pooled.join(",") !== Array.from({ length: 23 }, (_, index) => index * 2).join(",")) {
    throw new Error(`parallel dispatch self-test failed: peak=${peak}`);
  }
  const streamedPoolResults: number[] = [];
  const retainedPoolResults = await mapPool([1, 2, 3], 2, async (value) => value * 3, async (value, index) => {
    streamedPoolResults[index] = value;
  });
  if (retainedPoolResults.length || streamedPoolResults.join(",") !== "3,6,9") {
    throw new Error("streamed pool results were retained after persistence");
  }
  const transportEventCount = 260;
  const transportScript = [
    "const emit=(value)=>process.stdout.write(JSON.stringify(value)+'\\n');",
    "emit({kind:'subscription_preflight',endpoint:'test'});",
    `for(let index=0;index<${transportEventCount};index+=1)emit({kind:'subscription_provider_event',event:{type:'test',payload:'x'.repeat(65536)}});`,
    "emit({kind:'subscription_completed',response_id:'test'});",
  ].join("");
  let streamedTransportEvents = 0;
  const largeTransport = await spawnCodex(
    { command: process.execPath, prefix: ["-e", transportScript], shell: false },
    [],
    "",
    30_000,
    async () => { streamedTransportEvents += 1; },
  );
  if (
    largeTransport.status !== 0 || largeTransport.error ||
    largeTransport.providerEventCount !== transportEventCount ||
    largeTransport.providerAttemptCount !== 1 ||
    streamedTransportEvents !== transportEventCount + 2 ||
    largeTransport.subscriptionEvents.length !== 2
  ) {
    throw new Error(`large subscription event stream was not retained without buffering: ${json({
      status: largeTransport.status,
      error: largeTransport.error?.message ?? null,
      providerEventCount: largeTransport.providerEventCount,
      streamedTransportEvents,
      subscriptionEvents: largeTransport.subscriptionEvents.length,
    })}`);
  }
  if (GPT_RESPONSES_SCHEMA.type !== "json_schema" || GPT_RESPONSES_SCHEMA.strict !== true || GPT_RESPONSES_SCHEMA.name !== RESPONSE_SCHEMA_NAME) {
    throw new Error("Responses schema self-test failed");
  }
  if (ROSTER_JSON_SCHEMA.required.join(",") !== "disposition_quote,opinions,participants,nonparticipants") {
    throw new Error("richer extraction contract changed");
  }
  const registryData: JudgeCourtRegistryData = {
    version: 1,
    generatedAt: "2099-01-01T00:00:00Z",
    sources: [{
      id: "official",
      url: "https://example.test/scc",
      retrievedAt: "2099-01-01T00:00:00Z",
      sha256: "a".repeat(64),
    }],
    people: [{ id: "alpha", canonicalName: "Alpha", aliases: ["Alpha J."] }],
    courts: [{ id: "scc", canonicalName: "Supreme Court of Canada", aliases: [], datasetAliases: ["SCC"] }],
    positions: [{
      id: "alpha-scc-justice",
      personId: "alpha",
      courtId: "scc",
      dateStart: { value: "2090", precision: "year" },
      dateTermination: null,
      positionType: "justice",
      role: "Justice",
      assignmentType: "permanent",
      evidence: [{ sourceId: "official", sourceQuote: "Alpha appointed in 2090" }],
    }],
    rosterObservations: [],
  };
  const registry: JudgeRegistryContext = {
    resolver: createJudgeCourtServiceResolver(registryData),
    sha256: "b".repeat(64),
    absolutePath: "C:\\example\\judge-registry.json",
  };
  const service = judgeCourtServiceReceipt(candidate, result.prediction, registry);
  if (
    service?.status !== "resolved" ||
    service.participants[0].resolution.status !== "unique" ||
    service.participants[1].resolution.status !== "no_match"
  ) {
    throw new Error(`judge/court receipt resolution failed: ${json(service)}`);
  }
  if (judgeCourtServiceReceipt({ ...candidate, date: "2099" }, result.prediction, registry)?.status !== "unavailable") {
    throw new Error("inexact decision date should not fail or fabricate a service match");
  }
  const exactRaw = "{\n  \"disposition_quote\": null, \"opinions\": [], \"participants\": [], \"nonparticipants\": []\n}\n";
  const exactHash = sha256(exactRaw);
  const compact = compactCaseReceipt({ status: "accepted", route: "luna", raw_model_output_sha256s: [exactHash], judge_court_service: service });
  if (!Array.isArray(compact.raw_model_output_sha256s) || compact.raw_model_output_sha256s[0] !== exactHash || "raw_model_outputs" in compact) {
    throw new Error("compact receipts no longer reference the single-copy raw output ledger");
  }
  if ((compact.judge_court_service as typeof service)?.participants[1].resolution.status !== "no_match") {
    throw new Error("compact receipt dropped judge/court resolution evidence");
  }
  const stderr = "provider traceback";
  const compactFailure = compactModelReceipt({
    stderr,
    stderr_sha256: sha256(stderr),
    stderr_bytes: Buffer.byteLength(stderr),
  }) as Record<string, unknown>;
  if (
    compactFailure.stderr_tail !== stderr ||
    compactFailure.stderr_sha256 !== sha256(stderr) ||
    compactFailure.stderr_bytes !== Buffer.byteLength(stderr)
  ) {
    throw new Error("compact model receipt dropped stderr diagnostics");
  }
  const appendTestDirectory = await mkdtemp(path.join(os.tmpdir(), "a2aj-jsonl-check-"));
  try {
    const appendTestFile = path.join(appendTestDirectory, "events.jsonl");
    await Promise.all(Array.from({ length: 32 }, (_, index) => appendJsonl(appendTestFile, { kind: "test", index })));
    const appended = (await readFile(appendTestFile, "utf8")).trim().split(/\r?\n/u).map((line) => JSON.parse(line) as Record<string, unknown>);
    if (appended.length !== 32 || new Set(appended.map(({ index }) => Number(index))).size !== 32) {
      throw new Error("concurrent JSONL append lost or interleaved receipts");
    }
    const budgetTestFile = path.join(appendTestDirectory, "call-ledger.jsonl");
    await writeFile(budgetTestFile, [
      { kind: "call_budget_carry_forward", attempted_calls: 2 },
      { kind: "model_call_started" },
      { kind: "model_call_retry_started", attempt: 2 },
      { kind: "model_call_finished", transport_retries: 1 },
    ].map((value) => JSON.stringify(value)).join("\n"), "utf8");
    if (await modelCallLedgerUsage(budgetTestFile) !== 4) {
      throw new Error("model-call budget did not count provider retries exactly once");
    }
  } finally {
    await rm(appendTestDirectory, { recursive: true, force: true });
  }
  console.log("PASS a2aj_decision_roster_qwen self-test");
}

function parseArgs(argv: string[]) {
  const [command = "help", ...rest] = argv;
  const args: Args = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = rest[index + 1];
    if (next && !next.startsWith("--")) { args[key] = next; index += 1; }
    else args[key] = true;
  }
  return { command, args };
}

async function main() {
  const { command, args } = parseArgs(process.argv.slice(2));
  if (command === "self-test") await selfTest();
  else if (command === "run") await run(args);
  else if (command === "codex") await run({ ...args, provider: "luna" });
  else if (command === "audit") await deterministicAudit(args);
  else if (command === "revalidate") await revalidateFrozenReceipts(args);
  else if (command === "manifest") await manifest(args);
  else if (command === "annotate") await annotate(args);
  else if (command === "compare") await compareRuns(args);
  else throw new Error("commands: self-test | run | codex | audit | revalidate | manifest | annotate | compare");
}

function startDeterministicScreenWorker() {
  if (!process.send) throw new Error("deterministic screen worker has no IPC channel");
  process.on("message", (message: { kind?: string; items?: DeterministicAuditItem[]; partFile?: string }) => {
    if (!Array.isArray(message.items)) return;
    if (message.kind === "audit_batch") {
      void (async () => {
        if (!message.partFile) throw new Error("audit worker part file is required");
        const counts = emptyAuditCounts();
        const lines = await mapPool(hydrateDeterministicItems(message.items!), 8, async (item) => {
          let receipt: Record<string, unknown>;
          try {
            receipt = await deterministicAuditReceipt(item);
          } catch (error) {
            receipt = {
              source: {
                document_id: item.documentId,
                dataset: item.candidate?.dataset ?? null,
                citation: item.candidate?.citation ?? null,
              },
              status: "load_failed",
              audit_error: errorMessage(error),
              legacy: item.legacy ?? null,
            };
          }
          countAudit(counts, receipt);
          return JSON.stringify({
            utc: now(),
            kind: "audit_result",
            index: item.auditIndex,
            document: (receipt.source as Record<string, unknown>).document_id,
            receipt,
          });
        });
        await writeFile(message.partFile, lines.length ? `${lines.join("\n")}\n` : "", "utf8");
        process.send!({
          kind: "audit_result",
          partFile: message.partFile,
          completed: lines.length,
          counts,
        } satisfies AuditWorkerReply);
      })().catch((error) => process.send!({
        kind: "audit_result",
        error: errorMessage(error),
      }));
      return;
    }
    if (message.kind !== "screen_batch") return;
    void (async () => {
      const events = await mapPool(hydrateDeterministicItems(message.items!), 8, async (item) => {
        try {
          return await deterministicScreenEvent(item);
        } catch (error) {
          return {
            kind: "screen_case",
            document: item.documentId,
            source: item.candidate,
            status: "parse_failed",
            source_chars: item.document?.text.length ?? 0,
            parse_error: errorMessage(error),
            needs_llm: true,
          };
        }
      });
      process.send!({ kind: "screen_result", events } satisfies ScreenWorkerReply);
    })().catch((error) => process.send!({
      kind: "screen_result",
      events: [{ kind: "screen_case", status: "worker_failed", parse_error: errorMessage(error), needs_llm: true }],
    } satisfies ScreenWorkerReply));
  });
  process.send({ kind: "screen_ready" });
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain && process.argv[2] === "deterministic-screen-worker") {
  startDeterministicScreenWorker();
} else if (isMain) {
  void (async () => {
    try {
      await main();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    } finally {
      await shutdownSourceStructureEngine();
    }
  })();
}
