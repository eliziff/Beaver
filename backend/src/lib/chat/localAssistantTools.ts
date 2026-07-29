import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { appUrl } from "../appRoutes";
import { SYSTEM_ASSISTANT_WORKFLOWS } from "../systemWorkflows";
import type { A2AJDocument, A2AJLocatorLookup } from "../a2aj";
import { linkLocalDocxCitations } from "../docxCitationLinking";
import { fixLocalDocxSupraCrossReferences } from "../docxDeterministicCleanup";
import { lintLocalDocxStructure } from "../docxStructuralLint";
import { draftingLint } from "../legalDraftingLint";
import { consolidateAmendment } from "../legalAmendOps";
import { computeDeadline } from "../legalDeadlines";
import type { DeadlineJurisdiction, DeadlineUnit } from "../legalDeadlines";
import { conflictScan } from "../legalConflictScan";
import { anchorCoverage, bilingualConcordance } from "../legalTextAnchors";
import {
  compileAgreementSkeleton,
  readSection,
  renderAgreementOutline,
} from "../legalTextSkeleton";
import { termDriftReport } from "../legalTermDrift";
import { extractDocxDraftingSource } from "../docxDraftingSource";
import { resolveDocxEvidenceCitations } from "../docxEvidenceCitations";
import { applyTrackedEdits, type EditInput } from "../docxTrackedChanges";
import {
  addLocalVersion,
  createLocalDocument,
  deleteLocalDocument,
  getLocalVersionFile,
  listLocalLibrary,
  updateLocalDocument,
  type LocalTrackedEdit,
} from "../localDocumentStore";
import { legalKnowledgeGraphStore } from "../legalKnowledgeGraphStore";
import { deriveOriginalPdfCandidates } from "../legalSourcePresentation";
import {
  LOCAL_PDF_LOCATOR_KINDS,
  lookupLocalPdfStructure,
  readLocalPdfEvidenceReceipt,
  rehydrateLocalPdfEvidence,
  type LocalPdfLinkEvidence,
  type LocalPdfLocatorKind,
} from "../localPdfLookup";
import {
  lookupProviderPdfReference,
  queueProviderPdfAttachment,
  rehydrateProviderPdfReference,
  type ProviderPdfAttachment,
  type ProviderPdfAttachmentState,
} from "../providerPdfLibraryBridge";
import {
  localPdfArtifactSessionForTurn,
  registerProviderPdfEvidenceForTurn,
} from "./localPdfEvidenceState";
import type {
  NormalizedToolCall,
  NormalizedToolResult,
  OpenAIToolSchema,
} from "../llm";
import { cachedParse } from "../parseCache";
import {
  getTableOfAuthoritiesJob,
  submitTableOfAuthoritiesDocument,
} from "../tableOfAuthorities";
import {
  A2AJ_TOOLS,
  executeA2AJTool,
} from "./tools/a2ajTools";
import { COURTLISTENER_TOOLS } from "./tools/courtlistenerTools";
import { CITATOR_TOOLS, executeCitatorTool } from "./tools/citatorTools";
import {
  COMPARE_VERSIONS_TOOLS,
  executeCompareVersionsTool,
} from "./tools/compareVersionsTool";
import { executeHansardTool, HANSARD_TOOLS } from "./tools/hansardTools";
import { PUBLIC_LEGAL_SOURCE_TOOLS } from "./tools/publicLegalSourceTools";
import {
  createPublicLegalSourceState,
  executePublicLegalSourceTool,
  type PublicLegalSourceState,
} from "./publicLegalSourceState";
import {
  applyTextOpsToDocx,
  type TextOpRequest,
  type TextOpScope,
} from "../docxTextOps";
import { TEXT_OP_NAMES } from "../textOps";
import {
  findRegexMatches,
  findTextMatches,
  renderMarkdownDocx,
  textParserFor,
} from "./tools/documentOps";
import {
  docxCautionNotes,
  docxPathologyReportFor,
} from "./tools/docxPathologyNotes";
import { TEXT_OPS_TOOLS, TOOLS, WORKFLOW_TOOLS } from "./tools/toolSchemas";
import {
  runLocalCourtlistenerTool,
  type CourtlistenerToolState,
} from "./courtlistenerToolRunner";

const tool = (
  name: string,
  description: string,
  parameters: Record<string, unknown>,
): OpenAIToolSchema => ({
  type: "function",
  function: { name, description, parameters },
});

const DOCUMENT_ID_PROPERTY = {
  type: "string", description: "DOCX document_id returned by library_list.",
};
const OPTIONAL_VERSION_ID_PROPERTY = {
  type: "string",
  description: "Optional Library version id. Omit for the active version.",
};

const LOCAL_LIBRARY_TOOLS: OpenAIToolSchema[] = [
  tool(
    "library_list",
    "List documents in the user's local Beaver Library with their app_url.",
    {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Optional case-insensitive filename filter.",
        },
        kind: {
          type: "string",
          enum: ["file", "template", "all"],
          description: "Library collection to list. Defaults to all.",
        },
      },
    },
  ),
  tool(
    "library_update_metadata",
    "Save jurisdiction, practice-area, document-type, description, and note metadata for a Library item. Only when the user asks to classify or annotate; do not invent facts.",
    {
      type: "object",
      properties: {
        document_id: { type: "string" },
        kind: { type: "string", enum: ["file", "template"] },
        metadata: {
          type: "object",
          properties: {
            jurisdiction: { type: "string" },
            areas_of_law: { type: "array", items: { type: "string" } },
            document_types: { type: "array", items: { type: "string" } },
            description: { type: "string" },
          },
        },
        notes: { type: "string" },
      },
      required: ["document_id", "kind"],
    },
  ),
  tool(
    "library_read",
    "Read the active version of a local Beaver Library document. mode=drafting adapts a DOCX precedent: it preserves headings, lists, tables, emphasis, and note pairing for translation into semantic Markdown.",
    {
      type: "object",
      properties: {
        document_id: { type: "string" },
        mode: {
          type: "string",
          enum: ["text", "drafting"],
          description:
            "Defaults to text. drafting is DOCX-only, version-bound, and returns bounded semantic HTML as document data.",
        },
        section: {
          type: "string",
          description:
            "Structural locator from the document's own numbering ('8.01', 'Article VIII', 'Schedule 7.01', 's. 8(2)'). Returns only that span, children included. library_outline lists the exact handles.",
        },
        offset: {
          type: "integer",
          minimum: 0,
          description:
            "Character offset to start from (text mode, no section). Pairs with library_find hits' `at` offsets.",
        },
        max_chars: {
          type: "integer",
          minimum: 200,
          maximum: 300000,
          description:
            "Characters to read from `offset`. Defaults to 24000 — a portion, not the whole document; the reply sets `truncated` when there is more.",
        },
      },
      required: ["document_id"],
    },
  ),
  tool(
    "library_outline",
    "Structural map of a Library document parsed from its own numbering: the ARTICLE/PART tree, every Section and (a)/(i) subsection with the handle library_read section= accepts, defined terms with their defining section, schedules/exhibits, and cross-reference counts. A ~100-page agreement maps to 1-3k tokens.",
    {
      type: "object",
      properties: {
        document_id: { type: "string" },
        max_chars: {
          type: "integer",
          minimum: 1000,
          maximum: 40000,
          description: "Outline character budget. Defaults to 8000.",
        },
      },
      required: ["document_id"],
    },
  ),
  tool(
    "library_find",
    "Search inside a local Beaver Library document and return matching excerpts with context. Each hit carries its enclosing structural handle (`section`, when numbered) and character offset (`at`), so the follow-up is a scoped or windowed library_read, not a whole-document read.",
    {
      type: "object",
      properties: {
        document_id: { type: "string" },
        query: { type: "string" },
        regex: {
          type: "boolean",
          description:
            "Query is a line-by-line JavaScript regex (^ and $ anchor to lines). Default false: literal, whitespace/quote tolerant.",
        },
        case_insensitive: {
          type: "boolean",
          description: "Regex mode only. Default false.",
        },
        max_results: { type: "integer", minimum: 1, maximum: 50 },
        context_chars: { type: "integer", minimum: 40, maximum: 2000 },
      },
      required: ["document_id", "query"],
    },
  ),
  tool(
    "library_lookup",
    "Return one exact structural unit from a parsed local Library PDF: page/range, artifact paragraph/range, paired footnote/range with propositions, or an encoded section/provision. Never guesses or reparses the whole document.",
    {
      type: "object",
      properties: {
        document_id: { type: "string" },
        version_id: {
          type: "string",
          description: "Optional Library version. Defaults to active.",
        },
        locator_kind: {
          type: "string",
          enum: [...LOCAL_PDF_LOCATOR_KINDS],
          description:
            "paragraph is parser artifact order; provision_paragraph is an encoded legal provision.",
        },
        locator: {
          type: "string",
          description:
            "Exact start locator, pair_id, note label, heading, or encoded provision ID.",
        },
        end_locator: {
          type: "string",
          description:
            "Optional inclusive range end; maximum 20 units.",
        },
        context_blocks: {
          type: "integer",
          minimum: 0,
          maximum: 2,
          description: "Exact structural neighbors on each side.",
        },
        page: {
          type: "integer",
          minimum: 1,
          description:
            "Optional page disambiguating a restarted footnote label.",
        },
        occurrence: {
          type: "integer",
          minimum: 1,
          description:
            "Optional occurrence disambiguating a restarted footnote label.",
        },
      },
      required: ["document_id", "locator_kind", "locator"],
    },
  ),
  tool(
    "library_evidence",
    "Rehydrate a prior mike-evidence handle from its immutable Library PDF version. The server verifies source, parser, artifact IDs, and text hash first.",
    {
      type: "object",
      properties: {
        handle: {
          type: "string",
          description: "Opaque mike-evidence:v1 handle from library_lookup.",
        },
      },
      required: ["handle"],
    },
  ),
  tool(
    "provider_pdf_lookup",
    "Resolve a provider PDF reference returned by a legal-source tool into one exact parsed structural unit; reports a queued state rather than reading the whole PDF. To rehydrate prior evidence, pass its handle with the same reference_id instead of a locator.",
    {
      type: "object",
      properties: {
        reference_id: {
          type: "string",
          description:
            "mike-provider-pdf:v1 reference returned by a source tool.",
        },
        handle: {
          type: "string",
          description:
            "Optional mike-evidence:v1 handle returned earlier for this reference.",
        },
        locator_kind: { type: "string", enum: [...LOCAL_PDF_LOCATOR_KINDS] },
        locator: { type: "string" },
        end_locator: { type: "string" },
        context_blocks: { type: "integer", minimum: 0, maximum: 2 },
        page: { type: "integer", minimum: 1 },
        occurrence: { type: "integer", minimum: 1 },
      },
      required: ["reference_id"],
    },
  ),
  tool(
    "library_link_docx_citations",
    "Create a new version of a local Library DOCX with verified provider links on its footnote citations. It splits and routes the footnotes itself; do not read, split, classify, or construct citation URLs before calling it.",
    {
      type: "object",
      properties: { document_id: DOCUMENT_ID_PROPERTY },
      required: ["document_id"],
    },
  ),
  tool(
    "library_fix_docx_supras",
    "Turn unambiguous plain 'supra note N' numbers in a local Library DOCX into native updating Word footnote cross-references. Creates a new version when it changes anything and reports ambiguous/restarted/split cases for review.",
    {
      type: "object",
      properties: { document_id: DOCUMENT_ID_PROPERTY },
      required: ["document_id"],
    },
  ),
  tool(
    "library_lint_docx_structure",
    "Structural lint on a local Library DOCX: broken internal cross-references, references to missing schedules/exhibits, numbering gaps and duplicates, duplicate or unused defined terms. Read-only; returns located findings plus a receipt of what was checked and abstained from.",
    {
      type: "object",
      properties: {
        document_id: DOCUMENT_ID_PROPERTY,
        version_id: OPTIONAL_VERSION_ID_PROPERTY,
      },
      required: ["document_id"],
    },
  ),
  tool(
    "library_anchor_coverage",
    "Diff typed anchors (money, percentages, ratios, dates, durations, areas, citations) between source documents and drafts by canonical value. Reports source-only anchors (candidate omissions), draft-only anchors (candidate unsourced figures), and words-vs-numerals mismatches. Triage rows for relevance.",
    {
      type: "object",
      properties: {
        source_document_ids: {
          type: "array",
          items: { type: "string" },
          description: "Library document_ids of the task's source documents.",
        },
        draft_document_ids: {
          type: "array",
          items: { type: "string" },
          description:
            "Library document_ids of the drafts to audit.",
        },
        max_rows_per_class: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description:
            "Rows per anchor class and direction. Defaults to 40.",
        },
      },
      required: ["source_document_ids", "draft_document_ids"],
    },
  ),
  tool(
    "library_conflict_scan",
    "Check that stated arithmetic closes across documents: parts against wholes and percentages, subtotals against totals, for money and quantities at each figure's stated precision. Returns the arithmetic shown plus abstentions for unpaired figures. Judge materiality yourself.",
    {
      type: "object",
      properties: {
        document_ids: {
          type: "array",
          items: { type: "string" },
          description: "Library document_ids to reconcile.",
        },
      },
      required: ["document_ids"],
    },
  ),
  tool(
    "library_apply_amendment",
    "Consolidate an amending instrument against a source Library document: US cut-and-bite and Canadian replace-style prose compiles into typed edit ops addressed by section label, applied with hard failures and verified by recompiling. DRY-RUN ONLY: returns per-op receipts, refusals, and a preview; never writes a version. Uncompilable instructions are refused, never guessed at.",
    {
      type: "object",
      properties: {
        source_document_id: {
          type: "string",
          description: "Library document_id of the instrument being amended.",
        },
        amendment_document_id: {
          type: "string",
          description:
            "Library document_id of the amending instrument; this or amendment_text.",
        },
        amendment_text: {
          type: "string",
          description:
            "Amendment prose pasted directly, when it is not a Library document.",
        },
        preview_chars: {
          type: "integer",
          minimum: 0,
          maximum: 20000,
          description:
            "Consolidated-text preview length. Defaults to 0 (receipts only).",
        },
      },
      required: ["source_document_id"],
    },
  ),
  tool(
    "library_deadline",
    "Compute a legal deadline with a derivation trace: Interpretation Act s. 27(2) exclude-first-include-last counting, s. 27(1) clear days, s. 28 month anniversaries with month-end clamping, s. 26 holiday rollover, and business days over statutory holiday tables (CA federal, CA-ON, CA-BC, CA-QC, US). Quote the returned trace.",
    {
      type: "object",
      properties: {
        anchor_date: {
          type: "string",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description: "ISO date the period runs from (or to, for direction=before).",
        },
        count: { type: "integer", minimum: 1, maximum: 10000 },
        unit: {
          type: "string",
          enum: ["day", "business_day", "clear_day", "week", "month", "year"],
        },
        direction: { type: "string", enum: ["after", "before"] },
        jurisdiction: {
          type: "string",
          enum: ["CA", "CA-ON", "CA-BC", "CA-QC", "US"],
          description: "Holiday table. Defaults to CA (federal).",
        },
        weekend: {
          type: "string",
          enum: ["sat_sun", "sun_only"],
          description:
            "Non-working weekend days. Federal s. 35 'holiday' is Sunday only; commercial Business Day excludes both. Defaults to sat_sun.",
        },
        extra_holidays: {
          type: "array",
          items: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          description: "Contract-designated additional non-business days.",
        },
      },
      required: ["anchor_date", "count", "unit"],
    },
  ),
  tool(
    "library_term_drift",
    "Diff defined terms across a deal stack of Library documents: the same term defined with divergent bodies (first difference excerpted), terms used where nothing defines them, and in-document duplicate definitions. Divergences are real wording differences — normalization touches only whitespace and quote glyphs. Needs two or more documents.",
    {
      type: "object",
      properties: {
        document_ids: {
          type: "array",
          items: { type: "string" },
          minItems: 2,
          description: "Library document_ids of the deal-stack documents.",
        },
        max_rows: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Rows per list. Defaults to 40.",
        },
      },
      required: ["document_ids"],
    },
  ),
  tool(
    "library_drafting_lint",
    "Modal-force and ambiguous-syntax lint over a Library document — 'may not' ambiguity, 'and/or', stacked-modal typos, mixed shall/must registers — each with exact spans, bounded excerpts, severity, and autofix eligibility, plus a modal profile. It DETECTS; judge each finding over its excerpt alone.",
    {
      type: "object",
      properties: {
        document_id: DOCUMENT_ID_PROPERTY,
        max_findings: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Max findings. Defaults to 50.",
        },
      },
      required: ["document_id"],
    },
  ),
  tool(
    "library_bilingual_concordance",
    "Concordance gate for equally-authentic bilingual instruments: every value-bearing anchor (money, dates, durations, percentages, statute refs, neutral citations) must appear in BOTH versions, French forms normalizing to the same keys ('2 250 000 $' = '$2,250,000'). Anchors in one version only are drafting or translation drift; triage rows for relevance.",
    {
      type: "object",
      properties: {
        english_document_id: {
          type: "string",
          description: "Library document_id of the English version.",
        },
        french_document_id: {
          type: "string",
          description: "Library document_id of the French version.",
        },
        max_rows_per_class: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Rows per anchor class. Defaults to 40.",
        },
      },
      required: ["english_document_id", "french_document_id"],
    },
  ),
  tool(
    "toa_submit_library_document",
    "Submit one owned DOCX Library version to the local Table of Authorities workflow. Detection is deterministic first, with a bounded cached Codex splitter only for unresolved citation units. Never pass or invent filesystem paths.",
    {
      type: "object",
      properties: {
        document_id: DOCUMENT_ID_PROPERTY,
        version_id: OPTIONAL_VERSION_ID_PROPERTY,
        split_fallback: {
          type: "string",
          enum: ["off", "auto"],
          description:
            "auto invokes the cached Codex splitter only when deterministic splitting is incomplete. Defaults to auto.",
        },
      },
      required: ["document_id"],
    },
  ),
  tool(
    "toa_job_status",
    "Inspect one Table of Authorities job from toa_submit_library_document: progress, review readiness, output downloads, and the Beaver page to open.",
    {
      type: "object",
      properties: { job_id: { type: "string", pattern: "^[0-9a-f]{32}$" } },
      required: ["job_id"],
    },
  ),
];

const LOCAL_DOCX_TOOLS: OpenAIToolSchema[] = (
  TOOLS as OpenAIToolSchema[]
).flatMap((schema) => {
  if (schema.function.name === "generate_docx") {
    return [
      {
        ...schema,
        function: {
          ...schema.function,
          name: "library_create_docx",
          description: `${schema.function.description} Stored as a durable new item in the local Library; matter chats attach it automatically.`,
        },
      },
    ];
  }
  if (schema.function.name === "edit_document") {
    const sharedProperties = schema.function.parameters.properties as Record<
      string,
      unknown
    >;
    return [
      tool(
        "library_revise_docx",
        "Apply requested edits, revisions, or redlines to an existing local Library DOCX as tracked changes. Use this for action requests instead of replying with proposed or suggested changes in prose. Beaver shows the resulting document card; the server edits the active version and non-DOCX documents fail unchanged.",
        {
          type: "object",
          properties: {
            document_id: {
              type: "string",
              description: "Exact document_id returned by library_list.",
            },
            version_id: {
              type: "string",
              description:
                "Optional. Omit for the active version; a specific id fails if it is no longer active.",
            },
            edits: sharedProperties.edits,
            annotate: {
              type: "boolean",
              description:
                "Off by default; set true ONLY if the user EXPLICITLY asks for in-document Word comments — edit reasons already reach the user through the tracked-edit card. When true, each reasoned edit gets an anchored comment and the version is auto-linted.",
            },
          },
          required: ["document_id", "edits"],
        },
      ),
    ];
  }
  return [];
});

const LOCAL_ASK_INPUTS_TOOLS = (TOOLS as OpenAIToolSchema[]).filter(
  (schema) => schema.function.name === "ask_inputs",
);

/**
 * MIKE_DISABLE_RESEARCH_TOOLS=1 removes the online legal-research tools
 * (CourtListener, A2AJ, public legal sources) and their system-prompt
 * sections from the local assistant — for sealed-environment runs where
 * the matter documents must be the only information source.
 */
export const RESEARCH_TOOLS_DISABLED =
  process.env.MIKE_DISABLE_RESEARCH_TOOLS === "1";

/**
 * MIKE_DISABLE_ASK_INPUTS=1 removes the ask-the-user tool — for benchmark
 * runs with no user on the other end. Parity note: the reference harness
 * has no ask-user affordance either, so a benchmark model must resolve
 * ambiguity from the task materials in both arms.
 */
export const ASK_INPUTS_DISABLED =
  process.env.MIKE_DISABLE_ASK_INPUTS === "1";

/**
 * MIKE_TOOL_SHAPE=coding swaps the library navigation surface for the
 * shapes coding agents are RL-trained on: Glob/Grep/Read over file paths,
 * line addressing, cat -n output. Handlers are shared; only the
 * model-facing schema changes. library_list stays as the document_id
 * bridge for the editing tools.
 */
export const CODING_TOOL_SHAPE = process.env.MIKE_TOOL_SHAPE === "coding";

const CODING_SHAPE_REPLACES = new Set([
  "library_find",
  "library_read",
  "library_outline",
  "library_list",
  "library_revise_docx",
]);

const CODING_SHAPE_SUGGESTIONS: Record<string, string> = {
  library_find: "Grep",
  library_read: "Read",
  library_outline: "Grep or Read",
  library_list: "Glob",
  library_revise_docx: "Edit",
};

const CODING_SHAPE_TOOLS: OpenAIToolSchema[] = [
  tool(
    "Glob",
    'Fast file pattern matching. Supports glob patterns like "*.docx". Returns matching file paths.',
    {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "The glob pattern to match files against",
        },
      },
      required: ["pattern"],
    },
  ),
  tool(
    "Grep",
    'Content search. Full regex syntax (e.g. "Base Rent", "clause\\s+\\d+"). Filter files with glob. output_mode: "content" shows matching lines, "files_with_matches" shows file paths (default), "count" shows match counts.',
    {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            "The regular expression pattern to search for in file contents",
        },
        path: {
          type: "string",
          description: "File to search in. Defaults to all files.",
        },
        glob: {
          type: "string",
          description: 'Glob pattern to filter files (e.g. "*.docx")',
        },
        output_mode: {
          type: "string",
          enum: ["content", "files_with_matches", "count"],
          description:
            'Output mode: "content" shows matching lines (supports -C context, -n line numbers, head_limit), "files_with_matches" shows file paths (default), "count" shows match counts.',
        },
        "-i": { type: "boolean", description: "Case insensitive search" },
        "-n": {
          type: "boolean",
          description:
            'Show line numbers in output. Requires output_mode: "content". Defaults to true.',
        },
        "-C": {
          type: "number",
          description:
            'Number of lines to show before and after each match. Requires output_mode: "content".',
        },
        head_limit: {
          type: "number",
          description:
            "Limit output to first N lines/entries. Defaults to 250.",
        },
      },
      required: ["pattern"],
    },
  ),
  tool(
    "Read",
    "Reads a file. Reads up to 2000 lines by default. Results are returned using cat -n format, with line numbers starting at 1. When you already know which part of the file you need, only read that part — pass a section handle (shown in Grep results as [handle]) to read just that section.",
    {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "The path to the file to read",
        },
        offset: {
          type: "number",
          description:
            "The line number to start reading from. Only provide if the file is too large to read at once",
        },
        limit: {
          type: "number",
          description:
            "The number of lines to read. Only provide if the file is too large to read at once.",
        },
        section: {
          type: "string",
          description:
            "Structural section handle (e.g. '3.1', 'sec8.01'). Returns only that section, numbered by document line.",
        },
      },
      required: ["file_path"],
    },
  ),
  tool(
    "Edit",
    "Performs exact string replacement in a file, recorded as a tracked change. old_string must match the file exactly and be unique — the edit fails otherwise; make it unique with more surrounding context, or pass section to scope the match to one section.",
    {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "The path to the file to modify",
        },
        old_string: { type: "string", description: "The text to replace" },
        new_string: {
          type: "string",
          description:
            "The text to replace it with (must be different from old_string)",
        },
        replace_all: {
          type: "boolean",
          description: "Replace all occurrences of old_string (default false)",
        },
        section: {
          type: "string",
          description:
            "Structural section handle; old_string must be unique within it.",
        },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  ),
];

export const LOCAL_ASSISTANT_TOOLS: OpenAIToolSchema[] = [
  ...(ASK_INPUTS_DISABLED ? [] : LOCAL_ASK_INPUTS_TOOLS),
  ...(CODING_TOOL_SHAPE
    ? [
        ...CODING_SHAPE_TOOLS,
        ...LOCAL_LIBRARY_TOOLS.filter(
          (entry) => !CODING_SHAPE_REPLACES.has(entry.function.name),
        ),
      ]
    : LOCAL_LIBRARY_TOOLS),
  ...LOCAL_DOCX_TOOLS,
  ...COMPARE_VERSIONS_TOOLS,
  ...(TEXT_OPS_TOOLS as OpenAIToolSchema[]),
  ...(WORKFLOW_TOOLS as OpenAIToolSchema[]),
  ...(RESEARCH_TOOLS_DISABLED
    ? []
    : [
        ...(COURTLISTENER_TOOLS as OpenAIToolSchema[]),
        ...(A2AJ_TOOLS as OpenAIToolSchema[]),
        ...(PUBLIC_LEGAL_SOURCE_TOOLS as OpenAIToolSchema[]),
        ...HANSARD_TOOLS,
        ...CITATOR_TOOLS,
      ]),
];

const trimmed = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const stringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
const optionalString = (value: unknown) =>
  typeof value === "string" ? value : undefined;
const optionalNumber = (value: unknown) =>
  typeof value === "number" ? value : undefined;
const clampInt = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === "number"
    ? Math.min(Math.max(Math.trunc(value), min), max)
    : fallback;
const sha256 = (value: string) =>
  crypto.createHash("sha256").update(value).digest("hex");
const errorText = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

// ---------------------------------------------------------------------------
// Coding-shape aliases: Glob/Grep/Read over the library, file-path addressed,
// line-numbered. Output mirrors the native tools (cat -n reads, rg-style
// match lines, plain-text errors) because the trained package is the whole
// interaction grammar, not just the schema names.
// ---------------------------------------------------------------------------

const globRegExp = (pattern: string) =>
  new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
      .replace(/\*\*/gu, "\u0000")
      .replace(/\*/gu, "[^/]*")
      .replace(/\?/gu, ".")
      .replace(/\u0000/gu, ".*")}$`,
    "iu",
  );

const GREP_LINE_CAP = 2_000;

/**
 * The revise operation, callable without dispatch: the Edit alias uses it
 * directly so the strict coding-shape surface can reject the public name
 * while the alias keeps the identical pinning, receipts, and lint hook.
 */
async function runLocalReviseDocx(
  call: NormalizedToolCall,
  userId: string,
  documentId: string,
  args: Record<string, unknown>,
): Promise<NormalizedToolResult> {
  let versionId = trimmed(args.version_id);
  const rawEdits = Array.isArray(args.edits) ? args.edits : [];
  if (!documentId || !rawEdits.length) {
    return fail(call, "document_id and edits are required");
  }
  // The model never has to courier a version id: unstated means the
  // active version, resolved here. A provided id still asserts.
  if (!versionId) {
    const collection = await listLocalLibrary(userId, "file");
    versionId =
      collection.documents.find((meta) => meta.id === documentId)
        ?.current_version_id ?? "";
    if (!versionId) return fail(call, "Document not found");
  }
  if (rawEdits.length > 100 || rawEdits.some(invalidReviseEdit)) {
    return fail(call, "edits are invalid");
  }
  try {
    const file = await getLocalVersionFile(userId, documentId, versionId);
    if (!file) return fail(call, "DOCX Library version not found");
    if (file.document.current_version_id !== versionId) {
      return fail(call, "version_id is not the active version");
    }
    if (file.fileType.toLowerCase() !== "docx") {
      return fail(call, "Revision requires a DOCX Library version");
    }
    const edits: EditInput[] = rawEdits
      .map((raw) => {
        const edit = raw as Record<string, unknown>;
        return {
          find: edit.find as string,
          replace: edit.replace as string,
          context_before: edit.context_before as string,
          context_after: edit.context_after as string,
          reason: typeof edit.reason === "string" ? edit.reason : undefined,
        };
      })
      .filter((edit) => edit.find !== edit.replace);
    if (!edits.length) {
      return result(call, {
        ok: false,
        error: "No revision was saved",
        edit_errors: ["Every requested edit was a no-op"],
      });
    }
    const annotate = args.annotate === true;
    const edited = await applyTrackedEdits(await readFile(file.path), edits, {
      author: "Beaver",
      annotate,
    });
    if (edited.errors.length || !edited.changes.length) {
      return result(call, {
        ok: false,
        error: "No revision was saved",
        edit_errors: edited.errors,
      });
    }
    const trackedEdits: LocalTrackedEdit[] = edited.changes.map((change) => ({
      id: crypto.randomUUID(),
      changeId: change.id,
      delWId: change.delId,
      insWId: change.insId,
      deletedText: change.deletedText,
      insertedText: change.insertedText,
      contextBefore: change.contextBefore,
      contextAfter: change.contextAfter,
      reason: change.reason,
      status: "pending",
    }));
    const version = await addLocalVersion({
      userId,
      documentId,
      filename: file.version.filename,
      bytes: edited.bytes,
      expectedVersionId: versionId,
      provenance: {
        schemaVersion: 1,
        actor: "assistant",
        action: "revised",
        parentVersionId: versionId,
        changeCount: edited.changes.length,
        trackedEdits,
      },
    });
    if (!version) return fail(call, "version_id is no longer active");
    // Every revision gets deterministic same-turn feedback: the
    // structural lint runs on the freshly produced version (the
    // determinism plan's receipt hook — not gated on annotate).
    const lint = await lintLocalDocxStructure(
      userId,
      documentId,
      version.id,
    ).catch(() => null);
    const downloadUrl =
      `/single-documents/${encodeURIComponent(documentId)}/file` +
      `?version_id=${encodeURIComponent(version.id)}`;
    return result(call, {
      ok: true,
      receipt: "mike-document:v1",
      action: "revised",
      document_id: documentId,
      parent_version_id: versionId,
      version_id: version.id,
      version_number: version.version_number,
      filename: version.filename,
      file_type: version.file_type,
      source_sha256: version.source_sha256,
      change_count: edited.changes.length,
      comment_count: edited.comments,
      // Counted on every revision so rationale coverage is a
      // measurable variable (annotate mode forces it to zero by
      // rejecting reason-free edits).
      edits_without_reason: edits.filter((edit) => !edit.reason?.trim()).length,
      structural_lint: lint
        ? {
            finding_count: lint.findings.length,
            findings: lint.findings
              .slice(0, 8)
              .map(({ code, severity, subject, message }) => ({
                code,
                severity,
                subject,
                message,
              })),
            notes: lint.notes,
          }
        : undefined,
      download_url: downloadUrl,
      annotations: trackedEdits.map((edit) => ({
        kind: "edit",
        edit_id: edit.id,
        document_id: documentId,
        version_id: version.id,
        version_number: version.version_number,
        change_id: edit.changeId,
        del_w_id: edit.delWId,
        ins_w_id: edit.insWId,
        deleted_text: edit.deletedText,
        inserted_text: edit.insertedText,
        context_before: edit.contextBefore,
        context_after: edit.contextAfter,
        reason: edit.reason,
        status: edit.status,
      })),
      
    });
  } catch {
    return fail(call, "DOCX revision failed");
  }
}

async function runCodingShapeCall(
  call: NormalizedToolCall,
  args: Record<string, unknown>,
  userId: string,
  allowedDocumentIds?: Set<string>,
): Promise<NormalizedToolResult> {
  const collection = await listLocalLibrary(userId, "file");
  const files = collection.documents.filter(
    (document) => !allowedDocumentIds || allowedDocumentIds.has(document.id),
  );
  const resolvePath = (raw: string) => {
    const wanted = raw.replace(/^\.?[\\/]/u, "").trim().toLowerCase();
    return files.find((document) => document.filename.toLowerCase() === wanted);
  };

  if (call.name === "Glob") {
    const re = globRegExp(trimmed(args.pattern) || "*");
    const names = files
      .map((document) => document.filename)
      .filter((name) => re.test(name));
    return result(call, names.length ? names.join("\n") : "No files found");
  }

  if (call.name === "Read") {
    const requested = trimmed(args.file_path);
    const meta = resolvePath(requested);
    if (!meta) {
      return result(
        call,
        `File does not exist: ${requested}\nAvailable files:\n${files.map((document) => document.filename).join("\n")}`,
      );
    }
    const document = await extractLocalDocument(userId, meta.id);
    if (!document) return result(call, `File could not be read: ${requested}`);
    const lines = document.text.split(/\r?\n/u);
    const offset = clampInt(args.offset, 1, 100_000_000, 1);
    const limit = clampInt(args.limit, 1, 2_000, 2_000);
    const sectionArg = trimmed(args.section);
    if (sectionArg) {
      const skeleton = compileAgreementSkeleton(document.text);
      const lookup = readSection(skeleton, sectionArg);
      if (lookup.status !== "found" || !lookup.block) {
        return result(
          call,
          `Section '${sectionArg}' not found (${lookup.status}` +
            (lookup.matches.length
              ? `; candidates: ${lookup.matches.join(", ")}`
              : "") +
            "). Grep for the wording, or Read without section.",
        );
      }
      const startLine =
        document.text.slice(0, lookup.block.start).split(/\r?\n/u).length;
      const blockLines = lookup.block.text.split(/\r?\n/u);
      const window = blockLines.slice(0, limit);
      const numbered = window.map((line, i) => {
        const text =
          line.length > GREP_LINE_CAP
            ? `${line.slice(0, GREP_LINE_CAP)}… [line truncated]`
            : line;
        return `${String(startLine + i).padStart(6, " ")}\t${text}`;
      });
      const more =
        window.length < blockLines.length
          ? `\n\n(Section continues. Read with offset=${startLine + window.length} for the rest; the section spans lines ${startLine}-${startLine + blockLines.length - 1}.)`
          : "";
      return result(call, numbered.join("\n") + more);
    }
    const window = lines.slice(offset - 1, offset - 1 + limit);
    if (!window.length) {
      return result(
        call,
        offset > lines.length
          ? `(offset ${offset} is past the end of the file; total lines: ${lines.length})`
          : "(empty file)",
      );
    }
    const numbered = window.map((line, i) => {
      const text =
        line.length > GREP_LINE_CAP
          ? `${line.slice(0, GREP_LINE_CAP)}… [line truncated]`
          : line;
      return `${String(offset + i).padStart(6, " ")}\t${text}`;
    });
    const lastShown = offset - 1 + window.length;
    const more =
      lastShown < lines.length
        ? `\n\n(File has more lines. Use 'offset' parameter to read beyond line ${lastShown}. Total lines: ${lines.length})`
        : "";
    return result(call, numbered.join("\n") + more);
  }

  if (call.name === "Edit") {
    const requested = trimmed(args.file_path);
    const meta = resolvePath(requested);
    if (!meta) return result(call, `File does not exist: ${requested}`);
    const oldString =
      typeof args.old_string === "string" ? args.old_string : "";
    const newString =
      typeof args.new_string === "string" ? args.new_string : "";
    if (!oldString) return result(call, "old_string is required");
    if (oldString === newString) {
      return result(call, "old_string and new_string must be different");
    }
    const sectionArg = trimmed(args.section);
    if (args.replace_all === true) {
      if (sectionArg) {
        return result(
          call,
          "replace_all with section is not supported yet; run Edit once per occurrence, or replace_all across the whole file.",
        );
      }
      // Global find/replace belongs to the deterministic text-ops engine.
      const [applied] = await runLocalAssistantTools(
        userId,
        [
          {
            id: `${call.id}-textops`,
            name: "library_apply_text_ops",
            input: {
              document_id: meta.id,
              ops: [
                {
                  op: "replace_text",
                  find: oldString,
                  replace: newString,
                  scope: { kind: "whole_document" },
                },
              ],
            },
          },
        ],
        undefined,
        undefined,
        undefined,
        undefined,
        allowedDocumentIds,
      );
      try {
        const payload = JSON.parse(applied.content) as {
          ok?: boolean;
          error?: string;
          change_count?: number;
          ops?: Array<{ replacements?: number }>;
        };
        if (payload.ok) {
          const count =
            payload.ops?.[0]?.replacements ?? payload.change_count ?? 0;
          return result(
            call,
            `Updated ${meta.filename}: ${count} replacement(s) applied as tracked changes.`,
          );
        }
        return result(
          call,
          `replace_all made no change: ${payload.error ?? applied.content}`,
        );
      } catch {
        return result(call, applied.content);
      }
    }
    // Section scope: uniqueness is required only within the named section;
    // the surrounding document text becomes the disambiguating context the
    // revise engine anchors on.
    let edit: {
      find: string;
      replace: string;
      context_before?: string;
      context_after?: string;
    } = { find: oldString, replace: newString };
    if (sectionArg) {
      const document = await extractLocalDocument(userId, meta.id);
      if (!document) {
        return result(call, `File could not be read: ${requested}`);
      }
      const skeleton = compileAgreementSkeleton(document.text);
      const lookup = readSection(skeleton, sectionArg);
      if (lookup.status !== "found" || !lookup.block) {
        return result(
          call,
          `Section '${sectionArg}' not found (${lookup.status}` +
            (lookup.matches.length
              ? `; candidates: ${lookup.matches.join(", ")}`
              : "") +
            ").",
        );
      }
      const occurrences: number[] = [];
      for (
        let at = lookup.block.text.indexOf(oldString);
        at !== -1 && occurrences.length < 4;
        at = lookup.block.text.indexOf(oldString, at + 1)
      ) {
        occurrences.push(at);
      }
      if (!occurrences.length) {
        return result(
          call,
          `old_string was not found within section ${lookup.block.label}. Read the section and match its text exactly.`,
        );
      }
      if (occurrences.length > 1) {
        return result(
          call,
          `old_string appears ${occurrences.length} times within section ${lookup.block.label}; enlarge it with surrounding context.`,
        );
      }
      const absolute = lookup.block.start + occurrences[0];
      edit = {
        find: oldString,
        replace: newString,
        context_before: document.text.slice(
          Math.max(0, absolute - 60),
          absolute,
        ),
        context_after: document.text.slice(
          absolute + oldString.length,
          absolute + oldString.length + 60,
        ),
      };
    }
    // Same pinning, receipts, and lint hook as the public revise tool; the
    // active version is resolved inside — Edit's contract has no version id.
    const revised = await runLocalReviseDocx(
      { id: `${call.id}-revise`, name: "library_revise_docx", input: {} },
      userId,
      meta.id,
      { edits: [edit] },
    );
    try {
      const payload = JSON.parse(revised.content) as {
        ok?: boolean;
        error?: string;
        edit_errors?: string[];
      };
      if (payload.ok) {
        return result(call, `Updated ${meta.filename}: 1 tracked change applied.`);
      }
      const reasons = payload.edit_errors?.length
        ? payload.edit_errors
        : [payload.error ?? "unknown error"];
      return result(
        call,
        `The edit could not be applied — no change was made.\n${reasons.join("\n")}\nProvide a larger old_string with more surrounding context.`,
      );
    } catch {
      return result(call, revised.content);
    }
  }

  // Grep
  const pattern = trimmed(args.pattern);
  if (!pattern) return result(call, "pattern is required");
  let re: RegExp;
  try {
    re = new RegExp(pattern, args["-i"] === true ? "iu" : "u");
  } catch (error) {
    return result(
      call,
      `regex parse error: ${errorText(error, "invalid pattern")}`,
    );
  }
  const pathArg = trimmed(args.path);
  let targets = files;
  if (pathArg) {
    const meta = resolvePath(pathArg);
    if (!meta) return result(call, `File does not exist: ${pathArg}`);
    targets = [meta];
  } else if (trimmed(args.glob)) {
    const globRe = globRegExp(trimmed(args.glob));
    targets = files.filter((document) => globRe.test(document.filename));
  }
  const mode =
    args.output_mode === "content" || args.output_mode === "count"
      ? args.output_mode
      : "files_with_matches";
  const headLimit = clampInt(args.head_limit, 1, 2_000, 250);
  const context = clampInt(args["-C"], 0, 10, 0);
  const numberLines = args["-n"] !== false;

  const rows: string[] = [];
  let truncated = false;
  for (const meta of targets) {
    const document = await extractLocalDocument(userId, meta.id);
    if (!document) continue;
    const lines = document.text.split(/\r?\n/u);
    const matched: number[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (re.test(lines[i])) matched.push(i);
    }
    if (!matched.length) continue;
    // Match lines carry the enclosing section handle so the follow-up is
    // Read section= rather than offset arithmetic.
    let sectionOf: ((line: number) => string | null) | null = null;
    if (mode === "content") {
      const skeleton = compileAgreementSkeleton(document.text);
      if (skeleton.nodes.length) {
        const offsets: number[] = [];
        let cursor = 0;
        for (const line of lines) {
          offsets.push(cursor);
          const next = document.text.indexOf("\n", cursor + line.length);
          cursor = next === -1 ? document.text.length : next + 1;
        }
        sectionOf = (line) => {
          const pos = offsets[line] ?? 0;
          let best: { label: string; span: number } | null = null;
          for (const node of skeleton.nodes) {
            if (pos >= node.start && pos < node.end) {
              const span = node.end - node.start;
              if (!best || span < best.span) best = { label: node.label, span };
            }
          }
          return best?.label ?? null;
        };
      }
    }
    if (mode === "files_with_matches") {
      rows.push(meta.filename);
      continue;
    }
    if (mode === "count") {
      rows.push(`${meta.filename}:${matched.length}`);
      continue;
    }
    let lastPrinted = -2;
    for (const at of matched) {
      if (rows.length >= headLimit) {
        truncated = true;
        break;
      }
      const from = Math.max(0, at - context);
      const to = Math.min(lines.length - 1, at + context);
      if (context && lastPrinted >= 0 && from > lastPrinted + 1) rows.push("--");
      for (let i = Math.max(from, lastPrinted + 1); i <= to; i += 1) {
        const sep = i === at ? ":" : "-";
        const prefix = numberLines
          ? `${meta.filename}${sep}${i + 1}${sep}`
          : `${meta.filename}${sep}`;
        const handle = sep === ":" ? sectionOf?.(i) : null;
        rows.push(
          `${prefix}${lines[i].slice(0, GREP_LINE_CAP)}${handle ? `  [${handle}]` : ""}`,
        );
        lastPrinted = i;
      }
    }
    if (truncated) break;
  }
  if (!rows.length) return result(call, "No matches found");
  const body = rows.slice(0, headLimit).join("\n");
  return result(
    call,
    truncated || rows.length > headLimit
      ? `${body}\n(Results truncated, showing first ${headLimit} lines. Narrow the pattern or pass head_limit.)`
      : body,
  );
}

function pdfLocatorParams(args: Record<string, unknown>) {
  return {
    locatorKind: args.locator_kind as LocalPdfLocatorKind,
    locator: typeof args.locator === "string" ? args.locator : "",
    endLocator: optionalString(args.end_locator),
    contextBlocks: optionalNumber(args.context_blocks),
    page: optionalNumber(args.page),
    occurrence: optionalNumber(args.occurrence),
  };
}

const textCache = new Map<string, { text: string; cautions: string[] }>();

export async function extractLocalDocument(userId: string, documentId: string) {
  const file = await getLocalVersionFile(userId, documentId);
  if (!file) return null;
  const cacheKey = `${documentId}:${file.version.id}:${file.version.created_at}`;
  const cached = textCache.get(cacheKey);
  if (cached !== undefined) {
    return { filename: file.document.filename, ...cached };
  }

  const bytes = await readFile(file.path);
  const fileType = file.fileType.toLowerCase();
  const parser = textParserFor(fileType);
  const text = parser
    ? await cachedParse({
        scope: `user:${userId}`,
        parser: parser.parser,
        version: parser.version,
        bytes,
        parse: () => parser.run(bytes),
      })
    : "";
  // Additive metadata only: the sniffer's cautions ride alongside the text,
  // which stays byte-identical to what this function has always returned.
  const cautions = docxCautionNotes(
    await docxPathologyReportFor({ fileType, scope: `user:${userId}`, bytes }),
  );

  if (textCache.size >= 16) {
    textCache.delete(textCache.keys().next().value!);
  }
  textCache.set(cacheKey, { text, cautions });
  return { filename: file.document.filename, text, cautions };
}

async function extractLocalDraftingDocument(
  userId: string,
  documentId: string,
) {
  const file = await getLocalVersionFile(userId, documentId);
  if (!file) return null;
  if (
    file.document.current_version_id !== file.version.id ||
    file.fileType.toLowerCase() !== "docx"
  ) {
    throw new Error("Drafting mode requires an active DOCX version");
  }
  const source = await extractDocxDraftingSource(await readFile(file.path));
  if (
    file.version.source_sha256 &&
    file.version.source_sha256 !== source.source_sha256
  ) {
    throw new Error("Library version bytes no longer match their receipt");
  }
  return {
    filename: file.document.filename,
    document_id: documentId,
    version_id: file.version.id,
    version_number: file.version.version_number,
    ...source,
  };
}

/**
 * Transport ceiling for a single tool result. Every organ here has its own
 * cap, but nothing enforced a floor under all of them, and an oversized result
 * is not paid once — the adapters re-send the whole transcript each round, so
 * one unbounded read is re-billed for the rest of the turn.
 *
 * 64,000 sits above every deliberate read (section reads cap at 60,000, as
 * does PDF lookup), so it bites untargeted whole-document reads and nothing
 * else. Trimming takes the head AND the tail, because a clause's proviso lives
 * at its end.
 */
const MAX_TOOL_RESULT_CHARS = Number(
  process.env.MIKE_TOOL_RESULT_CAP || 64_000,
);

/**
 * A cap the model cannot act on is just a hole in the answer, so say what was
 * dropped and name the calls that fetch it back. Beaver can be more specific
 * than a byte offset: it has addressable section handles.
 */
function continuationHint(call: NormalizedToolCall, omitted: number): string {
  const documentId =
    typeof call.input?.document_id === "string" ? call.input.document_id : "";
  const target = documentId ? `document_id="${documentId}"` : "this document";
  return (
    `\n\n[This result was shortened. ${omitted.toLocaleString("en-CA")} characters from the middle are not shown here. ` +
    `The document itself is complete and nothing has been lost — you are seeing part of it. ` +
    `To see more, read one piece at a time instead of the whole document: ` +
    `call library_outline with ${target} to list the document's sections, then call library_read with ${target} ` +
    `and the section you want. To find specific wording, call library_find with ${target} and your search text; ` +
    `each match includes a character position called "at", which you can pass to library_read as "offset" ` +
    `to read the text around it.]`
  );
}

function result(
  call: NormalizedToolCall,
  content: unknown,
): NormalizedToolResult {
  const serialized =
    typeof content === "string" ? content : JSON.stringify(content);
  if (serialized.length <= MAX_TOOL_RESULT_CHARS) {
    return { tool_use_id: call.id, content: serialized };
  }
  // Trim the one oversized string field rather than the envelope, so the
  // result the model parses stays well-formed JSON.
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const record = { ...(content as Record<string, unknown>) };
    let widest: string | null = null;
    for (const [key, value] of Object.entries(record)) {
      if (
        typeof value === "string" &&
        (widest === null || value.length > (record[widest] as string).length)
      ) {
        widest = key;
      }
    }
    const text = widest === null ? null : (record[widest] as string);
    if (widest !== null && text !== null) {
      const envelope = serialized.length - text.length;
      const keep = MAX_TOOL_RESULT_CHARS - envelope - 900;
      if (keep > 2_000) {
        const head = Math.floor(keep * 0.7);
        record[widest] =
          text.slice(0, head) + "\n…\n" + text.slice(text.length - (keep - head));
        record.truncated = true;
        record.continuation = continuationHint(call, text.length - keep);
        return { tool_use_id: call.id, content: JSON.stringify(record) };
      }
    }
  }
  return {
    tool_use_id: call.id,
    content:
      serialized.slice(0, MAX_TOOL_RESULT_CHARS) +
      continuationHint(call, serialized.length - MAX_TOOL_RESULT_CHARS),
  };
}

const fail = (call: NormalizedToolCall, error: string) =>
  result(call, { ok: false, error });

const SAFE_PDF_EVIDENCE_ERRORS = new Set([
  "Invalid PDF evidence handle",
  "Invalid PDF evidence receipt",
  "PDF evidence receipt handle does not match its content",
  "PDF evidence receipt does not belong to this source",
  "PDF evidence source bytes no longer match their version",
  "PDF evidence no longer matches the authoritative source artifacts",
]);

const pdfEvidenceError = (error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  return SAFE_PDF_EVIDENCE_ERRORS.has(message)
    ? message
    : "PDF evidence is unavailable";
};

type LocalPdfLookupResult =
  | Awaited<ReturnType<typeof lookupLocalPdfStructure>>
  | Awaited<ReturnType<typeof rehydrateLocalPdfEvidence>>;
const MAX_COMPACT_PDF_MATCHES = 20;

function compactPdfLookup(filename: string, lookup: LocalPdfLookupResult) {
  if (lookup.status !== "found") {
    const matches = lookup.matches.slice(0, MAX_COMPACT_PDF_MATCHES);
    return {
      ok: false,
      filename,
      status: lookup.status,
      exact: false,
      ...(matches.length ? { matches } : {}),
      ...(lookup.matches.length > matches.length
        ? { matches_truncated: true }
        : {}),
      ...("error" in lookup ? { error: lookup.error } : {}),
    };
  }
  const confidence = lookup.units
    .map((unit) => unit.confidence)
    .filter((value): value is number => typeof value === "number");
  return {
    ok: true,
    filename,
    status: lookup.status,
    exact: true,
    handle: lookup.evidence.handle,
    version_id: lookup.source.version_id,
    units: lookup.units,
    context: { before: lookup.before, after: lookup.after },
    confidence: confidence.length ? Math.min(...confidence) : null,
    link: {
      ...(lookup.evidence.page_text_sha256 &&
      lookup.evidence.page_numbers?.length
        ? { href: lookup.link.href }
        : {}),
      page_numbers: lookup.link.page_numbers,
    },
  };
}

type ReadyProviderPdfLookup = {
  availability: "ready";
  state: ProviderPdfAttachmentState;
  params: ProviderPdfAttachment;
  lookup: LocalPdfLookupResult;
  linkEvidence: LocalPdfLinkEvidence | null;
};

function compactProviderPdfLookup(resolved: ReadyProviderPdfLookup) {
  const filename =
    resolved.params.title ||
    resolved.params.filename ||
    resolved.params.identity;
  const compact = compactPdfLookup(filename, resolved.lookup);
  const freshness = {
    freshness_status: resolved.state.freshness_status,
    fetched_at: resolved.state.fetched_at,
    checked_at: resolved.state.checked_at,
    ...(resolved.state.freshness_status === "stale"
      ? {
          freshness_warning:
            "The exact cached PDF is verified, but its latest refresh failed or is due.",
        }
      : {}),
  };
  if (resolved.lookup.status !== "found") {
    return {
      ...compact,
      ...freshness,
      reference_id: resolved.state.reference_id,
      request_reference: resolved.state.request_reference,
      source_reference: resolved.state.source_reference,
    };
  }
  const pageNumbers =
    resolved.linkEvidence?.pageNumbers ?? resolved.lookup.link.page_numbers;
  const sourceUrl = new URL(resolved.params.url);
  if (pageNumbers[0]) sourceUrl.hash = `page=${pageNumbers[0]}`;
  return {
    ...compact,
    ...freshness,
    reference_id: resolved.state.reference_id,
    request_reference: resolved.state.request_reference,
    source_reference: resolved.state.source_reference,
    link: { href: sourceUrl.toString(), page_numbers: pageNumbers },
  };
}

async function queueA2ajPdfFallback(
  source: Pick<
    A2AJDocument,
    "url" | "dataset" | "citation" | "name" | "structure"
  >,
) {
  if (!source.url || source.structure.source !== "flat_text") return null;
  const candidate = deriveOriginalPdfCandidates({
    canonicalUrl: source.url,
  })[0];
  if (!candidate) return null;
  try {
    return await queueProviderPdfAttachment({
      provider: "a2aj",
      identity: `${source.dataset}:${source.citation}`,
      structureSource: "flat_text",
      url: candidate.url,
      canonicalUrl: source.url,
      title: source.name || source.citation,
    });
  } catch {
    return null;
  }
}

const REVISE_EDIT_KEYS = [
  "find",
  "replace",
  "context_before",
  "context_after",
] as const;

function invalidReviseEdit(raw: unknown) {
  if (!raw || typeof raw !== "object") return true;
  const edit = raw as Record<string, unknown>;
  return REVISE_EDIT_KEYS.some(
    (key) =>
      typeof edit[key] !== "string" || (edit[key] as string).length > 100_000,
  );
}

const TEXT_OP_STRING_LIMIT = 5000;

/** Parse and bound-check the raw ops array; returns an error string on any
 *  malformed op so the model gets a correctable message. */
function parseTextOpRequests(raw: unknown): TextOpRequest[] | string {
  if (!Array.isArray(raw) || !raw.length || raw.length > 20) {
    return "ops must be an array of 1 to 20 operations";
  }
  const boundedString = (value: unknown) =>
    typeof value === "string" && value.length <= TEXT_OP_STRING_LIMIT;
  const requests: TextOpRequest[] = [];
  for (const [index, item] of raw.entries()) {
    const at = `ops[${index}]`;
    if (!item || typeof item !== "object") return `${at} must be an object`;
    const op = item as Record<string, unknown>;
    if (typeof op.op !== "string" || !TEXT_OP_NAMES.includes(op.op)) {
      return `${at}.op must be one of: ${TEXT_OP_NAMES.join(", ")}`;
    }
    const rawScope = op.scope as Record<string, unknown> | undefined;
    if (!rawScope || typeof rawScope !== "object") {
      return `${at}.scope is required`;
    }
    let scope: TextOpScope;
    if (rawScope.kind === "whole_document") {
      scope = { kind: "whole_document" };
    } else if (rawScope.kind === "find_text") {
      if (!boundedString(rawScope.text) || !(rawScope.text as string).trim()) {
        return `${at}.scope.text is required for find_text`;
      }
      scope = {
        kind: "find_text",
        text: rawScope.text as string,
        ...(typeof rawScope.occurrence === "number"
          ? { occurrence: Math.trunc(rawScope.occurrence) }
          : {}),
      };
    } else if (rawScope.kind === "range") {
      if (
        !boundedString(rawScope.from_text) ||
        !(rawScope.from_text as string).trim() ||
        !boundedString(rawScope.to_text) ||
        !(rawScope.to_text as string).trim()
      ) {
        return `${at}.scope.from_text and to_text are required for range`;
      }
      scope = {
        kind: "range",
        from_text: rawScope.from_text as string,
        to_text: rawScope.to_text as string,
      };
    } else {
      return `${at}.scope.kind must be whole_document, find_text, or range`;
    }
    if (op.op === "replace_text" && !boundedString(op.find)) {
      return `${at}.find is required for replace_text`;
    }
    requests.push({
      op: op.op,
      scope,
      ...(boundedString(op.find) ? { find: op.find as string } : {}),
      ...(boundedString(op.replace) ? { replace: op.replace as string } : {}),
      ...(typeof op.match_case === "boolean" ? { match_case: op.match_case } : {}),
      ...(typeof op.whole_word === "boolean" ? { whole_word: op.whole_word } : {}),
      ...(typeof op.occurrence === "number"
        ? { occurrence: Math.trunc(op.occurrence) }
        : {}),
      ...(typeof op.style === "string" && op.style.length <= 20
        ? { style: op.style }
        : {}),
    });
  }
  return requests;
}

const DOCX_WORKFLOWS: Record<
  string,
  {
    run: (
      userId: string,
      documentId: string,
      versionId: string | undefined,
    ) => Promise<unknown>;
    fallback: string;
  }
> = {
  library_link_docx_citations: {
    run: (userId, documentId) => linkLocalDocxCitations(userId, documentId),
    fallback: "DOCX citation linking failed",
  },
  library_fix_docx_supras: {
    run: (userId, documentId) =>
      fixLocalDocxSupraCrossReferences(userId, documentId),
    fallback: "DOCX supra cleanup failed",
  },
  library_lint_docx_structure: {
    run: (userId, documentId, versionId) =>
      lintLocalDocxStructure(userId, documentId, versionId),
    fallback: "DOCX structural lint failed",
  },
};

export async function runLocalAssistantTools(
  userId: string,
  calls: NormalizedToolCall[],
  a2ajLookups?: A2AJLocatorLookup[],
  a2ajDocuments?: A2AJDocument[],
  courtlistenerState?: CourtlistenerToolState,
  publicLegalState?: PublicLegalSourceState,
  allowedDocumentIds?: Set<string>,
  localPdfEvidenceHandles?: Set<string>,
  matterId?: string | null,
): Promise<NormalizedToolResult[]> {
  const publicState = publicLegalState ?? createPublicLegalSourceState();
  return Promise.all(
    calls.map(async (call) => {
      const args = call.input;
      if (
        CODING_TOOL_SHAPE &&
        (call.name === "Glob" ||
          call.name === "Grep" ||
          call.name === "Read" ||
          call.name === "Edit")
      ) {
        return runCodingShapeCall(call, args, userId, allowedDocumentIds);
      }
      // Strict surface: names the shape swap removed must fail loudly, or a
      // prompt that still mentions them silently un-does the experiment.
      // Sits ahead of every handler — the guard is only as strict as its
      // position in this chain.
      if (CODING_TOOL_SHAPE && CODING_SHAPE_REPLACES.has(call.name)) {
        return result(
          call,
          `No such tool available: ${call.name}. Use ${CODING_SHAPE_SUGGESTIONS[call.name]} (files are addressed by file path from Glob).`,
        );
      }
      const publicLegalResult = await executePublicLegalSourceTool(
        call.name,
        args,
        publicState,
        userId,
      );
      if (publicLegalResult) return result(call, publicLegalResult);
      if (courtlistenerState) {
        const courtlistenerResult = await runLocalCourtlistenerTool(
          call,
          courtlistenerState,
          userId,
        );
        if (courtlistenerResult) return courtlistenerResult;
      }
      if (call.name === "list_workflows") {
        return result(
          call,
          SYSTEM_ASSISTANT_WORKFLOWS.map((workflow) => ({
            id: workflow.id,
            title: workflow.title,
            app_url: appUrl({
              kind: "workflow",
              id: workflow.id,
              workflowType: "assistant",
            }),
          })),
        );
      }
      if (call.name === "read_workflow") {
        const workflowId = trimmed(args.workflow_id);
        const workflow = SYSTEM_ASSISTANT_WORKFLOWS.find(
          (candidate) => candidate.id === workflowId,
        );
        return result(
          call,
          workflow?.skill_md ?? `Workflow '${workflowId}' not found.`,
        );
      }
      const documentId = trimmed(args.document_id);
      if (
        allowedDocumentIds &&
        documentId &&
        !allowedDocumentIds.has(documentId)
      ) {
        return fail(call, "Document is not attached to this matter");
      }
      if (call.name === "provider_pdf_lookup") {
        const reference = trimmed(args.reference_id);
        const handle = trimmed(args.handle);
        if (!reference) {
          return result(call, {
            ok: false, status: "error", error: "reference_id is required",
          });
        }
        try {
          const resolved = handle
            ? await rehydrateProviderPdfReference(reference, handle)
            : await lookupProviderPdfReference(
                reference,
                pdfLocatorParams(args),
              );
          if (resolved.availability !== "ready") {
            return result(call, {
              ok: false,
              status: resolved.availability,
              ...("state" in resolved ? resolved.state : {}),
              ...("error" in resolved && resolved.error
                ? { error: resolved.error }
                : {}),
              next_required_action:
                resolved.availability === "queued"
                  ? "The exact provider PDF parse is queued. Retry this reference later."
                  : "Use the authoritative provider text already returned.",
            });
          }
          if (
            resolved.lookup.status === "found" &&
            resolved.linkEvidence &&
            resolved.state.source_reference &&
            localPdfEvidenceHandles
          ) {
            localPdfEvidenceHandles.add(resolved.lookup.evidence.handle);
            registerProviderPdfEvidenceForTurn(
              localPdfEvidenceHandles,
              resolved.lookup.evidence.handle,
              resolved.state.source_reference,
              resolved.params.url,
              resolved.params.title ||
                resolved.params.filename ||
                resolved.params.identity,
              resolved.linkEvidence,
            );
          }
          return result(call, compactProviderPdfLookup(resolved));
        } catch (error) {
          return result(call, {
            ok: false,
            status: "error",
            error:
              error instanceof Error &&
              /^(?:Provider PDF|Invalid PDF evidence|PDF evidence)/u.test(
                error.message,
              )
                ? error.message
                : "Provider PDF lookup is unavailable",
          });
        }
      }
      if (call.name === "library_create_docx") {
        const title = trimmed(args.title);
        const markdown = trimmed(args.markdown);
        if (!title || title.length > 256 || !markdown) {
          return fail(call, "DOCX title or Markdown is invalid");
        }
        try {
          const evidence = await resolveDocxEvidenceCitations(
            userId,
            args.sources,
            allowedDocumentIds,
          );
          const rendered = await renderMarkdownDocx(
            title,
            markdown,
            args.fields,
            {
              landscape: args.landscape === true,
              citations: evidence.citations,
            },
          );
          if ("error" in rendered) return fail(call, rendered.error);
          const document = await createLocalDocument({
            userId,
            kind: "file",
            filename: rendered.filename,
            bytes: rendered.bytes,
            provenance: {
              schemaVersion: 1,
              actor: "assistant",
              action: "created",
              generation: {
                rendererVersion: "beaver.docx-markdown.v1",
                markdownSha256: sha256(markdown),
                fieldValuesSha256: sha256(JSON.stringify(args.fields ?? [])),
                sourceRegistrySha256: sha256(
                  JSON.stringify(args.sources ?? []),
                ),
                evidenceBindings: evidence.bindings.map((binding) => ({
                  id: binding.id,
                  handles: binding.handles,
                  sourceSha256: binding.source_sha256,
                  locators: binding.locators,
                  url: binding.url,
                })),
              },
            },
          });
          if (matterId) {
            try {
              if (
                !legalKnowledgeGraphStore().attachMatterDocument(
                  userId,
                  matterId,
                  document.id,
                )
              ) {
                await deleteLocalDocument(userId, document.id);
                return fail(call, "Matter not found");
              }
            } catch {
              await deleteLocalDocument(userId, document.id).catch(
                () => undefined,
              );
              return fail(call, "Could not attach document to matter");
            }
          }
          allowedDocumentIds?.add(document.id);
          const downloadUrl =
            `/single-documents/${encodeURIComponent(document.id)}/file` +
            `?version_id=${encodeURIComponent(document.current_version_id)}`;
          return result(call, {
            ok: true,
            receipt: "mike-document:v1",
            action: "created",
            document_id: document.id,
            version_id: document.current_version_id,
            version_number: document.active_version_number,
            filename: document.filename,
            file_type: document.file_type,
            source_sha256: document.source_sha256,
            attached_to_matter: Boolean(matterId),
            download_url: downloadUrl,
            
          });
        } catch {
          return fail(call, "DOCX creation failed");
        }
      }

      if (call.name === "library_revise_docx") {
        return runLocalReviseDocx(call, userId, documentId, args);
      }

      if (call.name === "library_apply_text_ops") {
        const versionId = trimmed(args.version_id);
        if (!documentId) return fail(call, "document_id is required");
        const requests = parseTextOpRequests(args.ops);
        if (typeof requests === "string") return fail(call, requests);
        try {
          const file = await getLocalVersionFile(
            userId,
            documentId,
            versionId || undefined,
          );
          if (!file) return fail(call, "DOCX Library version not found");
          if (file.document.current_version_id !== file.version.id) {
            return fail(call, "version_id is not the active version");
          }
          if (file.fileType.toLowerCase() !== "docx") {
            return fail(call, "Text operations require a DOCX Library version");
          }
          const applied = await applyTextOpsToDocx(
            await readFile(file.path),
            requests,
          );
          const opReports = applied.reports.map((report) => ({
            op: report.op,
            replacements: report.replacements,
            unchanged_sites: report.notes,
          }));
          if (!applied.replacementCount) {
            // Valid outcome, not an error: report-only ops (check_spelling)
            // and transforms that found nothing to change land here.
            return result(call, {
              ok: true,
              action: "no_changes",
              document_id: documentId,
              version_id: file.version.id,
              change_count: 0,
              ops: opReports,
              next_required_action:
                "No tracked changes and no new version. Report the per-op notes to the user.",
            });
          }
          if (!applied.edits.length) {
            return result(call, {
              ok: false,
              error: "No revision was saved",
              ops: opReports,
              ...(applied.editErrors.length
                ? { edit_errors: applied.editErrors }
                : {}),
            });
          }
          const reason = requests
            .map((request) => request.op)
            .join(", ")
            .slice(0, 100);
          const trackedEdits: LocalTrackedEdit[] = applied.edits.map(
            (edit) => ({
              id: crypto.randomUUID(),
              changeId: edit.changeId,
              delWId: edit.delWId,
              insWId: edit.insWId,
              deletedText: edit.deletedText,
              insertedText: edit.insertedText,
              contextBefore: edit.contextBefore,
              contextAfter: edit.contextAfter,
              reason,
              status: "pending",
            }),
          );
          const version = await addLocalVersion({
            userId,
            documentId,
            filename: file.version.filename,
            bytes: applied.bytes,
            expectedVersionId: file.version.id,
            provenance: {
              schemaVersion: 1,
              actor: "assistant",
              action: "revised",
              parentVersionId: file.version.id,
              changeCount: trackedEdits.length,
              trackedEdits,
            },
          });
          if (!version) return fail(call, "version_id is no longer active");
          const downloadUrl =
            `/single-documents/${encodeURIComponent(documentId)}/file` +
            `?version_id=${encodeURIComponent(version.id)}`;
          return result(call, {
            ok: true,
            receipt: "mike-document:v1",
            action: "revised",
            document_id: documentId,
            parent_version_id: file.version.id,
            version_id: version.id,
            version_number: version.version_number,
            filename: version.filename,
            file_type: version.file_type,
            source_sha256: version.source_sha256,
            change_count: trackedEdits.length,
            download_url: downloadUrl,
            ops: opReports,
            ...(applied.editErrors.length
              ? { edit_errors: applied.editErrors }
              : {}),
            annotations: trackedEdits.map((edit) => ({
              kind: "edit",
              edit_id: edit.id,
              document_id: documentId,
              version_id: version.id,
              version_number: version.version_number,
              change_id: edit.changeId,
              del_w_id: edit.delWId,
              ins_w_id: edit.insWId,
              deleted_text: edit.deletedText,
              inserted_text: edit.insertedText,
              context_before: edit.contextBefore,
              context_after: edit.contextAfter,
              reason: edit.reason,
              status: edit.status,
            })),
            next_required_action:
              "Mention any unchanged_sites when you confirm.",
          });
        } catch (error) {
          return fail(
            call,
            errorText(error, "Deterministic text operations failed"),
          );
        }
      }

      if (call.name === "library_list") {
        const kind =
          args.kind === "file" || args.kind === "template" ? args.kind : "all";
        const query = trimmed(args.query).toLowerCase();
        const collections =
          kind === "all"
            ? await Promise.all([
                listLocalLibrary(userId, "file"),
                listLocalLibrary(userId, "template"),
              ])
            : [await listLocalLibrary(userId, kind)];
        const documents = collections
          .flatMap((collection) => collection.documents)
          .filter(
            (document) =>
              !allowedDocumentIds || allowedDocumentIds.has(document.id),
          )
          .filter(
            (document) =>
              !query ||
              [
                document.filename,
                document.metadata?.jurisdiction,
                ...(document.metadata?.areas_of_law ?? []),
                ...(document.metadata?.document_types ?? []),
                document.metadata?.description,
                document.notes,
              ]
                .filter(Boolean)
                .join(" ")
                .toLowerCase()
                .includes(query),
          )
          .map((document) => ({
            document_id: document.id,
            filename: document.filename,
            file_type: document.file_type,
            kind: document.library_kind,
            version_id: document.current_version_id,
            version_number: document.active_version_number,
            version_provenance: document.version_provenance,
            updated_at: document.updated_at,
            metadata: document.metadata,
            notes: document.notes,
            app_url: appUrl({
              kind: "library-document",
              libraryKind: document.library_kind,
              projectId: matterId,
            }),
          }));
        return result(call, { ok: true, documents });
      }

      if (call.name === "library_update_metadata") {
        const documentId = trimmed(args.document_id);
        const kind = args.kind === "template" ? "template" : "file";
        if (!documentId) return fail(call, "document_id is required");
        const updated = await updateLocalDocument({
          userId,
          kind,
          documentId,
          metadata: args.metadata,
          notes: args.notes,
        });
        return updated
          ? result(call, {
              ok: true,
              document_id: updated.id,
              filename: updated.filename,
              metadata: updated.metadata,
              notes: updated.notes,
              app_url: appUrl({
                kind: "library-document",
                libraryKind: kind,
                projectId: matterId,
              }),
            })
          : fail(call, "Document not found");
      }

      if (call.name === "library_read" || call.name === "library_find") {
        if (!documentId) return fail(call, "document_id is required");
        if (call.name === "library_read" && args.mode === "drafting") {
          try {
            const source = await extractLocalDraftingDocument(
              userId,
              documentId,
            );
            return source
              ? result(call, { ok: true, ...source })
              : fail(call, "Document not found");
          } catch (error) {
            return fail(
              call,
              errorText(error, "Drafting source could not be read"),
            );
          }
        }
        const document = await extractLocalDocument(userId, documentId);
        if (!document) return fail(call, "Document not found");
        if (call.name === "library_read") {
          const sectionLocator = trimmed(args.section);
          if (sectionLocator) {
            const skeleton = compileAgreementSkeleton(document.text);
            const lookup = readSection(skeleton, sectionLocator);
            if (lookup.status !== "found" || !lookup.block) {
              return result(call, {
                ok: false,
                error:
                  `Section '${sectionLocator}' not found (${lookup.status}` +
                  (lookup.matches.length
                    ? `; candidates: ${lookup.matches.join(", ")}`
                    : "") +
                  "). Call library_outline for the available handles.",
              });
            }
            const maxChars = 60_000;
            const sectionTruncated = lookup.block.text.length > maxChars;
            return result(call, {
              ok: true,
              filename: document.filename,
              ...(document.cautions.length
                ? { notes_of_caution: document.cautions }
                : {}),
              section: lookup.block.label,
              parent: lookup.block.parentLabel,
              text: lookup.block.text.slice(0, maxChars),
              truncated: sectionTruncated,
              ...(sectionTruncated
                ? {
                    continuation: `Section continues; call library_read with offset=${lookup.block.start + maxChars} for the rest.`,
                  }
                : {}),
            });
          }
          // Windowed read: offset composes with library_find's `at` for
          // documents without numbered structure. Untargeted reads keep the
          // historical 300k head.
          const offset = clampInt(args.offset, 0, 100_000_000, 0);
          // An untargeted read defaults to a window, not the whole document:
          // the ceiling stays 300k for a caller that deliberately asks, but
          // the default no longer spends a document's worth of transcript on
          // a question a section read would answer.
          const maxChars = clampInt(
            args.max_chars,
            200,
            300_000,
            Number(process.env.MIKE_READ_DEFAULT_CHARS || 24_000),
          );
          const window = document.text.slice(offset, offset + maxChars);
          const windowCut = offset + window.length < document.text.length;
          return result(call, {
            ok: true,
            filename: document.filename,
            ...(document.cautions.length
              ? { notes_of_caution: document.cautions }
              : {}),
            ...(offset > 0 ? { offset } : {}),
            text: window,
            truncated: windowCut,
            ...(windowCut
              ? {
                  continuation: `Document continues (${document.text.length.toLocaleString("en-CA")} chars total); call library_read with offset=${offset + window.length} to keep reading, or library_outline / library_find to target a section.`,
                }
              : {}),
          });
        }
        const query = trimmed(args.query);
        const matches =
          args.regex === true
            ? findRegexMatches({
                text: document.text,
                pattern: query,
                maxResults: clampInt(args.max_results, 1, 50, 20),
                contextChars: clampInt(args.context_chars, 40, 2000, 500),
                caseInsensitive: args.case_insensitive === true,
              })
            : findTextMatches({
                text: document.text,
                query,
                maxResults: clampInt(args.max_results, 1, 50, 20),
                contextChars: clampInt(args.context_chars, 40, 2000, 500),
              });
        if ("error" in matches) return fail(call, matches.error);
        // The grep-analog composes like file:line does for code: each hit
        // carries its offset plus the deepest enclosing structural handle,
        // so the follow-up is a section read, not a whole-document read.
        const skeleton = compileAgreementSkeleton(document.text);
        const hits = matches.hits.map((hit) => {
          const owner = skeleton.nodes
            .filter((node) => node.start <= hit.at && hit.at < node.end)
            .sort((a, b) => b.depth - a.depth)[0];
          return { ...hit, section: owner?.label ?? null };
        });
        return result(call, {
          ok: true,
          filename: document.filename,
          ...(document.cautions.length
            ? { notes_of_caution: document.cautions }
            : {}),
          query,
          totalMatches: matches.totalMatches,
          hits,
        });
      }

      if (call.name === "library_outline") {
        if (!documentId) return fail(call, "document_id is required");
        const document = await extractLocalDocument(userId, documentId);
        if (!document) return fail(call, "Document not found");
        const skeleton = compileAgreementSkeleton(document.text);
        if (!skeleton.nodes.length) {
          return result(call, {
            ok: true,
            filename: document.filename,
            ...(document.cautions.length
              ? { notes_of_caution: document.cautions }
              : {}),
            nodes: 0,
            outline:
              "No numbered structure detected; use library_read or library_find.",
          });
        }
        return result(call, {
          ok: true,
          filename: document.filename,
          ...(document.cautions.length
            ? { notes_of_caution: document.cautions }
            : {}),
          nodes: skeleton.nodes.length,
          outline: renderAgreementOutline(skeleton, {
            maxChars: clampInt(args.max_chars, 1_000, 40_000, 8_000),
          }),
        });
      }

      if (call.name === "library_anchor_coverage") {
        const sourceIds = stringArray(args.source_document_ids);
        const draftIds = stringArray(args.draft_document_ids);
        if (!sourceIds.length) {
          return fail(call, "source_document_ids is required");
        }
        if (!draftIds.length) return fail(call, "draft_document_ids is required");
        const outside = [...sourceIds, ...draftIds].find(
          (id) => allowedDocumentIds && !allowedDocumentIds.has(id),
        );
        if (outside) {
          return fail(call, `Document ${outside} is not attached to this matter`);
        }
        try {
          const load = (ids: string[], side: "source" | "draft") =>
            Promise.all(
              ids.map(async (id) => {
                const document = await extractLocalDocument(userId, id);
                if (!document) {
                  throw new Error(`${side} document ${id} not found`);
                }
                return { name: document.filename, text: document.text };
              }),
            );
          const [sources, drafts] = await Promise.all([
            load(sourceIds, "source"),
            load(draftIds, "draft"),
          ]);
          return result(call, {
            ok: true,
            ...anchorCoverage(sources, drafts, {
              maxRowsPerClass: clampInt(args.max_rows_per_class, 1, 100, 40),
            }),
          });
        } catch (error) {
          return fail(call, errorText(error, "Anchor coverage failed"));
        }
      }

      if (call.name === "library_conflict_scan") {
        const ids = stringArray(args.document_ids);
        if (!ids.length) return fail(call, "document_ids is required");
        const outside = ids.find(
          (id) => allowedDocumentIds && !allowedDocumentIds.has(id),
        );
        if (outside) {
          return fail(call, `Document ${outside} is not attached to this matter`);
        }
        try {
          const loaded = await Promise.all(
            ids.map(async (id) => {
              const document = await extractLocalDocument(userId, id);
              if (!document) throw new Error(`document ${id} not found`);
              return { name: document.filename, text: document.text };
            }),
          );
          return result(call, { ok: true, ...conflictScan(loaded) });
        } catch (error) {
          return fail(call, errorText(error, "Conflict scan failed"));
        }
      }

      if (call.name === "library_apply_amendment") {
        const sourceId = trimmed(args.source_document_id);
        const amendmentId = trimmed(args.amendment_document_id);
        const amendmentText = trimmed(args.amendment_text);
        if (!sourceId) return fail(call, "source_document_id is required");
        if (!amendmentId && !amendmentText) {
          return fail(call, "Provide amendment_document_id or amendment_text");
        }
        const outsideAmend = [sourceId, amendmentId].find(
          (id) => id && allowedDocumentIds && !allowedDocumentIds.has(id),
        );
        if (outsideAmend) {
          return fail(call, `Document ${outsideAmend} is not attached to this matter`);
        }
        try {
          const source = await extractLocalDocument(userId, sourceId);
          if (!source) return fail(call, "Source document not found");
          let prose = amendmentText;
          if (amendmentId) {
            const amendment = await extractLocalDocument(userId, amendmentId);
            if (!amendment) return fail(call, "Amendment document not found");
            prose = amendment.text;
          }
          const outcome = consolidateAmendment(source.text, prose);
          const previewChars = clampInt(args.preview_chars, 0, 20_000, 0);
          return result(call, {
            ok: true,
            source: source.filename,
            ops_compiled: outcome.parse.ops.length,
            instructions_refused: outcome.parse.unparsed,
            applied: outcome.applied.map((receipt) => ({
              kind: receipt.op.kind,
              target: receipt.op.target,
              removed: receipt.removed.slice(0, 160),
              inserted: receipt.inserted.slice(0, 160),
            })),
            failures: outcome.failures.map((failure) => ({
              kind: failure.op.kind,
              target: failure.op.target,
              code: failure.code,
              detail: failure.detail,
            })),
            verification: outcome.verification,
            consolidated_preview: previewChars
              ? outcome.text.slice(0, previewChars)
              : undefined,
            note: "Dry-run report; no Library version was written.",
          });
        } catch (error) {
          return fail(call, errorText(error, "Amendment consolidation failed"));
        }
      }

      if (call.name === "library_deadline") {
        try {
          const deadline = computeDeadline({
            anchor: trimmed(args.anchor_date) ?? "",
            count: clampInt(args.count, 1, 10_000, NaN),
            unit: trimmed(args.unit) as DeadlineUnit,
            direction: trimmed(args.direction) === "before" ? "before" : "after",
            jurisdiction: (trimmed(args.jurisdiction) ||
              "CA") as DeadlineJurisdiction,
            weekend: trimmed(args.weekend) === "sun_only" ? "sun_only" : "sat_sun",
            extraHolidays: stringArray(args.extra_holidays),
          });
          return result(call, { ok: true, ...deadline });
        } catch (error) {
          return fail(call, errorText(error, "Deadline computation failed"));
        }
      }

      if (call.name === "library_term_drift") {
        const driftIds = stringArray(args.document_ids);
        if (driftIds.length < 2) {
          return fail(call, "document_ids requires at least two documents");
        }
        const outsideDrift = driftIds.find(
          (id) => allowedDocumentIds && !allowedDocumentIds.has(id),
        );
        if (outsideDrift) {
          return fail(call, `Document ${outsideDrift} is not attached to this matter`);
        }
        try {
          const loaded = await Promise.all(
            driftIds.map(async (id) => {
              const document = await extractLocalDocument(userId, id);
              if (!document) throw new Error(`document ${id} not found`);
              return { name: document.filename, text: document.text };
            }),
          );
          return result(call, {
            ok: true,
            ...termDriftReport(loaded, {
              maxRows: clampInt(args.max_rows, 1, 100, 40),
            }),
          });
        } catch (error) {
          return fail(call, errorText(error, "Term drift report failed"));
        }
      }

      if (call.name === "library_drafting_lint") {
        if (!documentId) return fail(call, "document_id is required");
        if (allowedDocumentIds && !allowedDocumentIds.has(documentId)) {
          return fail(call, "Document is not attached to this matter");
        }
        try {
          const document = await extractLocalDocument(userId, documentId);
          if (!document) return fail(call, "Document not found");
          const report = draftingLint(document.text);
          const cap = clampInt(args.max_findings, 1, 200, 50);
          return result(call, {
            ok: true,
            filename: document.filename,
            counts: report.counts,
            modal_profile: report.modalProfile,
            findings: report.findings.slice(0, cap),
            findings_truncated: report.findings.length > cap,
          });
        } catch (error) {
          return fail(call, errorText(error, "Drafting lint failed"));
        }
      }

      if (call.name === "library_bilingual_concordance") {
        const englishId = trimmed(args.english_document_id);
        const frenchId = trimmed(args.french_document_id);
        if (!englishId || !frenchId) {
          return fail(call, "english_document_id and french_document_id are required");
        }
        const outsidePair = [englishId, frenchId].find(
          (id) => allowedDocumentIds && !allowedDocumentIds.has(id),
        );
        if (outsidePair) {
          return fail(call, `Document ${outsidePair} is not attached to this matter`);
        }
        try {
          const [english, french] = await Promise.all([
            extractLocalDocument(userId, englishId),
            extractLocalDocument(userId, frenchId),
          ]);
          if (!english) return fail(call, "English document not found");
          if (!french) return fail(call, "French document not found");
          return result(call, {
            ok: true,
            ...bilingualConcordance(
              { name: english.filename, text: english.text },
              { name: french.filename, text: french.text },
              { maxRowsPerClass: clampInt(args.max_rows_per_class, 1, 100, 40) },
            ),
          });
        } catch (error) {
          return fail(call, errorText(error, "Bilingual concordance failed"));
        }
      }

      if (call.name === "library_lookup") {
        const versionId = trimmed(args.version_id);
        if (!documentId) return fail(call, "document_id is required");
        const file = await getLocalVersionFile(
          userId,
          documentId,
          versionId || undefined,
        );
        if (!file) return fail(call, "PDF Library version not found");
        if (file.fileType.toLowerCase() !== "pdf") {
          return fail(
            call,
            "Exact structural lookup requires a parsed PDF version",
          );
        }
        const artifactSession = localPdfEvidenceHandles
          ? localPdfArtifactSessionForTurn(localPdfEvidenceHandles, file.path)
          : undefined;
        const lookup = await lookupLocalPdfStructure(
          file.path,
          pdfLocatorParams(args),
          { artifactSession },
        );
        if (lookup.status === "found") {
          localPdfEvidenceHandles?.add(lookup.evidence.handle);
        }
        return result(call, compactPdfLookup(file.version.filename, lookup));
      }

      if (call.name === "library_evidence") {
        const handle = trimmed(args.handle);
        if (!handle) return fail(call, "handle is required");
        try {
          const receipt = await readLocalPdfEvidenceReceipt(handle);
          if (
            allowedDocumentIds &&
            !allowedDocumentIds.has(receipt.source.document_id)
          ) {
            return fail(call, "Document is not attached to this matter");
          }
          const file = await getLocalVersionFile(
            userId,
            receipt.source.document_id,
            receipt.source.version_id,
          );
          if (!file || file.fileType.toLowerCase() !== "pdf") {
            return fail(call, "PDF Library version not found");
          }
          const artifactSession = localPdfEvidenceHandles
            ? localPdfArtifactSessionForTurn(localPdfEvidenceHandles, file.path)
            : undefined;
          const lookup = await rehydrateLocalPdfEvidence(
            file.path,
            handle,
            artifactSession,
          );
          localPdfEvidenceHandles?.add(handle);
          return result(call, compactPdfLookup(file.version.filename, lookup));
        } catch (error) {
          return fail(call, pdfEvidenceError(error));
        }
      }

      const docxWorkflow = DOCX_WORKFLOWS[call.name];
      if (docxWorkflow) {
        if (!documentId) return fail(call, "document_id is required");
        try {
          return result(
            call,
            await docxWorkflow.run(
              userId,
              documentId,
              trimmed(args.version_id) || undefined,
            ),
          );
        } catch (error) {
          return fail(call, errorText(error, docxWorkflow.fallback));
        }
      }

      if (call.name === "toa_submit_library_document") {
        const versionId = trimmed(args.version_id);
        if (!documentId) return fail(call, "document_id is required");
        try {
          const file = await getLocalVersionFile(
            userId,
            documentId,
            versionId || undefined,
          );
          if (!file) return fail(call, "DOCX Library version not found");
          if (file.fileType.toLowerCase() !== "docx") {
            return fail(
              call,
              "Table of Authorities requires a DOCX Library version",
            );
          }
          const job = await submitTableOfAuthoritiesDocument({
            bytes: await readFile(file.path),
            filename: file.version.filename,
            splitFallback: args.split_fallback === "off" ? "off" : "auto",
            projectId: matterId,
          });
          return result(call, {
            ok: true,
            document_id: documentId,
            version_id: file.version.id,
            filename: file.version.filename,
            job,
            next_required_action:
              "Poll toa_job_status with this job id until detection is complete.",
          });
        } catch (error) {
          return fail(
            call,
            errorText(error, "Table of Authorities submission failed"),
          );
        }
      }

      if (call.name === "toa_job_status") {
        try {
          return result(call, {
            ok: true,
            job: await getTableOfAuthoritiesJob(trimmed(args.job_id)),
          });
        } catch (error) {
          return fail(
            call,
            errorText(error, "Table of Authorities status lookup failed"),
          );
        }
      }

      const hansard = executeHansardTool(call.name, args);
      if (hansard) return result(call, hansard);

      const citator = executeCitatorTool(call.name, args);
      if (citator) return result(call, citator);

      const compared = await executeCompareVersionsTool(userId, call.name, args);
      if (compared) return result(call, compared);

      const a2aj = await executeA2AJTool(call.name, args);
      if (a2aj) {
        if (a2aj.document?.url) a2ajDocuments?.push(a2aj.document);
        if (a2aj.lookup?.status === "found" && a2aj.lookup.block) {
          a2ajLookups?.push(a2aj.lookup);
        }
        const pdfFallback = a2aj.document
          ? await queueA2ajPdfFallback(a2aj.document)
          : a2aj.lookup
            ? await queueA2ajPdfFallback(a2aj.lookup)
            : null;
        return result(call, {
          ...a2aj.payload,
          ...(pdfFallback ? { pdf_fallback: pdfFallback } : {}),
        });
      }

      return result(call, { ok: false, error: `Unknown tool: ${call.name}` });
    }),
  );
}
