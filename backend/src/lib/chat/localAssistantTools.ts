import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { appUrl } from "../appRoutes";
import { sha256 } from "../hash";
import { SYSTEM_ASSISTANT_WORKFLOWS } from "../systemWorkflows";
import type { A2AJDocument, A2AJLocatorLookup } from "../a2aj";
import { linkLocalDocxCitations } from "../docxCitationLinking";
import { fixLocalDocxSupraCrossReferences } from "../docxDeterministicCleanup";
import { lintLocalDocxStructure } from "../docxStructuralLint";
import { draftingLint } from "../legalDraftingLint";
import {
  consolidateAmendment,
  deleteProvisionAndRenumberSiblings,
  type DeleteAndRenumberReceipt,
} from "../legalAmendOps";
import { computeDeadline } from "../legalDeadlines";
import type { DeadlineJurisdiction, DeadlineUnit } from "../legalDeadlines";
import { conflictScan } from "../legalConflictScan";
import { anchorCoverage, bilingualConcordance } from "../legalTextAnchors";
import {
  compileAgreementSkeleton,
  readSection,
  skeletonSubtreeLabels,
  renderAgreementOutline,
  type AgreementSkeleton,
  type CompileSkeletonOptions,
  type TableCellSpan,
} from "../legalTextSkeleton";
import {
  crossReferenceGraph,
  type CrossReferenceGraph,
} from "../legalCrossReference";
import {
  documentMap,
  referenceImpact,
  type DocumentMapFocus,
  type ReferenceImpactOperation,
} from "../legalRetrievalHybrid";
import {
  bakedCrossReferenceGraph,
  bakedSkeleton,
} from "../legalStructureSidecar";
import {
  nodeLinks,
  nodeNeighbourhood,
  pageAt,
  pageLabel,
  pageMapFromMarkers,
  pageMapFromSourceDoc,
  graphScope,
  pageSchemes,
  pageSections,
  parseAddress,
  referenceHubs,
  resolvePage,
  selectPages,
  type FollowDirection,
  type PageMap,
  type PageSpan,
} from "../legalDocumentNavigator";
import { termDriftReport } from "../legalTermDrift";
import { extractDocxDraftingSource } from "../docxDraftingSource";
import {
  STRUCTURE_INDEX_ENABLED,
  attachStructureIndex,
  deriveSectionNodes,
  renderStructureIndex,
} from "./structureIndexExperiment";
import { resolveDocxEvidenceCitations } from "../docxEvidenceCitations";
import {
  applyTrackedEdits,
  extractDocxBodyStructure,
  extractDocxBodyText,
  insertTrackedBlocks,
  type EditInput,
} from "../docxTrackedChanges";
import { isSpreadsheetDocumentType } from "../documentTypes";
import { spreadsheetToLLMStructure } from "../spreadsheet";
import {
  addLocalVersion,
  createLocalDocument,
  deleteLocalDocument,
  getLocalVersionFile,
  listLocalLibrary,
  updateLocalAssistantTurnVersion,
  updateLocalDocument,
  type LocalTrackedEdit,
} from "../localDocumentStore";
import { DOMAIN_PROMPTS } from "./prompts";
import { legalKnowledgeGraphStore } from "../legalKnowledgeGraphStore";
import {
  LOCAL_PDF_LOCATOR_KINDS,
  lookupLocalPdfStructure,
  readLocalPdfEvidenceReceipt,
  readLocalPdfSourceDoc,
  rehydrateLocalPdfEvidence,
  type LocalPdfLinkEvidence,
  type LocalPdfLocatorKind,
} from "../localPdfLookup";
import { parseLocalPdfOnDemand } from "../localPdfIngestion";
import {
  lookupProviderPdfReference,
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
  ADAPTIVE_MIKE_LAB_TOOLS,
  COMPACT_AUTHOR_MIKE_LAB_TOOLS,
  LEAN_BATCH_LAB_TOOLS,
  MIKE_GREP_LAB_TOOLS,
  MIKE_LEGAL_LAB_TOOLS,
  MIKE_STRUCTURE_PATHS_LAB_TOOLS,
  UPSTREAM_MIKE_LAB_TOOLS,
  UPSTREAM_MIKE_MARKDOWN_SWAP_LAB_TOOLS,
} from "./upstreamMikeBenchmarkSurface";
import {
  getTableOfAuthoritiesJob,
  submitTableOfAuthoritiesDocument,
} from "../tableOfAuthorities";
import {
  A2AJ_TOOLS,
  executeA2AJTool,
} from "./tools/a2ajTools";
import {
  LEGAL_EVIDENCE_PLAN_TOOL_NAME,
  LEGAL_EVIDENCE_TOOL_NAME,
  planLegalEvidence,
  registerLegalEvidence,
  submitLegalEvidenceAnswer,
  type LegalEvidenceReceipt,
  type LegalEvidenceTurnState,
} from "./legalEvidenceExperiment";
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
  REDLINE_VIEW_LEGEND,
} from "./tools/docxPathologyNotes";
import { projectDocxRedline } from "../docx/redline";
import { TEXT_OPS_TOOLS, TOOLS, WORKFLOW_TOOLS } from "./tools/toolSchemas";
import {
  runLocalCourtlistenerTool,
  type CourtlistenerToolState,
} from "./courtlistenerToolRunner";

/**
 * Navigation surface arm, for the A/B.
 *
 * "legacy" is the shape that shipped before 2026-07-31: read by section or
 * offset, unscoped find, no page addressing, no graph. "address" is the one
 * grammar shape: `at` everywhere, head/tail, page schemes, library_links,
 * and edit scopes that name a provision instead of retyping its text.
 *
 * The model sees exactly one of them, and only one is callable. Shims that
 * accept both would let an arm answer with the other arm's affordance and
 * make the comparison meaningless.
 */
export const NAV_TOOL_SHAPE: "legacy" | "address" =
  process.env.MIKE_NAV_SHAPE === "address" ? "address" : "legacy";

/**
 * Benchmark opt-in: a successful final create receipt is the end of the
 * provider loop. The document card is rendered from the durable receipt, so
 * another model round would only restate completion with the full context.
 */
export const TERMINAL_AUTHORING_ENABLED =
  process.env.MIKE_TERMINAL_AUTHORING === "1";

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
    "Read the active version of a local Beaver Library document. Text mode supports bounded structural, page, offset, tail, and cross-reference reads. mode=drafting returns a whole-DOCX precedent view that preserves headings, lists, tables, emphasis, and note pairing for translation into semantic Markdown. mode=redline returns the whole DOCX with tracked changes, comments, and strike/colour redlines inline as markers.",
    {
      type: "object",
      properties: {
        document_id: { type: "string" },
        mode: {
          type: "string",
          enum: ["text", "drafting", "redline"],
          description:
            "Defaults to text. drafting and redline are DOCX-only whole-document views and do not combine with at/from/follow. drafting returns bounded semantic HTML as document data. redline returns body text with editorial content visible: {++inserted++}, {--deleted--}, {>>author: comment<<}, [ink] for strike/colour formatting standing in for tracked changes.",
        },
        at: {
          type: "string",
          description:
            "Text mode only. Where to read: '8.01' or 'Article VIII' for a provision and everything under it, 'table:1/row:2/col:3' for an exact DOCX cell, 'pdf:52' or 'printed:47' for a page, 'off:12000' for a raw window. Omit to read from the start. library_outline explains the addresses this document has.",
        },
        from: {
          type: "string",
          enum: ["start", "end"],
          description:
            "Which end of the addressed span to read when it is longer than max_chars. Defaults to start; 'end' gives the tail — signature blocks, execution pages, the close of a clause.",
        },
        follow: {
          type: "string",
          enum: ["none", "out", "in", "both"],
          description:
            "Widen `at` along the document's cross-references (see library_outline). Defaults to none.",
        },
        depth: {
          type: "integer",
          minimum: 1,
          maximum: 3,
          description: "Hops. Defaults to 1.",
        },
        // Legacy-arm parameters. They carry their OWN descriptions, not a
        // pointer at the other arm's vocabulary: each arm strips the other's
        // parameters, so a deprecation note here is both pointless and a
        // leak — it teaches arm A about a parameter arm A does not have.
        section: {
          type: "string",
          description:
            "Structural locator from the document's own numbering ('8.01', 'Article VIII', 'Schedule 7.01', 's. 8(2)') or an exact DOCX cell ('table:1/row:2/col:3'). Returns only that span, children included. library_outline lists the exact handles.",
        },
        page: {
          type: "string",
          description:
            "Printed page label, for paged documents. library_outline reports which pages exist.",
        },
        offset: {
          type: "integer",
          minimum: 0,
          description:
            "Character offset to start from (text mode, no section). Pairs with library_find hits' offsets.",
        },
        max_chars: {
          type: "integer",
          minimum: 200,
          maximum: 300000,
          description:
            "Text mode only. Characters to return. Defaults to 24000 — a portion, not the whole document; the reply sets `truncated` when there is more.",
        },
      },
      required: ["document_id"],
    },
  ),
  tool(
    "library_outline",
    "Orientation call, and where the address grammar is defined. Returns the ARTICLE/PART tree with every Section and (a)/(i) subsection, exact handles for unambiguous provisions and DOCX table cells, defined terms with their defining section, schedules, cross-reference counts, and the page map. Repeated TOC/body labels are marked for library_find instead of advertised as handles. Addresses: a node handle ('8.01', 'Article VIII') names a provision and everything under it; 'table:1/row:2/col:3' names one native DOCX cell; 'pdf:52' names the sheet's position in the file; 'printed:47' names the number printed ON the sheet, which is what a pinpoint citation, index or exhibit stamp refers to and need not equal the PDF page. The page map says which of those this document has and where they diverge. `follow` on read and find widens an address along the document's own cross-references: out = what it points at, in = what points at it. A ~100-page agreement maps to 1-3k tokens.",
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
    "library_links",
    "Follow a document's own cross-references. With an address, returns that provision's parent/siblings/children plus the references it makes and the references made to it, each as a handle library_read accepts. Without one, returns the reference census and the most-referenced provisions. Deterministic — the document's literal pointers, not a similarity guess.",
    {
      type: "object",
      properties: {
        document_id: { type: "string" },
        at: {
          type: "string",
          description:
            "Structural locator to stand at ('8.01', 'Article VIII', 'table:1/row:2/col:3'). Omit for the document-level census and hubs.",
        },
        section: {
          type: "string",
          description:
            "Structural locator to stand at ('8.01', 'Article VIII'). Omit for the document-level census and hubs.",
        },
        max_results: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Cap on edges reported in each direction. Defaults to 40.",
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
        at: {
          type: "string",
          description:
            "Restrict the search to one address: '8.01' for a provision and everything under it, 'table:1/row:2/col:3' for an exact DOCX cell, or 'pdf:12-18'/'printed:47' for pages. Hit offsets stay document-wide.",
        },
        pages: {
          type: "string",
          description: "Restrict the search to pages, for paged documents.",
        },
        section: {
          type: "string",
          description:
            "Restrict the search to one provision and everything under it ('8.01', 'Article VIII').",
        },
        follow: {
          type: "string",
          enum: ["none", "out", "in", "both"],
          description:
            "Widen `at` along the document's cross-references (see library_outline). Defaults to none.",
        },
        depth: {
          type: "integer",
          minimum: 1,
          maximum: 3,
          description: "Hops. Defaults to 1.",
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
    "legal_pdf_lookup",
    "Resolve a PDF reference returned by a legal-source tool into one exact parsed structural unit; reports a queued state rather than reading the whole PDF. To rehydrate prior evidence, pass its handle with the same reference_id instead of a locator.",
    {
      type: "object",
      properties: {
        reference_id: {
          type: "string",
          description: "Opaque PDF reference returned by a legal-source tool.",
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
    "library_delete_and_renumber_docx",
    "Delete one numbered provision from a local Library DOCX and close that exact sibling gap as tracked changes. The server renumbers following sibling headings and every resolved internal pointer in one atomic operation. It refuses the whole mutation if the target, sequence, or any affected reference is missing, ambiguous, external, or otherwise unsafe. This is deliberately delete-and-close-gap only; it does not insert provisions or open a numbering gap.",
    {
      type: "object",
      properties: {
        document_id: DOCUMENT_ID_PROPERTY,
        version_id: OPTIONAL_VERSION_ID_PROPERTY,
        target: {
          type: "string",
          description:
            "Exact provision handle from library_outline, such as '8.02' or '8.02(a)'.",
        },
      },
      required: ["document_id", "target"],
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
    "Submit one owned Word or PDF Library version to the local authorities workflow. A PDF can create a Book of Authorities; inserting a table requires Word. Detection is deterministic first, with a bounded cached Codex splitter only for unresolved citation units. Never pass or invent filesystem paths.",
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
    const parameters = schema.function.parameters as {
      type: string;
      properties: Record<string, unknown>;
      required?: string[];
    };
    const title = parameters.properties.title as Record<string, unknown>;
    return [
      {
        ...schema,
        function: {
          ...schema.function,
          name: "library_create_docx",
          description: `${schema.function.description} Stored as a durable new item in the local Library; matter chats attach it automatically.${
            TERMINAL_AUTHORING_ENABLED
              ? " Call only when every requested deliverable is final; after a successful receipt, the turn ends without another model round."
              : ""
          }`,
          parameters: {
            ...parameters,
            properties: {
              ...parameters.properties,
              title: {
                ...title,
                description:
                  "Document title rendered once in the file. Do not repeat it in markdown.",
              },
              filename: {
                type: "string",
                description:
                  "Optional exact output filename ending in .docx; omit to derive it from title.",
              },
            },
          },
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
            edits:
              NAV_TOOL_SHAPE === "address"
                ? addressedEditsSchema(sharedProperties.edits)
                : sharedProperties.edits,
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
 * model-facing schema changes. Glob discloses document IDs only when two
 * files share a filename, so the ordinary path stays filename-native.
 */
export const MIKE_GREP_TOOL_SHAPE =
  process.env.MIKE_TOOL_SHAPE === "mike-grep-v1";
export const MIKE_LEGAL_TOOL_SHAPE =
  process.env.MIKE_TOOL_SHAPE === "mike-legal-v1";
export const MIKE_LEGAL_GUIDED_TOOL_SHAPE =
  process.env.MIKE_TOOL_SHAPE === "mike-legal-guided-v1";
export const MIKE_STRUCTURE_PATHS_TOOL_SHAPE =
  process.env.MIKE_TOOL_SHAPE === "mike-structure-paths-v1";
export const COMPACT_AUTHOR_MIKE_TOOL_SHAPE =
  process.env.MIKE_TOOL_SHAPE === "mike-compact-author-v1";
export const MARKDOWN_SWAP_MIKE_TOOL_SHAPE =
  process.env.MIKE_TOOL_SHAPE === "mike-markdown-swap-v1";
export const MARKDOWN_E2E_MIKE_TOOL_SHAPE =
  process.env.MIKE_TOOL_SHAPE === "mike-markdown-e2e-v1";
/** LAB read-format axis: serve Beaver's Pandoc drafting-source markdown on
 * docx reads instead of upstream plain body text (end-to-end arm). */
export const MARKDOWN_READ_DOCX = process.env.MIKE_READ_DOCX_MARKDOWN === "1";
export const LEAN_BATCH_TOOL_SHAPE =
  process.env.MIKE_TOOL_SHAPE === "lean-batch-v1";
export const LEAN_BATCH_HARDREFS_TOOL_SHAPE =
  process.env.MIKE_TOOL_SHAPE === "lean-batch-hardrefs-v1";
export const LEAN_BATCH_FAMILY_TOOL_SHAPE =
  LEAN_BATCH_TOOL_SHAPE || LEAN_BATCH_HARDREFS_TOOL_SHAPE;
export const GROUNDING_FIRST_ENABLED =
  process.env.MIKE_GROUNDING_FIRST === "1";
export const MIKE_GREP_FAMILY_TOOL_SHAPE =
  MIKE_GREP_TOOL_SHAPE ||
  MIKE_LEGAL_TOOL_SHAPE ||
  MIKE_LEGAL_GUIDED_TOOL_SHAPE ||
  MIKE_STRUCTURE_PATHS_TOOL_SHAPE;

export const CODING_TOOL_SHAPE =
  process.env.MIKE_TOOL_SHAPE === "coding" ||
  MIKE_GREP_FAMILY_TOOL_SHAPE ||
  LEAN_BATCH_FAMILY_TOOL_SHAPE;

/**
 * LAB arm: let the model choose complete, targeted, or mixed source coverage
 * after Glob reports the actual inventory. The host does not classify task
 * wording or legal domain.
 */
export const MODEL_COVERAGE_ROUTING =
  process.env.MIKE_MODEL_COVERAGE_ROUTING === "1";

const configuredWholeReadMaxChars = Number(
  process.env.MIKE_WHOLE_READ_MAX_CHARS || 0,
);

/**
 * Optional cumulative context budget for complete-document reads in one turn.
 * This is a source-size guard, not a task router: every request sees the same
 * limit and may still combine whole files with targeted Grep/Read evidence.
 */
export const WHOLE_READ_MAX_CHARS =
  MODEL_COVERAGE_ROUTING &&
  Number.isFinite(configuredWholeReadMaxChars) &&
  configuredWholeReadMaxChars > 0
    ? Math.trunc(configuredWholeReadMaxChars)
    : 0;

/**
 * Legacy token optimization. It is safe only while the original bytes remain
 * in active model context; a host-side turn map cannot know what compaction
 * removed. Conventional continuous-agent arms disable it so a repeat read
 * returns the requested bytes.
 */
export const SUPPRESS_DUPLICATE_WHOLE_READS =
  process.env.MIKE_SUPPRESS_DUPLICATE_WHOLE_READS !== "0";

/** Explicit LAB-only comparator; never selected by a product setting. */
export const UPSTREAM_MIKE_TOOL_SHAPE =
  process.env.MIKE_TOOL_SHAPE === "upstream-mike";

/** Clean-fork LAB candidate; starts from the comparator's frozen surface. */
export const ADAPTIVE_MIKE_TOOL_SHAPE =
  process.env.MIKE_TOOL_SHAPE === "adaptive-mike-v1";

export const ORIGIN_MIKE_TOOL_SHAPE =
  UPSTREAM_MIKE_TOOL_SHAPE ||
  ADAPTIVE_MIKE_TOOL_SHAPE ||
  MARKDOWN_SWAP_MIKE_TOOL_SHAPE ||
  MARKDOWN_E2E_MIKE_TOOL_SHAPE ||
  COMPACT_AUTHOR_MIKE_TOOL_SHAPE ||
  LEAN_BATCH_FAMILY_TOOL_SHAPE ||
  MIKE_GREP_FAMILY_TOOL_SHAPE;

const MIKE_FILE_TOOL_SHAPE =
  MIKE_GREP_FAMILY_TOOL_SHAPE || LEAN_BATCH_FAMILY_TOOL_SHAPE;

/** Keep tool disclosure independent from navigation vocabulary in A/B runs. */
export const PROGRESSIVE_DISCLOSURE_ENABLED =
  NAV_TOOL_SHAPE === "address" ||
  process.env.MIKE_PROGRESSIVE_DISCLOSURE === "1";

export const DEMAND_PAGED_EVIDENCE_ENABLED =
  process.env.MIKE_CONTINUOUS_EVIDENCE === "1" ||
  (process.env.MIKE_CONTEXT_HANDOFF === "1" &&
    process.env.MIKE_DRAFT_HANDOFF_MODE === "paged");

export const WORKING_SET_PATH = ".mike/working-sets/evidence.txt";

const configuredWorkingSetPageMaxChars = Number(
  process.env.MIKE_EVIDENCE_PAGE_MAX_CHARS ||
    process.env.MIKE_DRAFT_HOT_EVIDENCE_MAX_CHARS ||
    24_000,
);

/** One demand-page packet is no larger than the configured hot packet. */
export const WORKING_SET_PAGE_MAX_CHARS = DEMAND_PAGED_EVIDENCE_ENABLED
  ? Number.isFinite(configuredWorkingSetPageMaxChars)
    ? Math.max(
        1_000,
        Math.min(64_000, Math.trunc(configuredWorkingSetPageMaxChars)),
      )
    : 24_000
  : 0;

// Demand-paged Grep is an index into exact evidence, not another bulk read.
// A compact centred hit is enough to answer directly or choose the attached
// exact Read recipe; callers can request more hits, but one search stays small.
export const WORKING_SET_GREP_DEFAULT_HEAD_LIMIT = 8;
export const WORKING_SET_GREP_MAX_HEAD_LIMIT = 24;
export const WORKING_SET_GREP_LINE_MAX_CHARS = 800;

export type RetrievalExperimentShape =
  | ""
  | "p0-pure-coding"
  | "c0-routed-coding"
  | "h1-contact"
  | "h2-document-map"
  | "h3-reference-impact"
  | "h4-legal-grep"
  | "h5-working-set"
  | "h9-accretive-union"
  | "s1-structure-paths"
  | "d0-generic"
  | "d1-routed"
  | "d2-concrete";

const requestedRetrievalExperiment =
  process.env.MIKE_RETRIEVAL_EXPERIMENT?.trim() ?? "";
const RETRIEVAL_EXPERIMENT_SHAPES = new Set<RetrievalExperimentShape>([
  "",
  "p0-pure-coding",
  "c0-routed-coding",
  "h1-contact",
  "h2-document-map",
  "h3-reference-impact",
  "h4-legal-grep",
  "h5-working-set",
  "h9-accretive-union",
  "s1-structure-paths",
  "d0-generic",
  "d1-routed",
  "d2-concrete",
]);
if (
  !RETRIEVAL_EXPERIMENT_SHAPES.has(
    requestedRetrievalExperiment as RetrievalExperimentShape,
  )
) {
  throw new Error(
    `Unknown MIKE_RETRIEVAL_EXPERIMENT=${requestedRetrievalExperiment}`,
  );
}
export const RETRIEVAL_EXPERIMENT_SHAPE =
  requestedRetrievalExperiment as RetrievalExperimentShape;
const PURE_CODING_EXPERIMENT =
  RETRIEVAL_EXPERIMENT_SHAPE === "p0-pure-coding";
export const STRUCTURE_PATH_EXPERIMENT =
  RETRIEVAL_EXPERIMENT_SHAPE === "s1-structure-paths";
const LEGAL_GREP_EXPERIMENT =
  RETRIEVAL_EXPERIMENT_SHAPE === "h4-legal-grep" ||
  RETRIEVAL_EXPERIMENT_SHAPE === "h5-working-set" ||
  RETRIEVAL_EXPERIMENT_SHAPE === "h9-accretive-union";
const WORKING_SET_EXPERIMENT =
  RETRIEVAL_EXPERIMENT_SHAPE === "h5-working-set" ||
  RETRIEVAL_EXPERIMENT_SHAPE === "h9-accretive-union";
const ACCRETIVE_WORKING_SET_EXPERIMENT =
  RETRIEVAL_EXPERIMENT_SHAPE === "h9-accretive-union";
const TOOL_DESCRIPTION_VARIANT =
  process.env.MIKE_TOOL_DESCRIPTION_VARIANT?.trim() || "operational";
if (!["operational", "terse"].includes(TOOL_DESCRIPTION_VARIANT)) {
  throw new Error(
    `Unknown MIKE_TOOL_DESCRIPTION_VARIANT=${TOOL_DESCRIPTION_VARIANT}`,
  );
}


/** Shown only in the address arm; stripped from legacy. */
const ADDRESS_ONLY_PARAMS: Record<string, string[]> = {
  library_read: ["at", "from", "follow", "depth", "page"],
  library_find: ["at", "pages", "section", "follow", "depth"],
  library_links: ["at", "section"],
};

/**
 * Shown only in the legacy arm. The address arm drops these outright rather
 * than carrying them as deprecated aliases: an arm that still accepts the
 * other arm's vocabulary is not a separate condition, and a model that finds
 * `section=` working has not been asked the question.
 */
const LEGACY_ONLY_PARAMS: Record<string, string[]> = {
  library_read: ["section", "offset", "page"],
  library_find: ["pages", "section"],
  library_links: ["section"],
};

/**
 * Descriptions the legacy arm needs because the shared text advertises
 * affordances it does not have. An arm that tells the model to call `at=`
 * when `at` is not in its schema measures the harness, not the surface.
 */
const LEGACY_DESCRIPTIONS: Record<string, string> = {
  library_outline:
    "Structural map of a Library document parsed from its own numbering and native DOCX tables: the ARTICLE/PART tree, every Section and (a)/(i) subsection, exact table/cell handles library_read accepts, defined terms with their defining section, schedules/exhibits, and cross-reference counts. A ~100-page agreement maps to 1-3k tokens.",
};

/**
 * Structure for a Library document, served from a pre-baked sidecar in the
 * address arm.
 *
 * The sidecars exist because the in-memory memo only helps within a process:
 * the Income Tax Act costs ~13.4s to compile cold and ~658ms to read baked,
 * and those landmark statutes are exactly the documents a model must navigate
 * rather than read. A miss falls through to a real compile, so correctness
 * never depends on a bake — only speed does.
 *
 * Legacy stays on the synchronous path: arm B is the whole product bet, and
 * this is part of it.
 */
async function documentStructure(
  text: string,
  id = "",
  options: CompileSkeletonOptions = {},
) {
  return NAV_TOOL_SHAPE === "address"
    ? bakedSkeleton(text, id, options)
    : compileAgreementSkeleton(text, id, options);
}

async function documentGraph(
  text: string,
  id: string,
  skeleton: AgreementSkeleton,
  options: CompileSkeletonOptions = {},
) {
  return NAV_TOOL_SHAPE === "address"
    ? bakedCrossReferenceGraph(text, id, options)
    : crossReferenceGraph(text, id, { skeleton });
}

function oneHopLegalScope(
  skeleton: AgreementSkeleton,
  graph: CrossReferenceGraph,
  seedLabel: string,
  direction: "inbound" | "outbound" | "both",
) {
  const lookup = readSection(skeleton, seedLabel);
  if (lookup.status !== "found" || !lookup.block) return null;
  const seed = skeleton.nodes.find(
    (node) =>
      node.label === lookup.block!.label &&
      node.start === lookup.block!.start &&
      node.end === lookup.block!.end,
  );
  if (!seed) return null;
  const subtree = skeletonSubtreeLabels(skeleton, seed.label);
  const byLabel = new Map(skeleton.nodes.map((node) => [node.label, node]));
  const reached = new Map<string, (typeof skeleton.nodes)[number]>();
  for (const edge of graph.edges) {
    if (edge.status !== "resolved" || edge.selfLoop) continue;
    if (
      (direction === "outbound" || direction === "both") &&
      edge.sourceLabel &&
      subtree.has(edge.sourceLabel) &&
      edge.targetLabel &&
      !subtree.has(edge.targetLabel)
    ) {
      const node = byLabel.get(edge.targetLabel);
      if (node) reached.set(node.label, node);
    }
    if (
      (direction === "inbound" || direction === "both") &&
      edge.targetLabel &&
      subtree.has(edge.targetLabel) &&
      edge.sourceLabel &&
      !subtree.has(edge.sourceLabel)
    ) {
      const node = byLabel.get(edge.sourceLabel);
      if (node) reached.set(node.label, node);
    }
  }
  return {
    seed,
    nodes: [
      seed,
      ...[...reached.values()].sort((left, right) => left.start - right.start),
    ],
  };
}

/**
 * PROGRESSIVE DISCLOSURE, address arm only.
 *
 * Tool-selection accuracy is measured to degrade past roughly 20-25 tools,
 * and this surface carries 44. That is very likely a larger effect than any
 * wording in the schemas, so the address arm keeps only the verbs a task
 * starts with and defers the rest behind one discovery call.
 *
 * Resident = what you need before you know what the task is: find the
 * document, orient, read, search, follow, ask. Everything else is a
 * domain the model can open when the task turns out to need it.
 */
const RESIDENT_TOOLS = new Set([
  "ask_inputs",
  "Glob",
  "Grep",
  "Read",
  "fetch_documents",
  "library_list",
  "library_outline",
  "library_read",
  "library_find",
  "describe_tools",
]);

/**
 * Keep the core request shape stable for continuous-agent runs. Creating the
 * requested artifact is the ordinary end of the same trajectory, not a
 * specialist phase; benchmark arms opt in until the simpler surface wins its
 * release gate.
 */
export const RESIDENT_AUTHORING_ENABLED =
  process.env.MIKE_RESIDENT_AUTHORING === "1";

/**
 * Deferred tools, grouped the way a task arrives rather than the way the code
 * is organised — a model asks "what cites this case", never "I need the
 * courtlistener module".
 *
 * Keep this one hop while the catalogue is small. A second discovery turn is
 * real latency; add hierarchy only when a measured routing failure justifies
 * it.
 */
type Domain = { blurb: string };

const TOOL_DOMAINS: Record<string, Domain> = {
  document_map: {
    blurb:
      "map provisions, native table rows, or PDF-versus-printed pages when wording search cannot orient the task; not ordinary passage search",
  },
  cross_reference_impact: {
    blurb:
      "list literal inbound/outbound pointers or the exact impact set for deleting and closing one numbering gap; not similarity search",
  },
  source_evidence: {
    blurb:
      "resolve or rehydrate an exact PDF evidence handle after a targeted source lookup; not ordinary document reading",
  },
  document_links: {
    blurb:
      "inspect already resolved links attached to a Library document; not text search or inferred similarity",
  },
  cases: {
    blurb:
      "find and read decisions, retrieve exact paragraphs, and see which later decisions cite a case; not citation-format checking",
  },
  legislation: {
    blurb:
      "find and read statutes, regulations, exact provisions, and related legislative debate",
  },
  commentary: {
    blurb: "find and read journals and other public secondary sources",
  },
  citations: {
    blurb:
      "verify citation strings, link or repair citations in Word, and build a table or book of authorities; not case-law research",
  },
  output_document: {
    blurb:
      "create a new Word deliverable from completed content",
  },
  drafting: {
    blurb:
      "revise an existing Word document, delete and safely renumber a provision, or update Library metadata",
  },
  document_quality: {
    blurb:
      "audit an existing DOCX for structure, source anchors, conflicts, term drift, drafting, or bilingual concordance; not source-document analysis, and not a newly created file whose receipt already reports compiler checks",
  },
  amendment: {
    blurb:
      "apply a formal amending instrument or compare saved versions; not ordinary clause editing or renumbering",
  },
  deadlines: { blurb: "compute a legal deadline with a derivation trace" },
  workflow: { blurb: "list or open saved workflows" },
};

const DOMAIN_OF: Record<string, string> = {
  DocumentMap: "document_map",
  ReferenceImpact: "cross_reference_impact",
  library_links: "document_links",
  library_lookup: "source_evidence",
  library_evidence: "source_evidence",
  library_apply_text_ops: "drafting",
  plan_grounded_evidence: "cases",
  submit_grounded_answer: "cases",
  courtlistener_search_case_law: "cases",
  courtlistener_get_cases: "cases",
  courtlistener_find_in_case: "cases",
  courtlistener_lookup_case_locator: "cases",
  courtlistener_read_case: "cases",
  caselaw_note_up: "cases",
  a2aj_search: "cases",
  a2aj_fetch: "cases",
  a2aj_lookup: "cases",
  legal_pdf_lookup: "cases",
  hansard_search: "legislation",
  hansard_fetch: "legislation",
  public_legal_source_search: "commentary",
  public_legal_source_fetch: "commentary",
  public_legal_source_lookup: "commentary",
  courtlistener_verify_citations: "citations",
  library_create_docx: "output_document",
  library_revise_docx: "drafting",
  Edit: "drafting",
  library_update_metadata: "drafting",
  library_link_docx_citations: "citations",
  library_fix_docx_supras: "citations",
  library_lint_docx_structure: "document_quality",
  library_anchor_coverage: "document_quality",
  library_conflict_scan: "document_quality",
  library_term_drift: "document_quality",
  library_drafting_lint: "document_quality",
  library_bilingual_concordance: "document_quality",
  library_apply_amendment: "amendment",
  library_delete_and_renumber_docx: "drafting",
  library_compare_versions: "amendment",
  toa_submit_library_document: "citations",
  toa_job_status: "citations",
  library_deadline: "deadlines",
  list_workflows: "workflow",
  read_workflow: "workflow",
};

/**
 * The A2AJ tools serve both halves of primary law, so whichever leaf the
 * caller opens, they are the way in.
 */
const ALSO_IN: Record<string, string[]> = {
  legislation: ["a2aj_search", "a2aj_fetch", "a2aj_lookup"],
};

/**
 * The edit scope is part of the surface under test, not a constant. Legacy
 * names an edit site by RETYPING document text (find_text / range); address
 * names it structurally. Leaving `at` in both arms would have let legacy
 * score with the affordance the comparison exists to measure.
 */
function forEditShape(tools: OpenAIToolSchema[]): OpenAIToolSchema[] {
  if (NAV_TOOL_SHAPE === "address") return tools;
  return tools.map((entry) => {
    const ops = (entry.function.parameters as Record<string, any>)?.properties
      ?.ops;
    const scope = ops?.items?.properties?.scope;
    if (!scope?.properties?.kind?.enum) return entry;
    const properties = { ...scope.properties };
    for (const key of ["at", "follow", "depth"]) delete properties[key];
    return {
      ...entry,
      function: {
        ...entry.function,
        parameters: {
          ...(entry.function.parameters as Record<string, unknown>),
          properties: {
            ...(entry.function.parameters as Record<string, any>).properties,
            ops: {
              ...ops,
              items: {
                ...ops.items,
                properties: {
                  ...ops.items.properties,
                  scope: {
                    ...scope,
                    description:
                      "Where the op applies: whole_document; find_text (every occurrence unless occurrence is set); or range (start of from_text through end of to_text).",
                    properties: {
                      ...properties,
                      kind: {
                        ...scope.properties.kind,
                        enum: scope.properties.kind.enum.filter(
                          (kind: string) => kind !== "at",
                        ),
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    } as OpenAIToolSchema;
  });
}

function forNavShape(tools: OpenAIToolSchema[]): OpenAIToolSchema[] {
  const address = NAV_TOOL_SHAPE === "address";
  const drop = address ? LEGACY_ONLY_PARAMS : ADDRESS_ONLY_PARAMS;
  return tools
    .filter((entry) => address || entry.function.name !== "library_links")
    .map((entry) => {
      const legacyText = !address
        ? LEGACY_DESCRIPTIONS[entry.function.name]
        : undefined;
      if (legacyText) {
        entry = {
          ...entry,
          function: { ...entry.function, description: legacyText },
        } as OpenAIToolSchema;
      }
      const remove = drop[entry.function.name];
      if (!remove) return entry;
      const properties = { ...(entry.function.parameters?.properties ?? {}) };
      for (const key of remove) delete (properties as Record<string, unknown>)[key];
      return {
        ...entry,
        function: {
          ...entry.function,
          parameters: { ...entry.function.parameters, properties },
        },
      } as OpenAIToolSchema;
    });
}


const CODING_SHAPE_REPLACES = new Set([
  "library_list",
  "library_find",
  "library_read",
  "library_outline",
  "library_revise_docx",
]);

// These organs become compile-time checks under the SLA workflow. Keeping a
// second callable copy invites duplicate schemas, calls, and results.
const SLA_COMPILER_REPLACES = new Set([
  "library_lint_docx_structure",
  "library_anchor_coverage",
  "library_conflict_scan",
  "library_term_drift",
  "library_drafting_lint",
  "library_bilingual_concordance",
]);

const forAutomaticCompiler = (tools: OpenAIToolSchema[]) =>
  process.env.MIKE_SLA_WORKFLOW === "1"
    ? tools.filter((entry) => !SLA_COMPILER_REPLACES.has(entry.function.name))
    : tools;

const CODING_SHAPE_SUGGESTIONS: Record<string, string> = {
  library_find: "Grep",
  library_read: "Read",
  library_outline: "Grep or Read",
  library_revise_docx: "Edit",
};

const ROUTED_CODING_DESCRIPTION =
  !MODEL_COVERAGE_ROUTING &&
  RETRIEVAL_EXPERIMENT_SHAPE &&
  RETRIEVAL_EXPERIMENT_SHAPE !== "d0-generic" &&
  RETRIEVAL_EXPERIMENT_SHAPE !== "d2-concrete"
  ? " File facts include character and line counts: start with one whole Read for files at or below 24000 characters or questions spanning the whole short document; for a localized target in a larger file, Grep first and then Read the smallest responsive span."
  : "";

const CONCRETE_GREP_DESCRIPTION =
  RETRIEVAL_EXPERIMENT_SHAPE === "d2-concrete"
    ? " For a localized question in a file over 24000 characters, show matching content, then Read the smallest windows covering every requested occurrence and any stated exclusion."
    : "";

const CONCRETE_READ_DESCRIPTION =
  RETRIEVAL_EXPERIMENT_SHAPE === "d2-concrete"
    ? " If the file has at most 24000 characters or the question concerns the whole short file, read it once from line 1. Example: for 'return both clauses, exclude the definition,' read every candidate clause before answering; do not stop at the first hit."
    : "";

const CONTACT_GREP_DESCRIPTION =
  RETRIEVAL_EXPERIMENT_SHAPE === "h1-contact" || LEGAL_GREP_EXPERIMENT
    ? " Content hits include a verified Read recipe."
    : "";

const PAGED_GREP_DESCRIPTION = DEMAND_PAGED_EVIDENCE_ENABLED
  ? ` Exact evidence already observed is mirrored at ${WORKING_SET_PATH}. Search that mounted union only to recover a narrow fact; content hits include executable Read recipes, default to ${WORKING_SET_GREP_DEFAULT_HEAD_LIMIT} centred hits, and never exceed ${WORKING_SET_GREP_MAX_HEAD_LIMIT}. Use the hit directly unless adjacent wording is necessary; never scan the union sequentially.`
  : "";

const PAGED_READ_DESCRIPTION = DEMAND_PAGED_EVIDENCE_ENABLED
  ? " Mounted evidence working-set reads accept only an exact recipe returned by Grep or a same-line truncation continuation."
  : "";

const LEGAL_GREP_DESCRIPTION = LEGAL_GREP_EXPERIMENT
  ? " Optional section, page, and direct-reference scopes bound long legal documents; use ordinary Grep or whole-file Read when cheaper."
  : "";

const CODING_READ_DESCRIPTION = PURE_CODING_EXPERIMENT
  ? "Reads a file. Reads up to 2000 lines by default. Results are returned using cat -n format, with line numbers starting at 1. When you already know which part of the file you need, pass offset and limit for a line window."
  : "Reads a file. Reads up to 2000 lines by default. Results are returned using cat -n format, with line numbers starting at 1. When you already know which part of the file you need, pass a verified section handle shown in Grep results, or pass offset and limit for a line window.";

const WHOLE_READ_BUDGET_DESCRIPTION = WHOLE_READ_MAX_CHARS
  ? " The declared whole-read budget is cumulative for this turn, not per call; if a selection would exceed it, the call returns sizes without exposing text."
  : "";

const WHOLE_READ_REPEAT_DESCRIPTION = SUPPRESS_DUPLICATE_WHOLE_READS
  ? " Read each file/version at most once."
  : " Avoid needless repeats, but a repeated file/version read returns its exact text again when earlier context is no longer available.";

const CODING_SHAPE_TOOLS: OpenAIToolSchema[] = [
  tool(
    "Glob",
    'Fast file pattern matching. Supports glob patterns like "*.docx". Returns filenames with extracted-text character and line counts plus aggregate totals; when filenames collide, also returns the document_id needed to disambiguate them.' +
      (MODEL_COVERAGE_ROUTING
        ? " Use the inventory to choose complete, targeted, or mixed source coverage; when completeness is uncertain and the bounded source set fits, prefer complete coverage."
        : ""),
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
  ...(MODEL_COVERAGE_ROUTING
    ? [
        tool(
          "fetch_documents",
          "Read the complete text of multiple selected files in one call. Use after Glob when most of a bounded source set is relevant, or to keep a primary draft or precedent whole. Use Grep and bounded Read for localized evidence or an oversized corpus; combine both approaches when appropriate." +
            WHOLE_READ_BUDGET_DESCRIPTION +
            WHOLE_READ_REPEAT_DESCRIPTION,
          {
            type: "object",
            properties: {
              doc_ids: {
                type: "array",
                items: { type: "string" },
                description:
                  "Filenames from Glob, or document_ids when filenames collide.",
              },
            },
            required: ["doc_ids"],
          },
        ),
      ]
    : []),
  tool(
    "Grep",
    TOOL_DESCRIPTION_VARIANT === "terse"
      ? "Search file contents with a regular expression." +
        PAGED_GREP_DESCRIPTION
      : 'Content search with regular expressions. Filter by file or glob; choose content, matching files, counts, or a listed legal projection.' +
        ROUTED_CODING_DESCRIPTION +
        CONCRETE_GREP_DESCRIPTION +
        CONTACT_GREP_DESCRIPTION +
        PAGED_GREP_DESCRIPTION +
        LEGAL_GREP_DESCRIPTION,
    {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            "The regular expression pattern to search for in file contents. Do not use . or .* as a whole-file reader; use Read instead.",
        },
        path: {
          type: "string",
          description:
            "Filename to search, or the document_id shown by Glob when filenames are duplicated. Defaults to all files.",
        },
        glob: {
          type: "string",
          description: 'Glob pattern to filter files (e.g. "*.docx")',
        },
        output_mode: {
          type: "string",
          enum: [
            "content",
            "files_with_matches",
            "count",
            ...(LEGAL_GREP_EXPERIMENT ? ["sections"] : []),
            ...(WORKING_SET_EXPERIMENT ? ["working_set"] : []),
          ],
          description:
            'Output mode: "content" shows matching lines (supports -C context, -n line numbers, head_limit), "files_with_matches" shows file paths (default), "count" shows match counts.' +
            (LEGAL_GREP_EXPERIMENT
              ? ' "sections" returns unique executable Read recipes for the legal sections containing matches, without section prose.'
              : "") +
            (WORKING_SET_EXPERIMENT
              ? ACCRETIVE_WORKING_SET_EXPERIMENT
                ? ' "working_set" returns newly added matching sections, rows, or bounded text windows and also persists them in one turn-local evidence file without repeating source spans. Read that file only for a truncation continuation or rehydration after compaction.'
                : ' "working_set" creates an immutable turn-local file from the smallest responsive legal units across matching documents and returns its manifest; Read the returned path.'
              : ""),
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
          minimum: 1,
          description:
            `Limit output to first N lines/entries. Demand-paged evidence defaults to ${WORKING_SET_GREP_DEFAULT_HEAD_LIMIT} and permits at most ${WORKING_SET_GREP_MAX_HEAD_LIMIT}; other searches default to 250.`,
        },
        ...(WORKING_SET_EXPERIMENT
          ? {
              max_chars: {
                type: "number",
                minimum: 1_000,
                maximum: 128_000,
                description:
                  ACCRETIVE_WORKING_SET_EXPERIMENT
                    ? "Total matched-source budget for the turn-local working_set. Defaults to 64000; maximum 128000. Later calls may raise it."
                    : "Source-text budget for working_set only. Defaults to 64000; maximum 128000.",
              },
            }
          : {}),
        ...(LEGAL_GREP_EXPERIMENT
          ? {
              section: {
                type: "string",
                description:
                  "Optional exact section, subsection, table row, or cell handle copied from Grep. Searches that unit and its children.",
              },
              pages: {
                type: "string",
                description:
                  'Optional page scope such as "pdf:12", "printed:47", "12-18", or "3,5,9". Never guess a page scheme.',
              },
              references: {
                type: "string",
                enum: ["none", "inbound", "outbound", "both"],
                description:
                  "With section, optionally search its direct literal reference neighborhood. Inbound means provisions that cite it; outbound means provisions it cites. Defaults to none.",
              },
            }
          : {}),
      },
      required: ["pattern"],
    },
  ),
  tool(
    "Read",
    TOOL_DESCRIPTION_VARIANT === "terse"
      ? "Read a file or an optional bounded scope." + PAGED_READ_DESCRIPTION
      : CODING_READ_DESCRIPTION +
        ROUTED_CODING_DESCRIPTION +
        CONCRETE_READ_DESCRIPTION +
        PAGED_READ_DESCRIPTION,
    {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description:
            "The filename to read, or the document_id shown by Glob when filenames are duplicated",
        },
        offset: {
          type: "number",
          minimum: 1,
          description:
            PURE_CODING_EXPERIMENT
              ? "Optional starting line."
              : "Optional starting line. Omit when reading a section or page.",
        },
        limit: {
          type: "number",
          minimum: 1,
          description:
            "The number of lines to read. Only provide if the file is too large to read at once.",
        },
        ...(DEMAND_PAGED_EVIDENCE_ENABLED
          ? {
              start_char: {
                type: "number",
                minimum: 0,
                description:
                  "Virtual evidence working set only. Zero-based character offset within the first requested line; copy it from a truncated Read continuation.",
              },
            }
          : {}),
        ...(PURE_CODING_EXPERIMENT
          ? {}
          : {
              section: {
                type: "string",
                description:
                  "A verified structural handle shown in Grep results, including an exact DOCX row such as 'table:1/row:2' or cell such as 'table:1/row:2/col:3'. Copy it exactly; do not infer parent or paragraph handles. Returns only that span, numbered by document line.",
              },
            }),
        ...(LEGAL_GREP_EXPERIMENT
          ? {
              pages: {
                type: "string",
                description:
                  'Read an exact page or page range such as "pdf:12", "printed:47", or "12-18". Do not combine with section or offset.',
              },
              references: {
                type: "string",
                enum: ["none", "inbound", "outbound", "both"],
                description:
                  "With section, include the target and every directly linked internal provision in one overlap-suppressed read. Inbound means provisions that cite it; outbound means provisions it cites. Defaults to none.",
              },
            }
          : {}),
      },
      required: ["file_path"],
    },
  ),
  tool(
    "Edit",
    PURE_CODING_EXPERIMENT
      ? "Performs exact string replacement in a file, recorded as a tracked change. old_string must match the file exactly and be unique — the edit fails otherwise; make it unique with more surrounding context."
      : "Performs exact string replacement in a file, recorded as a tracked change. old_string must match the file exactly and be unique — the edit fails otherwise; make it unique with more surrounding context, or pass section to scope the match to one section.",
    {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description:
            "The filename to modify, or the document_id shown by Glob when filenames are duplicated",
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
        ...(PURE_CODING_EXPERIMENT
          ? {}
          : {
              section: {
                type: "string",
                description:
                  "Structural handle (including an exact DOCX cell such as 'table:1/row:2/col:3'); old_string must be unique within it.",
              },
            }),
      },
      required: ["file_path", "old_string", "new_string"],
    },
  ),
];

const RETRIEVAL_EXPERIMENT_TOOLS: OpenAIToolSchema[] =
  RETRIEVAL_EXPERIMENT_SHAPE === "h2-document-map"
    ? [
        tool(
          "DocumentMap",
          "Return a small legal coordinate map only when ordinary wording search cannot answer a provisions, native-table, page-label, or landmark-location question. Every row is an executable Read recipe; no document prose or general outline is returned.",
          {
            type: "object",
            properties: {
              file_path: {
                type: "string",
                description: "Opaque filename or document_id.",
              },
              focus: {
                type: "string",
                enum: ["provisions", "tables", "pages", "landmarks"],
                description:
                  "Required map: numbered provisions; native table/row/cell coordinates; PDF versus printed pages; or top-level articles, schedules, and exhibits.",
              },
              query: {
                type: "string",
                description:
                  "Optional literal words that map rows must contain. Omit only for a genuinely global orientation task.",
              },
              max_results: {
                type: "integer",
                minimum: 1,
                maximum: 25,
                description: "Maximum rows. Defaults to 25.",
              },
            },
            required: ["file_path", "focus"],
          },
        ),
      ]
    : RETRIEVAL_EXPERIMENT_SHAPE === "h3-reference-impact"
      ? [
          tool(
            "ReferenceImpact",
            "Return one bounded, deterministic set of literal cross-reference locations. Use only for inbound/outbound-reference questions or deletion plus closing a numbering gap; it returns Read recipes, typed ambiguities, and no clause prose or similarity guesses.",
            {
              type: "object",
              properties: {
                file_path: {
                  type: "string",
                  description: "Opaque filename or document_id.",
                },
                targets: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "One or more exact provision handles copied from Grep or Read.",
                },
                operation: {
                  type: "string",
                  enum: ["inbound", "outbound", "delete_and_close_gap"],
                  description:
                    "Literal pointers into the target, literal pointers made by it, or the complete deterministic delete-and-renumber impact plan.",
                },
              },
              required: ["file_path", "targets", "operation"],
            },
          ),
        ]
      : [];

function domainEntriesForTools(tools: OpenAIToolSchema[]) {
  return Object.entries(TOOL_DOMAINS).filter(([name]) =>
    toolsForDomains(tools, [name]).length,
  );
}

export function describeToolsTool(
  tools: OpenAIToolSchema[],
  allowEvidenceSelection = false,
): OpenAIToolSchema {
  const domains = domainEntriesForTools(tools);
  const contextHandoff = process.env.MIKE_CONTEXT_HANDOFF === "1";
  const pagedHandoff =
    contextHandoff && process.env.MIKE_DRAFT_HANDOFF_MODE === "paged";
  return tool(
    "describe_tools",
    `Load a domain of tools that is not available yet. Domains: ${domains
      .map(([name, domain]) => `${name} (${domain.blurb})`)
      .join("; ")}. Call this the moment a task needs one of them; the tools become callable immediately after.${
        contextHandoff
          ? pagedHandoff
            ? " Opening drafting or output_document starts a fresh drafting context with the research checkpoint and demand-paged exact evidence."
            : " Opening drafting or output_document starts a fresh drafting context containing the exact evidence read so far."
          : ""
      }`,
    {
      type: "object",
      properties: {
        domains: {
          type: "array",
          items: { type: "string", enum: domains.map(([name]) => name) },
          description: "One or more domains to open.",
        },
        ...(contextHandoff && !pagedHandoff && allowEvidenceSelection
          ? {
              carry_evidence: {
                type: "array",
                items: { type: "string" },
                description:
                  "Exact evidence aliases from the host's selection manifest to carry into drafting. Copy each complete E-xxxxxxxx alias; wildcards and placeholders are invalid.",
              },
            }
          : {}),
      },
      required: ["domains"],
    },
  );
}

/**
 * Split for the address arm: what ships in the request, and what
 * `describe_tools` can reveal. Exported because the A/B harness owns the
 * conversation loop and has to add revealed tools to the next request.
 */
export function partitionTools(tools: OpenAIToolSchema[]): {
  resident: OpenAIToolSchema[];
  deferred: OpenAIToolSchema[];
} {
  if (!PROGRESSIVE_DISCLOSURE_ENABLED)
    return { resident: tools, deferred: [] };
  const isResident = (entry: OpenAIToolSchema) =>
    RESIDENT_TOOLS.has(entry.function.name) ||
    (RESIDENT_AUTHORING_ENABLED &&
      entry.function.name === "library_create_docx");
  const resident = tools.filter(isResident);
  const deferred = tools.filter((entry) => !isResident(entry));
  return { resident: [...resident, describeToolsTool(deferred)], deferred };
}

/** Schemas for the domains a `describe_tools` call asked for. */
export function toolsForDomains(
  tools: OpenAIToolSchema[],
  domains: string[],
): OpenAIToolSchema[] {
  const wanted = new Set(domains.map((domain) => domain.trim().toLowerCase()));
  const also = new Set([...wanted].flatMap((domain) => ALSO_IN[domain] ?? []));
  return tools.filter(
    (entry) =>
      wanted.has(DOMAIN_OF[entry.function.name] ?? "") ||
      also.has(entry.function.name),
  );
}

const CODING_DOCUMENT_REFERENCE_FIELDS = new Set([
  "document_id",
  "source_document_id",
  "amendment_document_id",
  "english_document_id",
  "french_document_id",
]);
const CODING_DOCUMENT_REFERENCE_ARRAY_FIELDS = new Set([
  "document_ids",
  "doc_ids",
  "source_document_ids",
  "draft_document_ids",
]);

function forCodingVocabulary(tools: OpenAIToolSchema[]): OpenAIToolSchema[] {
  if (!CODING_TOOL_SHAPE) return tools;
  const rewrite = (value: unknown, key = ""): unknown => {
    if (Array.isArray(value)) return value.map((entry) => rewrite(entry));
    if (!value || typeof value !== "object") {
      if (key !== "description" || typeof value !== "string") return value;
      return value
        .replace(/library_outline/gu, "Grep")
        .replace(/library_read/gu, "Read")
        .replace(/library_find/gu, "Grep")
        .replace(/library_revise_docx/gu, "Edit");
    }
    const rewritten = Object.fromEntries(
      Object.entries(value).map(([name, entry]) => [
        name,
        rewrite(entry, name),
      ]),
    );
    if (CODING_DOCUMENT_REFERENCE_FIELDS.has(key)) {
      rewritten.description =
        "Filename from Glob, or document_id when Glob reports a duplicate filename.";
    } else if (CODING_DOCUMENT_REFERENCE_ARRAY_FIELDS.has(key)) {
      rewritten.description =
        "Filenames from Glob, or document_ids for duplicate filenames.";
    }
    return rewritten;
  };
  return tools.map((entry) => rewrite(entry) as OpenAIToolSchema);
}

const ORIGIN_MIKE_ACTIVE_TOOLS = LEAN_BATCH_FAMILY_TOOL_SHAPE
  ? LEAN_BATCH_LAB_TOOLS
  : COMPACT_AUTHOR_MIKE_TOOL_SHAPE
    ? COMPACT_AUTHOR_MIKE_LAB_TOOLS
    : MARKDOWN_SWAP_MIKE_TOOL_SHAPE || MARKDOWN_E2E_MIKE_TOOL_SHAPE
      ? UPSTREAM_MIKE_MARKDOWN_SWAP_LAB_TOOLS
      : MIKE_GREP_FAMILY_TOOL_SHAPE
        ? MIKE_GREP_TOOL_SHAPE
          ? MIKE_GREP_LAB_TOOLS
          : MIKE_STRUCTURE_PATHS_TOOL_SHAPE
            ? MIKE_STRUCTURE_PATHS_LAB_TOOLS
            : MIKE_LEGAL_LAB_TOOLS
        : ADAPTIVE_MIKE_TOOL_SHAPE
          ? ADAPTIVE_MIKE_LAB_TOOLS
          : UPSTREAM_MIKE_LAB_TOOLS;

const LOCAL_ASSISTANT_TOOL_CATALOG: OpenAIToolSchema[] = [
  ...(ASK_INPUTS_DISABLED ? [] : LOCAL_ASK_INPUTS_TOOLS),
  ...(ORIGIN_MIKE_TOOL_SHAPE
    ? ORIGIN_MIKE_ACTIVE_TOOLS
    : CODING_TOOL_SHAPE
    ? [
        ...CODING_SHAPE_TOOLS,
        ...RETRIEVAL_EXPERIMENT_TOOLS,
        ...forNavShape(
          forAutomaticCompiler(LOCAL_LIBRARY_TOOLS).filter(
            (entry) => !CODING_SHAPE_REPLACES.has(entry.function.name),
          ),
        ),
      ]
    : forNavShape(forAutomaticCompiler(LOCAL_LIBRARY_TOOLS))),
  ...(ORIGIN_MIKE_TOOL_SHAPE
    ? []
    : CODING_TOOL_SHAPE
    ? LOCAL_DOCX_TOOLS.filter(
        (entry) => !CODING_SHAPE_REPLACES.has(entry.function.name),
      )
    : LOCAL_DOCX_TOOLS),
  ...(ORIGIN_MIKE_TOOL_SHAPE ? [] : COMPARE_VERSIONS_TOOLS),
  ...(ORIGIN_MIKE_TOOL_SHAPE
    ? []
    : forEditShape(TEXT_OPS_TOOLS as OpenAIToolSchema[])),
  ...(ORIGIN_MIKE_TOOL_SHAPE ? [] : (WORKFLOW_TOOLS as OpenAIToolSchema[])),
  ...(ORIGIN_MIKE_TOOL_SHAPE || RESEARCH_TOOLS_DISABLED
    ? []
    : [
        ...(COURTLISTENER_TOOLS as OpenAIToolSchema[]),
        ...(A2AJ_TOOLS as OpenAIToolSchema[]),
        ...(PUBLIC_LEGAL_SOURCE_TOOLS as OpenAIToolSchema[]),
        ...HANSARD_TOOLS,
        ...CITATOR_TOOLS,
      ]),
];

export const LOCAL_ASSISTANT_TOOLS = MIKE_FILE_TOOL_SHAPE
  ? LOCAL_ASSISTANT_TOOL_CATALOG
  : forCodingVocabulary(LOCAL_ASSISTANT_TOOL_CATALOG);

const trimmed = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const stringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];

async function resolveCodingDocumentReferences(
  userId: string,
  input: Record<string, unknown>,
  allowedDocumentIds?: ReadonlySet<string>,
): Promise<{ input: Record<string, unknown>; error?: string }> {
  const fields = Object.keys(input).filter(
    (field) =>
      CODING_DOCUMENT_REFERENCE_FIELDS.has(field) ||
      CODING_DOCUMENT_REFERENCE_ARRAY_FIELDS.has(field),
  );
  if (!fields.length) return { input };

  const collection = await listLocalLibrary(userId, "file");
  const documents = collection.documents.filter(
    (document) => !allowedDocumentIds || allowedDocumentIds.has(document.id),
  );
  const byFilename = new Map<string, typeof documents>();
  for (const document of documents) {
    const key = document.filename.toLocaleLowerCase();
    byFilename.set(key, [...(byFilename.get(key) ?? []), document]);
  }
  const resolve = (reference: string): { value: string; error?: string } => {
    if (documents.some((document) => document.id === reference)) {
      return { value: reference };
    }
    const matches = byFilename.get(reference.toLocaleLowerCase()) ?? [];
    if (matches.length === 1) return { value: matches[0].id };
    if (matches.length > 1) {
      return {
        value: reference,
        error: MIKE_GREP_FAMILY_TOOL_SHAPE
          ? `Filename '${reference}' is ambiguous. Use list_documents and pass its doc-N label.`
          : `Filename '${reference}' is ambiguous. Use Glob to obtain its document_id.`,
      };
    }
    return { value: reference };
  };

  const resolved = { ...input };
  for (const field of fields) {
    if (CODING_DOCUMENT_REFERENCE_FIELDS.has(field)) {
      const reference = trimmed(input[field]);
      if (!reference) continue;
      const next = resolve(reference);
      if (next.error) return { input, error: next.error };
      resolved[field] = next.value;
      continue;
    }
    if (!Array.isArray(input[field])) continue;
    const values: string[] = [];
    for (const raw of input[field]) {
      if (typeof raw !== "string") continue;
      const next = resolve(raw);
      if (next.error) return { input, error: next.error };
      values.push(next.value);
    }
    resolved[field] = values;
  }
  return { input: resolved };
}

const optionalString = (value: unknown) =>
  typeof value === "string" ? value : undefined;
const optionalNumber = (value: unknown) =>
  typeof value === "number" ? value : undefined;
const clampInt = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === "number"
    ? Math.min(Math.max(Math.trunc(value), min), max)
    : fallback;
// Coding models commonly serialize an omitted optional number as 0. For
// one-based Read arguments, 0 means "not supplied", not line 1 or a
// one-line window. Positive values retain the ordinary clamped semantics.
const positiveInt = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === "number" && value > 0
    ? Math.min(Math.max(Math.trunc(value), min), max)
    : fallback;
const errorText = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

export type LocalAssistantEditTurnState = Map<
  string,
  { versionId: string; parentVersionId: string }
>;

export type LocalAssistantReadTurnState = Map<
  string,
  {
    documentId: string;
    docLabel?: string;
    versionId: string;
    filename: string;
    sourceChars?: number;
    deliveredChars?: number;
  }
>;

type WorkingSetEvidenceSegment = {
  virtualStart: number;
  virtualEnd: number;
  documentId: string;
  versionId: string;
  sourceStart: number;
  sourceEnd: number;
  filename?: string;
  locator?: string;
  virtualPath?: string;
  projection?: string;
  durableUnionBacked?: boolean;
};

type WorkingSetEvidenceRef = {
  virtualStart: number;
  virtualEnd: number;
  handle: string;
  filename: string;
  locator?: string;
  exactSha256: string;
  durableUnionBacked?: boolean;
};

export type LocalAssistantWorkingSetTurnState = Map<
  string,
  {
    path: string;
    text: string;
    sourceChars: number;
    matchedSourceChars: number;
    immutableSourceChars?: number;
    mapChars: number;
    budgetChars: number;
    mappedVersions: string[];
    segments: WorkingSetEvidenceSegment[];
    refs?: WorkingSetEvidenceRef[];
    demandPaged?: boolean;
    readGrants?: Set<string>;
  }
>;

/** Create or update the one assistant-edit version for this document/turn. */
export async function commitLocalAssistantTurnVersion(params: {
  userId: string;
  documentId: string;
  sourceVersionId: string;
  filename: string;
  bytes: Buffer;
  trackedEdits: LocalTrackedEdit[];
  turnEditState?: LocalAssistantEditTurnState;
}) {
  const existing = params.turnEditState?.get(params.documentId);
  if (existing && existing.versionId !== params.sourceVersionId) return null;
  const parentVersionId = existing?.parentVersionId ?? params.sourceVersionId;
  const version = existing
    ? await updateLocalAssistantTurnVersion({
        userId: params.userId,
        documentId: params.documentId,
        versionId: existing.versionId,
        parentVersionId,
        filename: params.filename,
        bytes: params.bytes,
        trackedEdits: params.trackedEdits,
      })
    : await addLocalVersion({
        userId: params.userId,
        documentId: params.documentId,
        filename: params.filename,
        bytes: params.bytes,
        expectedVersionId: params.sourceVersionId,
        provenance: {
          schemaVersion: 1,
          actor: "assistant",
          action: "revised",
          parentVersionId,
          changeCount: params.trackedEdits.length,
          trackedEdits: params.trackedEdits,
        },
      });
  if (version) {
    params.turnEditState?.set(params.documentId, {
      versionId: version.id,
      parentVersionId,
    });
  }
  return version ? { version, parentVersionId } : null;
}

// ---------------------------------------------------------------------------
// Coding-shape aliases: Glob/Grep/Read over the library, file-path addressed,
// line-numbered. Output mirrors the native tools (cat -n reads, rg-style
// match lines, plain-text errors) because the trained package is the whole
// interaction grammar, not just the schema names.
// ---------------------------------------------------------------------------

function globAlternatives(pattern: string): string[] {
  const match = /\{([^{}]+)\}/u.exec(pattern);
  if (!match || !match[1].includes(",")) return [pattern];
  const values = match[1].split(",").map((value) => value.trim());
  if (!values.length || values.length > 32 || values.some((value) => !value)) {
    return [pattern];
  }
  return values.flatMap((value) =>
    globAlternatives(
      `${pattern.slice(0, match.index)}${value}${pattern.slice(match.index + match[0].length)}`,
    ),
  );
}

const globSource = (pattern: string) =>
  pattern
      // The Library is flat. Coding agents commonly emit **/*.docx, which
      // should include files at that root just as a filesystem glob does.
      .replace(/^(?:\.\/)?(?:\*\*\/)+/u, "")
      .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
      .replace(/\*\*/gu, "\u0000")
      .replace(/\*/gu, "[^/]*")
      .replace(/\?/gu, ".")
      .replace(/\u0000/gu, ".*");

const globRegExp = (pattern: string) =>
  new RegExp(
    `^(?:${globAlternatives(pattern).map(globSource).join("|")})$`,
    "iu",
  );

const GREP_LINE_CAP = 2_000;

type CodingOutputLine = {
  rendered: string;
  span?: [number, number];
  readGrant?: { line: number; startChar: number };
  handoffCandidate?: boolean;
  source?: {
    documentId: string;
    versionId: string;
    filename?: string;
    locator?: string;
    virtualPath?: string;
    projection?: string;
  };
};

function sourceLineStarts(text: string, lines: string[]): number[] {
  const starts: number[] = [];
  let cursor = 0;
  for (const line of lines) {
    starts.push(cursor);
    cursor += line.length;
    if (text.startsWith("\r\n", cursor)) cursor += 2;
    else if (text[cursor] === "\n") cursor += 1;
  }
  return starts;
}

function takeCodingOutputLines(
  lines: CodingOutputLine[],
  maxChars = MAX_TOOL_RESULT_CHARS,
) {
  // Leave room for the continuation hint and never trigger the generic
  // head/tail truncator, whose JSON envelope would obscure cat/rg output.
  const budget = Math.max(
    1_000,
    Math.min(MAX_TOOL_RESULT_CHARS, maxChars) - 1_000,
  );
  const kept: CodingOutputLine[] = [];
  let chars = 0;
  for (const line of lines) {
    const added = line.rendered.length + (kept.length ? 1 : 0);
    if (kept.length && chars + added > budget) break;
    kept.push(line);
    chars += added;
  }
  return { kept, truncated: kept.length < lines.length };
}

type TextRange = { start: number; end: number };

type WorkingSetCandidate = TextRange & {
  documentId: string;
  versionId: string;
  filename: string;
  filePath: string;
  sourceText: string;
  projection: "legal-unit" | "window";
  handle?: string;
  contextLabel?: string;
  anchor: number;
  hits: number;
};

type WorkingSetMapCandidate = {
  documentId: string;
  versionId: string;
  filename: string;
  rows: string[];
};

function workingSetMapRows(
  skeleton: AgreementSkeleton,
  tableCells: readonly TableCellSpan[],
  sourceText: string,
) {
  const rows: string[] = [];
  const seen = new Set<string>();
  const structural = skeleton.nodes.filter(
    (node) => node.kind !== "row" && node.kind !== "cell" && node.kind !== "table",
  );
  const containers = structural.filter((node) =>
    ["article", "part", "division", "schedule"].includes(node.kind),
  );
  const sample = <T>(items: readonly T[], count: number): T[] =>
    items.length <= count
      ? [...items]
      : Array.from({ length: count }, (_, index) =>
          items[
            Math.round((index * (items.length - 1)) / Math.max(1, count - 1))
          ],
        );
  const selectedContainers = sample(containers, 16);
  const remaining = structural.filter((node) => !containers.includes(node));
  const selected = [...selectedContainers, ...sample(remaining, 24 - selectedContainers.length)]
    .sort((left, right) => left.start - right.start)
    .slice(0, 24);
  for (const node of selected) {
    const row = `${node.kind}\t${node.label}\t${node.heading.trim().slice(0, 160)}`;
    if (!seen.has(row)) rows.push(row);
    seen.add(row);
  }
  const byTable = new Map<number, TableCellSpan[]>();
  for (const cell of tableCells) {
    const cells = byTable.get(cell.table) ?? [];
    cells.push(cell);
    byTable.set(cell.table, cells);
  }
  for (const [table, cells] of byTable) {
    const maxRow = Math.max(...cells.map((cell) => cell.row));
    const maxColumn = Math.max(...cells.map((cell) => cell.column));
    const name = cells.find((cell) => cell.tableName)?.tableName;
    const headers = cells
      .filter((cell) => cell.row === 1)
      .slice(0, 12)
      .map((cell) => {
        const address = cell.address ?? `r${cell.row}c${cell.column}`;
        const value = sourceText.slice(cell.start, cell.end).trim().slice(0, 80);
        return `${address}=${value}`;
      })
      .join(" | ");
    rows.push(
      `table\ttable:${table}${name ? `\t${name}` : ""}\t${maxRow}x${maxColumn}` +
        (headers ? `\theaders ${headers}` : ""),
    );
  }
  if (structural.length > selected.length) {
    rows.push(`… ${structural.length - selected.length} additional provisions`);
  }
  return rows;
}

function mergeWorkingSetCandidates(
  candidates: readonly WorkingSetCandidate[],
): WorkingSetCandidate[] {
  const groups = new Map<string, WorkingSetCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.documentId}:${candidate.versionId}`;
    const group = groups.get(key) ?? [];
    group.push({ ...candidate });
    groups.set(key, group);
  }
  const merged: WorkingSetCandidate[] = [];
  for (const group of groups.values()) {
    group.sort((left, right) => left.start - right.start || left.end - right.end);
    for (const candidate of group) {
      const prior = merged.at(-1);
      if (
        !prior ||
        prior.documentId !== candidate.documentId ||
        prior.versionId !== candidate.versionId ||
        candidate.start > prior.end
      ) {
        merged.push(candidate);
        continue;
      }
      prior.end = Math.max(prior.end, candidate.end);
      prior.hits += candidate.hits;
      if (prior.handle !== candidate.handle) {
        prior.handle = undefined;
        prior.contextLabel = undefined;
        prior.projection = "window";
      }
    }
  }
  return merged;
}

function addCoveredRange(covered: TextRange[], added: TextRange) {
  const ordered = [...covered, added].sort((left, right) => left.start - right.start);
  const merged: TextRange[] = [];
  for (const range of ordered) {
    const last = merged.at(-1);
    if (!last || range.start > last.end) merged.push({ ...range });
    else last.end = Math.max(last.end, range.end);
  }
  covered.splice(0, covered.length, ...merged);
}

function uncoveredRanges(range: TextRange, covered: readonly TextRange[]) {
  let cursor = range.start;
  const open: TextRange[] = [];
  for (const prior of covered) {
    if (prior.end <= cursor) continue;
    if (prior.start >= range.end) break;
    if (prior.start > cursor) {
      open.push({ start: cursor, end: Math.min(prior.start, range.end) });
    }
    cursor = Math.max(cursor, prior.end);
    if (cursor >= range.end) break;
  }
  if (cursor < range.end) open.push({ start: cursor, end: range.end });
  return open;
}

function workingSetEvidenceSegments(
  set: LocalAssistantWorkingSetTurnState extends Map<string, infer Value>
    ? Value
    : never,
  ranges: readonly [number, number][],
) {
  const evidence: NonNullable<NormalizedToolResult["evidenceSegments"]> = [];
  for (const [start, end] of ranges) {
    for (const segment of set.segments) {
      const overlapStart = Math.max(start, segment.virtualStart);
      const overlapEnd = Math.min(end, segment.virtualEnd);
      if (overlapStart >= overlapEnd) continue;
      evidence.push({
        documentId: segment.documentId,
        versionId: segment.versionId,
        start: segment.sourceStart + overlapStart - segment.virtualStart,
        end: segment.sourceStart + overlapEnd - segment.virtualStart,
        ...(segment.filename && { filename: segment.filename }),
        ...(segment.locator && { locator: segment.locator }),
        ...(segment.virtualPath && { virtualPath: segment.virtualPath }),
        ...(segment.projection && { projection: segment.projection }),
        kind: "evidence",
        ...(segment.durableUnionBacked && { durableUnionBacked: true }),
      });
    }
  }
  return evidence;
}

function workingSetEvidenceRefs(
  set: LocalAssistantWorkingSetTurnState extends Map<string, infer Value>
    ? Value
    : never,
  ranges: readonly [number, number][],
) {
  const evidence: NonNullable<NormalizedToolResult["evidenceRefs"]> = [];
  for (const [start, end] of ranges) {
    for (const ref of set.refs ?? []) {
      const overlapStart = Math.max(start, ref.virtualStart);
      const overlapEnd = Math.min(end, ref.virtualEnd);
      if (overlapStart >= overlapEnd) continue;
      const text = set.text.slice(overlapStart, overlapEnd);
      const localStart = overlapStart - ref.virtualStart;
      const localEnd = overlapEnd - ref.virtualStart;
      evidence.push({
        handle: `${ref.handle}#chars=${localStart}-${localEnd}`,
        text,
        filename: ref.filename,
        locator:
          localStart === 0 && localEnd === ref.virtualEnd - ref.virtualStart
            ? ref.locator
            : `${ref.locator ?? ref.handle} chars ${localStart}-${localEnd}`,
        exactSha256: sha256(text),
        kind: "evidence",
        ...(ref.durableUnionBacked && { durableUnionBacked: true }),
      });
    }
  }
  return evidence;
}

function materializeStatelessWorkingSet(
  candidates: readonly WorkingSetCandidate[],
  requestedBudget: unknown,
  state: LocalAssistantWorkingSetTurnState,
) {
  const budget = clampInt(requestedBudget, 1_000, 128_000, 64_000);
  const queues = new Map<string, WorkingSetCandidate[]>();
  for (const candidate of mergeWorkingSetCandidates(candidates)) {
    const key = `${candidate.documentId}:${candidate.versionId}`;
    const queue = queues.get(key) ?? [];
    queue.push(candidate);
    queues.set(key, queue);
  }
  for (const queue of queues.values()) {
    queue.sort((left, right) => left.start - right.start || left.end - right.end);
  }

  const selected: WorkingSetCandidate[] = [];
  let sourceChars = 0;
  let omitted = 0;
  while ([...queues.values()].some((queue) => queue.length)) {
    let advanced = false;
    for (const queue of queues.values()) {
      const candidate = queue.shift();
      if (!candidate) continue;
      advanced = true;
      const remaining = budget - sourceChars;
      if (remaining <= 0) {
        omitted += 1 + queue.length;
        queue.length = 0;
        continue;
      }
      let kept = candidate;
      if (candidate.end - candidate.start > remaining) {
        if (remaining < 1_000) {
          omitted += 1;
          continue;
        }
        const width = Math.min(4_000, remaining);
        const start = Math.max(
          candidate.start,
          Math.min(candidate.anchor - Math.floor(width / 2), candidate.end - width),
        );
        kept = {
          ...candidate,
          start,
          end: Math.min(candidate.end, start + width),
          projection: "window",
          handle: undefined,
        };
      }
      selected.push(kept);
      sourceChars += kept.end - kept.start;
    }
    if (!advanced) break;
  }

  const identity = selected.map((item) => ({
    documentId: item.documentId,
    versionId: item.versionId,
    start: item.start,
    end: item.end,
    projection: item.projection,
  }));
  const path = `.mike/working-sets/${sha256(JSON.stringify(identity)).slice(0, 16)}.txt`;
  const parts: string[] = [];
  const segments: WorkingSetEvidenceSegment[] = [];
  let cursor = 0;
  for (const item of selected) {
    const startLine = item.sourceText.slice(0, item.start).split(/\r?\n/u).length;
    const endLine =
      startLine + item.sourceText.slice(item.start, item.end).split(/\r?\n/u).length - 1;
    const recipe = item.handle
      ? `Read(file_path=${JSON.stringify(item.filePath)}, section=${JSON.stringify(item.handle)})`
      : `Read(file_path=${JSON.stringify(item.filePath)}, offset=${startLine}, limit=${Math.max(1, endLine - startLine + 1)})`;
    const context = item.contextLabel ? ` | ${item.contextLabel}` : "";
    const header = `=== ${item.filename}${context} :: ${recipe} ===\n`;
    parts.push(header);
    cursor += header.length;
    const source = item.sourceText.slice(item.start, item.end);
    parts.push(source, "\n\n");
    segments.push({
      virtualStart: cursor,
      virtualEnd: cursor + source.length,
      documentId: item.documentId,
      versionId: item.versionId,
      sourceStart: item.start,
      sourceEnd: item.end,
    });
    cursor += source.length + 2;
  }
  const text = parts.join("");
  state.set(path, {
    path,
    text,
    sourceChars,
    matchedSourceChars: sourceChars,
    mapChars: 0,
    budgetChars: budget,
    mappedVersions: [],
    segments,
  });
  return {
    ok: true,
    path,
    documents: new Set(selected.map((item) => item.documentId)).size,
    units: selected.length,
    source_chars: sourceChars,
    budget_chars: budget,
    truncated: omitted > 0,
    omitted_units: omitted,
    next: `Read(file_path=${JSON.stringify(path)})`,
  };
}

function materializeAccretiveWorkingSet(
  candidates: readonly WorkingSetCandidate[],
  maps: readonly WorkingSetMapCandidate[],
  requestedBudget: unknown,
  state: LocalAssistantWorkingSetTurnState,
  coverage?: { searched: number; matched: number },
) {
  const prior = state.get(WORKING_SET_PATH);
  const requested = clampInt(requestedBudget, 1_000, 128_000, 64_000);
  const budget = Math.max(prior?.budgetChars ?? 0, requested);
  const immutableSourceChars = prior?.immutableSourceChars ?? 0;
  const priorAppendedSourceChars = Math.max(
    0,
    (prior?.matchedSourceChars ?? 0) - immutableSourceChars,
  );
  const coveredBySource = new Map<string, TextRange[]>();
  for (const segment of prior?.segments ?? []) {
    const key = `${segment.documentId}:${segment.versionId}`;
    const covered = coveredBySource.get(key) ?? [];
    addCoveredRange(covered, {
      start: segment.sourceStart,
      end: segment.sourceEnd,
    });
    coveredBySource.set(key, covered);
  }
  const mappedVersions = new Set(prior?.mappedVersions ?? []);
  const newMaps = maps.filter(
    (item) => !mappedVersions.has(`${item.documentId}:${item.versionId}`),
  );
  const mapParts: string[] = [];
  let mapCursor = prior?.text.length ?? 0;
  let addedMapChars = 0;
  const mapBudgetRemaining = Math.max(0, 12_000 - (prior?.mapChars ?? 0));
  const perMapBudget = newMaps.length
    ? Math.min(
        3_000,
        Math.max(300, Math.floor(mapBudgetRemaining / newMaps.length)),
      )
    : 0;
  for (const item of newMaps) {
    if (addedMapChars >= mapBudgetRemaining || perMapBudget <= 0) break;
    const key = `${item.documentId}:${item.versionId}`;
    const cap = Math.min(perMapBudget, mapBudgetRemaining - addedMapChars);
    const header = `=== FILE MAP ${item.filename} ===\n`;
    let rendered = `${header}`;
    for (const row of item.rows) {
      const next = `${row}\n`;
      if (rendered.length + next.length > cap) break;
      rendered += next;
    }
    rendered += "\n";
    mapParts.push(rendered);
    mappedVersions.add(key);
    mapCursor += rendered.length;
    addedMapChars += rendered.length;
  }
  const queues = new Map<string, WorkingSetCandidate[]>();
  let alreadyPresentChars = 0;
  for (const candidate of mergeWorkingSetCandidates(candidates)) {
    const key = `${candidate.documentId}:${candidate.versionId}`;
    const queue = queues.get(key) ?? [];
    const open = uncoveredRanges(candidate, coveredBySource.get(key) ?? []);
    alreadyPresentChars +=
      candidate.end - candidate.start -
      open.reduce((total, range) => total + range.end - range.start, 0);
    for (const range of open) {
      const whole = range.start === candidate.start && range.end === candidate.end;
      queue.push({
        ...candidate,
        ...range,
        ...(whole
          ? {}
          : {
              projection: "window" as const,
              handle: undefined,
              contextLabel: undefined,
            }),
      });
    }
    queues.set(key, queue);
  }
  for (const queue of queues.values()) {
    queue.sort(
      (left, right) =>
        right.hits - left.hits || left.start - right.start || left.end - right.end,
    );
  }

  const selected: WorkingSetCandidate[] = [];
  let addedSourceChars = 0;
  let omitted = 0;
  while ([...queues.values()].some((queue) => queue.length)) {
    let advanced = false;
    for (const queue of queues.values()) {
      const candidate = queue.shift();
      if (!candidate) continue;
      advanced = true;
      const remaining =
        budget - priorAppendedSourceChars - addedSourceChars;
      if (remaining <= 0) {
        omitted += 1 + queue.length;
        queue.length = 0;
        continue;
      }
      let kept = candidate;
      if (candidate.end - candidate.start > remaining) {
        if (remaining < 1_000) {
          omitted += 1;
          continue;
        }
        const width = Math.min(4_000, remaining);
        const start = Math.max(
          candidate.start,
          Math.min(candidate.anchor - Math.floor(width / 2), candidate.end - width),
        );
        kept = {
          ...candidate,
          start,
          end: Math.min(candidate.end, start + width),
          projection: "window",
          handle: undefined,
        };
      }
      selected.push(kept);
      addedSourceChars += kept.end - kept.start;
    }
    if (!advanced) break;
  }

  const path = WORKING_SET_PATH;
  const parts: string[] = [...mapParts];
  const segments: WorkingSetEvidenceSegment[] = [
    ...(prior?.segments ?? []),
  ];
  let cursor = mapCursor;
  const deltaOffset = (prior?.text.match(/\n/gu)?.length ?? 0) + 1;
  for (const item of selected) {
    const startLine = item.sourceText.slice(0, item.start).split(/\r?\n/u).length;
    const endLine =
      startLine + item.sourceText.slice(item.start, item.end).split(/\r?\n/u).length - 1;
    const recipe = item.handle
      ? `Read(file_path=${JSON.stringify(item.filePath)}, section=${JSON.stringify(item.handle)})`
      : `Read(file_path=${JSON.stringify(item.filePath)}, offset=${startLine}, limit=${Math.max(1, endLine - startLine + 1)})`;
    const context = item.contextLabel ? ` | ${item.contextLabel}` : "";
    const header = `=== ${item.filename}${context} :: ${recipe} ===\n`;
    parts.push(header);
    cursor += header.length;
    const source = item.sourceText.slice(item.start, item.end);
    parts.push(source, "\n\n");
    segments.push({
      virtualStart: cursor,
      virtualEnd: cursor + source.length,
      documentId: item.documentId,
      versionId: item.versionId,
      sourceStart: item.start,
      sourceEnd: item.end,
    });
    cursor += source.length + 2;
  }
  const delta = parts.join("");
  const text = (prior?.text ?? "") + delta;
  const matchedSourceChars =
    (prior?.matchedSourceChars ?? 0) + addedSourceChars;
  const sourceChars = (prior?.sourceChars ?? 0) + addedSourceChars;
  const mapChars = (prior?.mapChars ?? 0) + addedMapChars;
  state.set(path, {
    path,
    text,
    sourceChars,
    matchedSourceChars,
    immutableSourceChars,
    mapChars,
    budgetChars: budget,
    mappedVersions: [...mappedVersions],
    segments,
    refs: prior?.refs,
  });
  return {
    manifest: {
      ok: true,
      path,
      documents: new Set(segments.map((item) => item.documentId)).size,
      units: segments.length,
      added_units: selected.length,
      added_source_chars: addedSourceChars,
      added_match_chars: addedSourceChars,
      added_map_chars: addedMapChars,
      already_present_chars: alreadyPresentChars,
      source_chars: sourceChars,
      matched_source_chars: matchedSourceChars,
      map_chars: mapChars,
      budget_chars: budget,
      truncated: omitted > 0,
      omitted_units: omitted,
      searched_documents: coverage?.searched ?? null,
      matched_documents: coverage?.matched ?? null,
      next: delta
        ? `Read(file_path=${JSON.stringify(path)}, offset=${deltaOffset})`
        : null,
    },
    delta,
    deltaStart: prior?.text.length ?? 0,
    set: state.get(path)!,
  };
}

function accretiveWorkingSetResult(
  call: NormalizedToolCall,
  materialized: ReturnType<typeof materializeAccretiveWorkingSet>,
): NormalizedToolResult {
  const { manifest, delta, deltaStart, set } = materialized;
  const header =
    `[WORKING SET ${manifest.path} | added ${manifest.added_units} units | omitted ${manifest.omitted_units}` +
    (manifest.searched_documents === null
      ? "]"
      : ` | matched ${manifest.matched_documents}/${manifest.searched_documents} docs]`);
  if (!delta) {
    return result(
      call,
      `${header}\nNo new evidence; ${manifest.already_present_chars} matching source chars were already present.`,
    );
  }
  const available = Math.max(1_000, MAX_TOOL_RESULT_CHARS - header.length - 300);
  let shown = delta.slice(0, available);
  if (shown.length < delta.length) {
    const boundary = shown.lastIndexOf("\n");
    if (boundary > 0) shown = shown.slice(0, boundary + 1);
  }
  const shownEnd = deltaStart + shown.length;
  const nextOffset = set.text.slice(0, shownEnd).split(/\r?\n/u).length;
  const content =
    `${header}\n${shown}` +
    (shown.length < delta.length
      ? `\n[TRUNCATED: continue with Read(file_path=${JSON.stringify(manifest.path)}, offset=${nextOffset})]`
      : "");
  return {
    ...result(call, content),
    evidenceSegments: workingSetEvidenceSegments(set, [[deltaStart, shownEnd]]),
  };
}

function codingRangeLines(
  text: string,
  starts: readonly number[],
  range: TextRange,
  header?: string,
  source?: CodingOutputLine["source"],
): CodingOutputLine[] {
  const rows: CodingOutputLine[] = header ? [{ rendered: header }] : [];
  let lineIndex = 0;
  while (lineIndex + 1 < starts.length && starts[lineIndex + 1] <= range.start) {
    lineIndex += 1;
  }
  for (let index = lineIndex; index < starts.length; index += 1) {
    const lineStart = starts[index];
    const nextStart = starts[index + 1] ?? text.length;
    if (lineStart >= range.end) break;
    const start = Math.max(lineStart, range.start);
    let end = Math.min(nextStart, range.end);
    while (end > start && (text[end - 1] === "\n" || text[end - 1] === "\r")) {
      end -= 1;
    }
    if (end <= start) continue;
    const full = text.slice(start, end);
    const shown = full.slice(0, Math.max(GREP_LINE_CAP, MAX_TOOL_RESULT_CHARS - 2_000));
    rows.push({
      rendered:
        `${String(index + 1).padStart(6, " ")}\t${start > lineStart ? "…" : ""}${shown}` +
        (shown.length < full.length || end < nextStart ? "…" : ""),
      span: [start, start + shown.length],
      ...(source ? { source } : {}),
    });
  }
  return rows;
}

async function compilerDiagnostics(
  userId: string,
  documentId: string,
  versionId: string,
) {
  const [structure, document] = await Promise.all([
    lintLocalDocxStructure(userId, documentId, versionId).catch(() => null),
    extractLocalDocument(userId, documentId).catch(() => null),
  ]);
  const drafting = document ? draftingLint(document.text) : null;
  const allFindings = [
    ...(structure?.findings ?? []).map((finding) => ({
      check: "structure",
      code: finding.code,
      severity: finding.severity,
      subject: finding.subject,
      excerpt: finding.excerpt,
      message: finding.message,
    })),
    ...(drafting?.findings ?? []).map((finding) => ({
      check: "drafting",
      code: finding.rule,
      severity: finding.severity,
      subject: finding.match,
      excerpt: finding.excerpt,
      message: finding.message,
    })),
  ];
  // Creation/revision receipts are an automatic compiler boundary, not an
  // advisory inbox. Only high-confidence errors enter model context; warnings
  // remain available through explicit audits and aggregate receipts.
  const findings = allFindings.filter(
    (finding) =>
      finding.severity === "error" &&
      ((finding.check === "drafting" && finding.code === "stacked-modals") ||
        (finding.check === "structure" && finding.code === "numbering_duplicate")),
  );
  const unavailable = !structure && !drafting;
  return {
    status: unavailable
      ? "unavailable"
      : findings.length
        ? "action_required"
        : "passed",
    finding_count: findings.length,
    ...(unavailable ? { unavailable: true } : {}),
    ...(findings.length ? { findings: findings.slice(0, 8) } : {}),
    ...(findings.length > 8 ? { truncated: true } : {}),
  };
}

/**
 * The revise operation, callable without dispatch: the Edit alias uses it
 * directly so the strict coding-shape surface can reject the public name
 * while the alias keeps the identical pinning, receipts, and lint hook.
 */
/**
 * Arm B's edit shape: `at` names the provision, and the context pair stops
 * being required because the server derives it.
 */
function addressedEditsSchema(base: unknown): unknown {
  const edits = JSON.parse(JSON.stringify(base)) as Record<string, any>;
  const item = edits.items;
  item.properties.at = {
    type: "string",
    description:
      "Provision or exact DOCX cell to edit inside ('8.01', 'Article VIII', 'table:1/row:2/col:3'). With `at`, give only `find` and `replace` — the server locates one exact occurrence inside that address and reads the surrounding text off the document, so never retype context.",
  };
  item.required = ["find", "replace"];
  return edits;
}

/** Convert a verified text plan to exact, paragraph-local tracked edits. */
function trackedEditsForRenumberPlan(
  sourceText: string,
  receipts: readonly DeleteAndRenumberReceipt[],
): EditInput[] | string {
  const edits: EditInput[] = [];
  const add = (
    start: number,
    end: number,
    replace: string,
    reason: string,
  ) => {
    const find = sourceText.slice(start, end);
    if (!find || find.includes("\n") || replace.includes("\n")) {
      return false;
    }
    edits.push({
      find,
      replace,
      context_before: "",
      context_after: "",
      reason,
      exact_start: start,
      exact_end: end,
    });
    return true;
  };

  for (const receipt of receipts) {
    if (sourceText.slice(receipt.start, receipt.end) !== receipt.removed) {
      return `Pinned text no longer matches ${receipt.kind} at ${receipt.start}-${receipt.end}`;
    }
    const reason =
      receipt.kind === "delete_provision"
        ? `Delete ${receipt.from} and close its numbering gap`
        : receipt.kind === "renumber_heading"
          ? `Renumber ${receipt.from} to ${receipt.to}`
          : `Update pointer from ${receipt.from} to ${receipt.to}`;
    if (receipt.kind !== "delete_provision") {
      if (!add(receipt.start, receipt.end, receipt.inserted, reason)) {
        return `${receipt.kind} crossed a paragraph boundary`;
      }
      continue;
    }

    let cursor = receipt.start;
    while (cursor < receipt.end) {
      const newline = sourceText.indexOf("\n", cursor);
      const end =
        newline < 0 || newline > receipt.end ? receipt.end : newline;
      if (end > cursor && !add(cursor, end, "", reason)) {
        return `Deletion of ${receipt.from} could not be split safely`;
      }
      cursor = end + 1;
    }
  }
  return edits.length ? edits : "Renumber plan contained no trackable text";
}

const comparableAcceptedText = (value: string) =>
  value
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .join("\n");

async function runLocalReviseDocx(
  call: NormalizedToolCall,
  userId: string,
  documentId: string,
  args: Record<string, unknown>,
  turnEditState?: LocalAssistantEditTurnState,
): Promise<NormalizedToolResult> {
  let versionId = trimmed(args.version_id);
  const rawEdits = Array.isArray(args.edits) ? args.edits : [];
  if (!documentId || !rawEdits.length) {
    return fail(call, "document_id and edits are required");
  }
  const turnVersion = turnEditState?.get(documentId);
  if (turnVersion) {
    if (
      versionId &&
      versionId !== turnVersion.versionId &&
      versionId !== turnVersion.parentVersionId
    ) {
      return fail(call, "version_id is not the active turn version");
    }
    versionId = turnVersion.versionId;
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
  const addressed = NAV_TOOL_SHAPE === "address";
  if (
    rawEdits.length > 100 ||
    rawEdits.some((raw) => {
      const edit = raw as Record<string, unknown>;
      // `at` replaces the context pair: the server derives the surrounding
      // bytes from the document, so the model never retypes them.
      if (addressed && trimmed(edit.at)) {
        return typeof edit.find !== "string" || typeof edit.replace !== "string";
      }
      return invalidReviseEdit(raw);
    })
  ) {
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
    /**
     * `at` names the provision; the server finds `find` INSIDE it and reads
     * the surrounding characters off the document itself.
     *
     * This exists because retyping is where edits actually fail. Measured on
     * the edit benchmark, every misquote was a context string the model
     * reconstructed with the wrong whitespace — joining two lines with a
     * space where the document has a newline, or inventing a blank line. The
     * model has never seen those bytes; the server has.
     */
    const docxStructure = addressed
      ? await extractDocxBodyStructure(await readFile(file.path))
      : null;
    const docText = docxStructure?.text ?? "";
    const skeleton = docText
      ? await documentStructure(docText, documentId, {
          tableCells: docxStructure?.tableCells,
        })
      : null;
    const CONTEXT = 40;
    const edits: EditInput[] = [];
    for (const raw of rawEdits) {
      const edit = raw as Record<string, unknown>;
      const at = addressed ? trimmed(edit.at) : "";
      if (at) {
        const address = parseAddress(at);
        if (address?.kind !== "section" || !skeleton || !docText) {
          return fail(
            call,
            `at=${JSON.stringify(at)} must name a provision or table cell`,
          );
        }
        const seek = readSection(skeleton, address.locator);
        if (seek.status !== "found" || !seek.block) {
          return fail(
            call,
            `Could not resolve at=${JSON.stringify(at)} (${seek.status})`,
          );
        }
        const find = edit.find as string;
        const span = docText.slice(seek.block.start, seek.block.end);
        const first = span.indexOf(find);
        const second = first < 0 ? -1 : span.indexOf(find, first + find.length);
        if (first < 0) {
          return fail(
            call,
            `find text does not occur inside at=${JSON.stringify(at)}`,
          );
        }
        if (second >= 0) {
          return fail(
            call,
            `find text occurs more than once inside at=${JSON.stringify(at)}; use a narrower address or a longer exact find`,
          );
        }
        const at0 = seek.block.start + first;
        if (find !== edit.replace) {
          edits.push({
            find,
            replace: edit.replace as string,
            context_before: docText.slice(Math.max(0, at0 - CONTEXT), at0),
            context_after: docText.slice(
              at0 + find.length,
              at0 + find.length + CONTEXT,
            ),
            reason: typeof edit.reason === "string" ? edit.reason : undefined,
          });
        }
        continue;
      }
      if (edit.find !== edit.replace) {
        edits.push({
          find: edit.find as string,
          replace: edit.replace as string,
          context_before: (edit.context_before as string) ?? "",
          context_after: (edit.context_after as string) ?? "",
          reason: typeof edit.reason === "string" ? edit.reason : undefined,
        });
      }
    }
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
    const committed = await commitLocalAssistantTurnVersion({
      userId,
      documentId,
      filename: file.version.filename,
      bytes: edited.bytes,
      sourceVersionId: versionId,
      trackedEdits,
      turnEditState,
    });
    if (!committed) return fail(call, "version_id is no longer active");
    const { version, parentVersionId } = committed;
    // Every revision gets deterministic same-turn feedback: the
    // structural lint runs on the freshly produced version (the
    // determinism plan's receipt hook — not gated on annotate).
    const lint = LEGAL_GREP_EXPERIMENT
      ? null
      : await lintLocalDocxStructure(
          userId,
          documentId,
          version.id,
        ).catch(() => null);
    const diagnostics = LEGAL_GREP_EXPERIMENT
      ? await compilerDiagnostics(userId, documentId, version.id)
      : null;
    const downloadUrl =
      `/single-documents/${encodeURIComponent(documentId)}/file` +
      `?version_id=${encodeURIComponent(version.id)}`;
    return result(call, {
      ok: true,
      receipt: "mike-document:v1",
      action: "revised",
      document_id: documentId,
      parent_version_id: parentVersionId,
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
      structural_lint: !diagnostics && lint
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
      ...(diagnostics ? { compiler_diagnostics: diagnostics } : {}),
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
  } catch (error) {
    return fail(call, errorText(error, "DOCX revision failed"));
  }
}

async function runCodingShapeCall(
  call: NormalizedToolCall,
  args: Record<string, unknown>,
  userId: string,
  allowedDocumentIds?: Set<string>,
  turnEditState?: LocalAssistantEditTurnState,
  workingSets?: LocalAssistantWorkingSetTurnState,
): Promise<NormalizedToolResult> {
  const collection = await listLocalLibrary(userId, "file");
  const storedById = new Map(
    collection.documents.map((document) => [document.id, document]),
  );
  const files =
    MIKE_FILE_TOOL_SHAPE && allowedDocumentIds
      ? [...allowedDocumentIds]
          .map((documentId) => storedById.get(documentId))
          .filter(
            (document): document is (typeof collection.documents)[number] =>
              !!document,
          )
      : collection.documents.filter(
          (document) =>
            !allowedDocumentIds || allowedDocumentIds.has(document.id),
        );
  const mikeLabelById = new Map(
    MIKE_FILE_TOOL_SHAPE
      ? files.map((document, index) => [document.id, `doc-${index}`] as const)
      : [],
  );
  const filenameCounts = new Map<string, number>();
  for (const document of files) {
    const key = document.filename.toLowerCase();
    filenameCounts.set(key, (filenameCounts.get(key) ?? 0) + 1);
  }
  const codingPath = (document: (typeof files)[number]) =>
    MIKE_FILE_TOOL_SHAPE &&
    (filenameCounts.get(document.filename.toLowerCase()) ?? 0) > 1
      ? mikeLabelById.get(document.id) ?? document.id
      : document.filename;
  const disambiguationHint = (requested: string, field: "file_path" | "path") =>
    MIKE_FILE_TOOL_SHAPE
      ? `File path is ambiguous: ${requested}. Use list_documents, then pass the intended doc-N label as ${field}.`
      : `File path is ambiguous: ${requested}. Use Glob(pattern="${requested}"), then pass the intended document_id as ${field}.`;
  const resolvePath = (raw: string) => {
    const wanted = raw.replace(/^\.?[\\/]/u, "").trim().toLowerCase();
    const mikeLabel = MIKE_FILE_TOOL_SHAPE
      ? files.find(
          (document) => mikeLabelById.get(document.id)?.toLowerCase() === wanted,
        )
      : undefined;
    if (mikeLabel) return [mikeLabel];
    const byId = files.filter((document) => document.id.toLowerCase() === wanted);
    if (byId.length) return byId;
    return files.filter(
      (document) => document.filename.toLowerCase() === wanted,
    );
  };
  const resolveWorkingSet = (raw: string) => {
    const wanted = raw.replace(/\\/gu, "/").trim().toLowerCase();
    return [...(workingSets?.values() ?? [])].find(
      (set) => set.path.toLowerCase() === wanted,
    );
  };
  const registerStructurePath = (
    meta: (typeof files)[number],
    document: NonNullable<Awaited<ReturnType<typeof extractLocalDocument>>>,
    unit: {
      start: number;
      end: number;
      locator: string;
      projection: "legal-unit" | "pdf-page";
    },
  ) => {
    if (
      !STRUCTURE_PATH_EXPERIMENT ||
      !workingSets ||
      unit.start < 0 ||
      unit.end <= unit.start ||
      unit.end > document.text.length
    ) {
      return null;
    }
    const versionId = document.versionId || meta.current_version_id;
    const identity = {
      documentId: meta.id,
      versionId,
      start: unit.start,
      end: unit.end,
      locator: unit.locator,
    };
    const path =
      `.mike/structure/doc-${sha256(meta.id).slice(0, 12)}` +
      `/v-${sha256(versionId).slice(0, 12)}` +
      `/u-${sha256(JSON.stringify(identity)).slice(0, 16)}.txt`;
    const text = document.text.slice(unit.start, unit.end);
    const existing = resolveWorkingSet(path);
    if (existing) {
      const segment = existing.segments[0];
      return existing.text === text &&
        existing.segments.length === 1 &&
        segment?.documentId === meta.id &&
        segment.versionId === versionId &&
        segment.sourceStart === unit.start &&
        segment.sourceEnd === unit.end &&
        segment.locator === unit.locator
        ? existing.path
        : null;
    }
    const segment: WorkingSetEvidenceSegment = {
      virtualStart: 0,
      virtualEnd: text.length,
      documentId: meta.id,
      versionId,
      sourceStart: unit.start,
      sourceEnd: unit.end,
      filename: meta.filename,
      locator: unit.locator,
      virtualPath: path,
      projection: unit.projection,
    };
    workingSets.set(path, {
      path,
      text,
      sourceChars: text.length,
      matchedSourceChars: text.length,
      mapChars: 0,
      budgetChars: text.length,
      mappedVersions: [`${meta.id}:${versionId}`],
      segments: [segment],
    });
    return path;
  };

  if (call.name === "DocumentMap" || call.name === "ReferenceImpact") {
    const requested = trimmed(args.file_path);
    const matches = resolvePath(requested);
    if (matches.length !== 1) {
      return fail(
        call,
        matches.length
          ? disambiguationHint(requested, "file_path")
          : `File does not exist: ${requested}`,
      );
    }
    const meta = matches[0];
    const document = await extractLocalDocument(userId, meta.id);
    if (!document) return fail(call, `File could not be read: ${requested}`);
    const skeleton = await documentStructure(document.text, meta.id, {
      tableCells: document.tableCells,
    });
    if (call.name === "DocumentMap") {
      const mapped = documentMap({
        text: document.text,
        skeleton,
        pageMap: document.pages,
        focus: trimmed(args.focus) as DocumentMapFocus,
        ...(typeof args.query === "string" ? { query: args.query } : {}),
        ...(typeof args.max_results === "number"
          ? { maxResults: args.max_results }
          : {}),
      });
      return result(call, {
        ok: mapped.failures.length === 0,
        ...mapped,
      });
    }
    const graph = await documentGraph(
      document.text,
      meta.id,
      skeleton,
      { tableCells: document.tableCells },
    );
    const impact = referenceImpact({
      text: document.text,
      skeleton,
      graph,
      targets: stringArray(args.targets),
      operation: trimmed(args.operation) as ReferenceImpactOperation,
    });
    return result(call, {
      ok: impact.failures.length === 0,
      ...impact,
    });
  }

  if (call.name === "Glob") {
    const re = globRegExp(trimmed(args.pattern) || "*");
    const matchedFiles = files.filter((document) => re.test(document.filename));
    const fileRows = await Promise.all(
      matchedFiles.map(async (meta) => {
        const document = await extractLocalDocument(userId, meta.id);
        const identity =
          (filenameCounts.get(meta.filename.toLowerCase()) ?? 0) > 1
            ? `${meta.filename}\t[document_id=${mikeLabelById.get(meta.id) ?? meta.id}]`
            : meta.filename;
        if (!document) {
          return { row: `${identity}\tunreadable`, chars: 0, lines: 0 };
        }
        const chars = document.text.length;
        const lines = document.text ? document.text.split(/\r?\n/u).length : 0;
        return {
          row: `${identity}\tchars=${chars}\tlines=${lines}`,
          chars,
          lines,
        };
      }),
    );
    const workingSetRows = [...(workingSets?.values() ?? [])]
      .filter((set) => re.test(set.path))
      .map((set) => ({
        row: `${set.path}\tchars=${set.text.length}\tlines=${
          set.text ? set.text.split(/\r?\n/u).length : 0
        }`,
        chars: set.text.length,
        lines: set.text ? set.text.split(/\r?\n/u).length : 0,
      }));
    const rows = [...fileRows, ...workingSetRows];
    if (!rows.length) return result(call, "No files found");
    const totalChars = rows.reduce((total, row) => total + row.chars, 0);
    const totalLines = rows.reduce((total, row) => total + row.lines, 0);
    return result(
      call,
      [
        ...rows.map((row) => row.row),
        `TOTAL\tfiles=${rows.length}\tchars=${totalChars}\tlines=${totalLines}` +
          (WHOLE_READ_MAX_CHARS
            ? `\twhole_read_budget_chars=${WHOLE_READ_MAX_CHARS}`
            : ""),
      ].join("\n"),
    );
  }

  if (call.name === "Read") {
    if (
      (PURE_CODING_EXPERIMENT || STRUCTURE_PATH_EXPERIMENT) &&
      Object.prototype.hasOwnProperty.call(args, "section")
    ) {
      return fail(
        call,
        "Read accepts only file_path, offset, limit, and start_char",
      );
    }
    if (
      !LEGAL_GREP_EXPERIMENT &&
      (Object.prototype.hasOwnProperty.call(args, "pages") ||
        Object.prototype.hasOwnProperty.call(args, "references"))
    ) {
      return fail(call, "Read does not expose page or reference scopes in this arm");
    }
    const requested = trimmed(args.file_path);
    const workingSet = resolveWorkingSet(requested);
    if (workingSet) {
      if (
        trimmed(args.section) ||
        trimmed(args.pages) ||
        (args.references && args.references !== "none")
      ) {
        return result(
          call,
          "Working sets accept only file_path, offset, limit, and start_char.",
        );
      }
      const lines = workingSet.text.split(/\r?\n/u);
      const starts = sourceLineStarts(workingSet.text, lines);
      const offset = positiveInt(args.offset, 1, 100_000_000, 1);
      const limit = positiveInt(args.limit, 1, 2_000, 2_000);
      const firstLine = lines[offset - 1];
      const startChar = clampInt(
        args.start_char,
        0,
        Number.MAX_SAFE_INTEGER,
        0,
      );
      if (firstLine === undefined) {
        return result(
          call,
          offset > lines.length
            ? `(offset ${offset} is past the end of the working set; total lines: ${lines.length})`
            : "(empty working set)",
        );
      }
      if (startChar > firstLine.length) {
        return result(
          call,
          `(start_char ${startChar} is past the end of working-set line ${offset}; line chars: ${firstLine.length})`,
        );
      }
      if (
        workingSet.demandPaged &&
        !workingSet.readGrants?.has(`${offset}:${startChar}`)
      ) {
        return result(call, {
          ok: true,
          status: "selection_required",
          error:
            "Demand-paged evidence does not support sequential scans. Use Grep with output_mode=content, then copy an exact Read recipe from its hit.",
        });
      }
      const pageMaxChars = WORKING_SET_PAGE_MAX_CHARS || MAX_TOOL_RESULT_CHARS;
      const bodyBudget = Math.max(
        1_000,
        Math.min(MAX_TOOL_RESULT_CHARS, pageMaxChars) - 1_000,
      );
      const candidates: CodingOutputLine[] = [];
      let used = 0;
      let sameLineContinuation:
        | { line: number; nextChar: number; totalChars: number }
        | undefined;
      for (
        let index = 0;
        index < limit && offset - 1 + index < lines.length;
        index += 1
      ) {
        const lineIndex = offset - 1 + index;
        const line = lines[lineIndex];
        const localStart = index === 0 ? startChar : 0;
        const prefix = `${String(lineIndex + 1).padStart(6, " ")}\t`;
        const available =
          bodyBudget - used - prefix.length - (candidates.length ? 1 : 0);
        if (available <= 0) break;
        const shown = line.slice(localStart, localStart + available);
        candidates.push({
          rendered: `${prefix}${shown}`,
          span: [
            starts[lineIndex] + localStart,
            starts[lineIndex] + localStart + shown.length,
          ],
        });
        used += prefix.length + shown.length + (candidates.length > 1 ? 1 : 0);
        if (localStart + shown.length < line.length) {
          sameLineContinuation = {
            line: lineIndex + 1,
            nextChar: localStart + shown.length,
            totalChars: line.length,
          };
          break;
        }
      }
      const rendered = candidates.map((line) => line.rendered).join("\n");
      const lastShown = offset - 1 + candidates.length;
      const continuation = sameLineContinuation
        ? `[TRUNCATED: returned working-set line ${sameLineContinuation.line} through char ${sameLineContinuation.nextChar} of ${sameLineContinuation.totalChars}; continue with Read(file_path=${JSON.stringify(workingSet.path)}, offset=${sameLineContinuation.line}, limit=${limit}, start_char=${sameLineContinuation.nextChar}). Tool-result limit reached.]`
        : lastShown < lines.length
          ? workingSet.demandPaged
            ? `[PAGE ENDED: returned lines ${offset}-${lastShown} of ${lines.length}. Use Grep to locate the next material fact; sequential continuation is disabled.]`
            : `[TRUNCATED: returned lines ${offset}-${lastShown} of ${lines.length}; continue with Read(file_path=${JSON.stringify(workingSet.path)}, offset=${lastShown + 1}).]`
          : "";
      if (sameLineContinuation && workingSet.demandPaged) {
        workingSet.readGrants?.add(
          `${sameLineContinuation.line}:${sameLineContinuation.nextChar}`,
        );
      }
      const content = continuation
        ? `${rendered}\n\n${continuation}`
        : rendered;
      const exposedRanges = candidates.flatMap((line) =>
        line.span ? [line.span] : [],
      );
      return {
        ...result(call, content),
        evidenceSegments: workingSetEvidenceSegments(workingSet, exposedRanges),
        evidenceRefs: workingSetEvidenceRefs(workingSet, exposedRanges),
      };
    }
    if (
      requested.replace(/\\/gu, "/").toLowerCase().startsWith(
        ".mike/structure/",
      )
    ) {
      return result(call, {
        ok: false,
        status: "not_found",
        error:
          "Structure path not found in this turn. Copy an exact .mike/structure/... path returned by Grep; never invent or alter one.",
      });
    }
    const matches = resolvePath(requested);
    if (matches.length !== 1) {
      return fail(
        call,
        matches.length
          ? disambiguationHint(requested, "file_path")
          : `File does not exist: ${requested}\nAvailable files:\n${files.map((document) => document.filename).join("\n")}`,
      );
    }
    const meta = matches[0];
    const document = await extractLocalDocument(userId, meta.id);
    if (!document) return fail(call, `File could not be read: ${requested}`);
    const lines = document.text.split(/\r?\n/u);
    const starts = sourceLineStarts(document.text, lines);
    const limit = positiveInt(args.limit, 1, 2_000, 2_000);
    const startChar = clampInt(
      args.start_char,
      0,
      Number.MAX_SAFE_INTEGER,
      0,
    );
    // Legal paragraphs are often several thousand characters on one source
    // line. Keep each Read line intact whenever it fits in the result budget;
    // Grep stays a compact, match-centred preview.
    const readLineCap = Math.max(
      GREP_LINE_CAP,
      MAX_TOOL_RESULT_CHARS - 2_000,
    );
    const sectionArg = trimmed(args.section);
    const pagesArg = trimmed(args.pages);
    const references =
      args.references === "inbound" ||
      args.references === "outbound" ||
      args.references === "both"
        ? args.references
        : "none";
    if (pagesArg) {
      const nonDefaultOffset =
        Object.prototype.hasOwnProperty.call(args, "offset") &&
        typeof args.offset === "number" &&
        args.offset > 1;
      if (sectionArg || nonDefaultOffset) {
        return fail(
          call,
          "pages cannot be combined with section or offset; choose one exact scope.",
        );
      }
      const selected = selectPages(document.pages, document.text, pagesArg);
      if (selected.status !== "ok") {
        return fail(
          call,
          selected.status === "empty"
            ? "pages is required"
            : `Page '${selected.token}' could not be resolved (${selected.lookup.status}).`,
        );
      }
      const candidates = selected.pages.flatMap((page) =>
        codingRangeLines(
          document.text,
          starts,
          { start: page.start, end: page.end },
          `=== ${meta.filename} :: pdf:${page.pdfPage ?? "?"}${
            page.printedLabel ? ` :: printed:${page.printedLabel}` : ""
          } ===`,
          {
            documentId: meta.id,
            versionId: meta.current_version_id,
            locator: pageLabel(page),
            projection: "canonical",
          },
        ),
      );
      const { kept, truncated } = takeCodingOutputLines(candidates);
      return codingTextResult(
        call,
        kept.map((line) => line.rendered).join("\n") +
          (truncated ? "\n(Page read stopped at the tool-result limit.)" : ""),
        kept,
      );
    }
    if (references !== "none" && !sectionArg) {
      return fail(call, "references requires an exact section handle.");
    }
    if (sectionArg) {
      const skeleton = await documentStructure(document.text, meta.id, {
        tableCells: document.tableCells,
      });
      const lookup = readSection(skeleton, sectionArg);
      if (lookup.status !== "found" || !lookup.block) {
        return fail(
          call,
          `Section '${sectionArg}' not found (${lookup.status}` +
            (lookup.matches.length
              ? `; candidates: ${lookup.matches.join(", ")}`
              : "") +
            "). Grep for the wording, or Read without section.",
        );
      }
      const block = lookup.block;
      if (references !== "none") {
        const graph = await documentGraph(
          document.text,
          meta.id,
          skeleton,
          { tableCells: document.tableCells },
        );
        const scope = oneHopLegalScope(
          skeleton,
          graph,
          block.label,
          references,
        );
        if (!scope) {
          return fail(call, `Section '${sectionArg}' could not seed a reference scope.`);
        }
        const covered: TextRange[] = [];
        const candidates: CodingOutputLine[] = [];
        for (const [index, node] of scope.nodes.entries()) {
          const open = uncoveredRanges(
            { start: node.start, end: node.end },
            covered,
          );
          for (const range of open) {
            candidates.push(
              ...codingRangeLines(
                document.text,
                starts,
                range,
                `=== ${meta.filename} :: Read section="${node.label}" :: ${
                  index === 0 ? "target" : "direct reference"
                } ===`,
                {
                  documentId: meta.id,
                  versionId: meta.current_version_id,
                  locator: node.label,
                  projection: "canonical",
                },
              ),
            );
          }
          addCoveredRange(covered, { start: node.start, end: node.end });
        }
        const { kept, truncated } = takeCodingOutputLines(candidates);
        const note = graph.documentAbstained
          ? `\n(Reference graph abstained: ${graph.note ?? "unresolved document structure"}.)`
          : truncated
            ? "\n(Reference read stopped at the tool-result limit; narrow the direction or read a returned section recipe.)"
            : "";
        return codingTextResult(
          call,
          kept.map((line) => line.rendered).join("\n") + note,
          kept,
        );
      }
      const startLine =
        document.text.slice(0, block.start).split(/\r?\n/u).length;
      const blockLines = block.text.split(/\r?\n/u);
      const endLine = startLine + blockLines.length - 1;
      const offset = positiveInt(
        args.offset,
        1,
        100_000_000,
        startLine,
      );
      // Some tool-call providers populate every optional numeric field with its
      // minimum. Preserve absolute line semantics for real windows, while
      // treating that synthetic `1` like an omitted section offset.
      const sectionOffset = offset === 1 && startLine > 1 ? startLine : offset;
      // The same providers also materialize both optional numeric fields at
      // their schema minima. In section mode `{ offset: 1, limit: 1 }` is the
      // provider rendering of a section-only recipe, not a request to return
      // only its heading line. A deliberate one-line section read can use the
      // section's absolute line number instead.
      const sectionLimit =
        Number(args.offset) === 1 && Number(args.limit) === 1 ? 2_000 : limit;
      if (sectionOffset < startLine || sectionOffset > endLine) {
        return fail(
          call,
          `(offset ${sectionOffset} is outside section ${block.label}; the section spans lines ${startLine}-${endLine})`,
        );
      }
      const localStart = sectionOffset - startLine;
      const blockStarts = sourceLineStarts(block.text, blockLines);
      const candidates = blockLines
        .slice(localStart, localStart + sectionLimit)
        .map((line, i): CodingOutputLine => {
          const blockIndex = localStart + i;
          const sourceStart = block.start + blockStarts[blockIndex];
          const shown = line.slice(0, readLineCap);
          return {
            rendered:
              `${String(sectionOffset + i).padStart(6, " ")}\t${shown}` +
              (line.length > readLineCap
                ? "… [line truncated; Grep can locate text later on this line]"
                : ""),
            span: [sourceStart, sourceStart + shown.length],
            source: {
              documentId: meta.id,
              versionId: meta.current_version_id,
              locator: block.label,
              projection: "canonical",
            },
          };
        });
      const { kept, truncated } = takeCodingOutputLines(candidates);
      const lastShown = sectionOffset + kept.length - 1;
      const more =
        lastShown < endLine
          ? `\n\n[TRUNCATED: returned section lines ${sectionOffset}-${lastShown} of ${startLine}-${endLine}; continue with Read(file_path="${requested}", section="${block.label}", offset=${lastShown + 1}).${truncated ? " Tool-result limit reached." : ""}]`
          : "";
      return codingTextResult(
        call,
        kept.map((line) => line.rendered).join("\n") + more,
        kept,
      );
    }
    const offset = positiveInt(args.offset, 1, 100_000_000, 1);
    const firstLine = lines[offset - 1];
    if (firstLine !== undefined && startChar > firstLine.length) {
      return fail(
        call,
        `(start_char ${startChar} is past the end of line ${offset}; line chars: ${firstLine.length})`,
      );
    }
    const selectedLines = lines.slice(offset - 1, offset - 1 + limit);
    const firstLineContinues =
      selectedLines.length > 0 &&
      startChar + readLineCap < selectedLines[0].length;
    const candidates = (firstLineContinues
      ? selectedLines.slice(0, 1)
      : selectedLines
    )
      .map((line, i): CodingOutputLine => {
        const lineIndex = offset - 1 + i;
        const sourceStart = starts[lineIndex];
        const localStart = i === 0 ? startChar : 0;
        const shown = line.slice(localStart, localStart + readLineCap);
        return {
          rendered:
            `${String(offset + i).padStart(6, " ")}\t${shown}` +
            (localStart + shown.length < line.length
              ? "… [line truncated; continue with the exact Read recipe below]"
              : ""),
          span: [
            sourceStart + localStart,
            sourceStart + localStart + shown.length,
          ],
          source: {
            documentId: meta.id,
            versionId: meta.current_version_id,
          },
        };
      });
    if (!candidates.length) {
      return fail(
        call,
        offset > lines.length
          ? `(offset ${offset} is past the end of the file; total lines: ${lines.length})`
          : "(empty file)",
      );
    }
    const { kept, truncated } = takeCodingOutputLines(candidates);
    const lastShown = offset - 1 + kept.length;
    const sameLineContinuation =
      firstLineContinues && kept.length > 0
        ? startChar + readLineCap
        : null;
    const more = sameLineContinuation !== null
      ? `\n\n[TRUNCATED: returned line ${offset} through char ${sameLineContinuation} of ${selectedLines[0].length}; continue with Read(file_path=${JSON.stringify(requested)}, offset=${offset}, limit=${limit}, start_char=${sameLineContinuation}). Tool-result limit reached.]`
      : lastShown < lines.length
        ? `\n\n[TRUNCATED: returned lines ${offset}-${lastShown} of ${lines.length}; continue with Read(file_path="${requested}", offset=${lastShown + 1}).${truncated ? " Tool-result limit reached." : ""}]`
        : "";
    return codingTextResult(
      call,
      kept.map((line) => line.rendered).join("\n") + more,
      kept,
    );
  }

  if (call.name === "Edit") {
    const requested = trimmed(args.file_path);
    if (resolveWorkingSet(requested)) {
      return result(
        call,
        "The evidence file is append-only. Edit the original file using the Read recipe in the source boundary.",
      );
    }
    const matches = resolvePath(requested);
    if (matches.length !== 1) {
      return result(
        call,
        matches.length
          ? disambiguationHint(requested, "file_path")
          : `File does not exist: ${requested}`,
      );
    }
    const meta = matches[0];
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
                  match_case: true,
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
        undefined,
        undefined,
        undefined,
        turnEditState,
      );
      const receiptText = applied.mutationReceipt ?? applied.content;
      try {
        const payload = JSON.parse(receiptText) as {
          ok?: boolean;
          action?: string;
          error?: string;
          change_count?: number;
          ops?: Array<{ replacements?: number }>;
        };
        if (payload.ok && payload.action === "no_changes") {
          return result(
            call,
            `No exact matches for old_string were found in ${meta.filename}; no change was made.`,
          );
        }
        if (payload.ok) {
          const count =
            payload.ops?.[0]?.replacements ?? payload.change_count ?? 0;
          return {
            ...result(
              call,
              `Updated ${meta.filename}: ${count} replacement(s) applied as tracked changes.`,
            ),
            mutationReceipt: receiptText,
          };
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
    } = {
      find: oldString,
      replace: newString,
      context_before: "",
      context_after: "",
    };
    if (sectionArg) {
      const document = await extractLocalDocument(userId, meta.id);
      if (!document) {
        return result(call, `File could not be read: ${requested}`);
      }
      const skeleton = await documentStructure(document.text, meta.id, {
        tableCells: document.tableCells,
      });
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
      turnEditState,
    );
    const receiptText = revised.mutationReceipt ?? revised.content;
    try {
      const payload = JSON.parse(receiptText) as {
        ok?: boolean;
        error?: string;
        edit_errors?: string[];
      };
      if (payload.ok) {
        return {
          ...result(
            call,
            `Updated ${meta.filename}: 1 tracked change applied.`,
          ),
          mutationReceipt: receiptText,
        };
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
  if (
    !LEGAL_GREP_EXPERIMENT &&
    (Object.prototype.hasOwnProperty.call(args, "section") ||
      Object.prototype.hasOwnProperty.call(args, "pages") ||
      Object.prototype.hasOwnProperty.call(args, "references"))
  ) {
    return fail(call, "Grep does not expose legal scopes in this arm");
  }
  const requestedPattern = trimmed(args.pattern);
  if (!requestedPattern) return fail(call, "pattern is required");
  const inlineCaseInsensitive = requestedPattern.startsWith("(?i)");
  const pattern = inlineCaseInsensitive
    ? requestedPattern.slice("(?i)".length)
    : requestedPattern;
  let re: RegExp;
  try {
    re = new RegExp(
      pattern,
      inlineCaseInsensitive || args["-i"] === true ? "iu" : "u",
    );
  } catch (error) {
    return fail(
      call,
      `regex parse error: ${errorText(error, "invalid pattern")}`,
    );
  }
  const pathArg = trimmed(args.path);
  const virtualTarget = pathArg ? resolveWorkingSet(pathArg) : undefined;
  if (virtualTarget) {
    if (
      trimmed(args.section) ||
      trimmed(args.pages) ||
      (args.references && args.references !== "none")
    ) {
      return fail(call, "Working-set Grep does not accept legal scopes.");
    }
    if (args.output_mode === "working_set") {
      return fail(call, "This path is already a materialized working set.");
    }
    const lines = virtualTarget.text.split(/\r?\n/u);
    const starts = sourceLineStarts(virtualTarget.text, lines);
    const matched = lines.flatMap((line, index) => {
      const column = line.search(re);
      return column >= 0 ? [{ line: index, column }] : [];
    });
    if (!matched.length) return result(call, "No matches found");
    if (args.output_mode === "count") {
      return result(call, `${virtualTarget.path}:${matched.length}`);
    }
    if (args.output_mode !== "content") return result(call, virtualTarget.path);
    const headLimit = virtualTarget.demandPaged
      ? Math.min(
          WORKING_SET_GREP_MAX_HEAD_LIMIT,
          positiveInt(
            args.head_limit,
            1,
            2_000,
            WORKING_SET_GREP_DEFAULT_HEAD_LIMIT,
          ),
        )
      : positiveInt(args.head_limit, 1, 2_000, 250);
    const lineCap = virtualTarget.demandPaged
      ? WORKING_SET_GREP_LINE_MAX_CHARS
      : GREP_LINE_CAP;
    const context = clampInt(args["-C"], 0, 10, 0);
    const rows: CodingOutputLine[] = [];
    const emitted = new Set<number>();
    for (const match of matched) {
      const at = match.line;
      for (
        let index = Math.max(0, at - context);
        index <= Math.min(lines.length - 1, at + context) && rows.length < headLimit;
        index += 1
      ) {
        if (emitted.has(index)) continue;
        emitted.add(index);
        const isMatch = index === at;
        const separator = isMatch ? ":" : "-";
        const sliceStart =
          isMatch && lines[index].length > lineCap
            ? Math.min(
                Math.max(0, match.column - Math.floor(lineCap / 2)),
                lines[index].length - lineCap,
              )
            : 0;
        const shown = lines[index].slice(
          sliceStart,
          sliceStart + lineCap,
        );
        const readGrant = isMatch
          ? { line: index + 1, startChar: sliceStart }
          : undefined;
        const recipe = readGrant
          ? `\n  [exact Read recipe: Read(file_path=${JSON.stringify(virtualTarget.path)}, offset=${readGrant.line}, limit=1${readGrant.startChar ? `, start_char=${readGrant.startChar}` : ""})]`
          : "";
        rows.push({
          rendered: `${virtualTarget.path}${separator}${index + 1}${separator}${shown}${recipe}`,
          span: [
            starts[index] + sliceStart,
            starts[index] + sliceStart + shown.length,
          ],
          ...(readGrant ? { readGrant } : {}),
        });
      }
    }
    const { kept, truncated } = takeCodingOutputLines(
      rows,
      WORKING_SET_PAGE_MAX_CHARS || MAX_TOOL_RESULT_CHARS,
    );
    if (virtualTarget.demandPaged) {
      virtualTarget.readGrants ??= new Set();
      for (const line of kept) {
        if (line.readGrant) {
          virtualTarget.readGrants.add(
            `${line.readGrant.line}:${line.readGrant.startChar}`,
          );
        }
      }
    }
    const body = kept.map((line) => line.rendered).join("\n");
    const content =
      truncated || rows.length >= headLimit
        ? `${body}\n(Results truncated; narrow the pattern.)`
        : body;
    const exposedRanges = kept.flatMap((line) =>
      line.span ? [line.span] : [],
    );
    return {
      ...result(call, content),
      evidenceSegments: workingSetEvidenceSegments(
        virtualTarget,
        exposedRanges,
      ),
      evidenceRefs: workingSetEvidenceRefs(virtualTarget, exposedRanges),
    };
  }
  if (
    pathArg.replace(/\\/gu, "/").toLowerCase().startsWith(
      ".mike/structure/",
    )
  ) {
    return result(call, {
      ok: false,
      status: "not_found",
      error:
        "Structure path not found in this turn. Copy an exact .mike/structure/... path returned by Grep; never invent or alter one.",
    });
  }
  let targets = files;
  if (pathArg) {
    const matches = resolvePath(pathArg);
    if (matches.length !== 1) {
      return fail(
        call,
        matches.length
          ? disambiguationHint(pathArg, "path")
          : `File does not exist: ${pathArg}`,
      );
    }
    targets = [matches[0]];
  } else if (trimmed(args.glob)) {
    const globRe = globRegExp(trimmed(args.glob));
    targets = files.filter((document) => globRe.test(document.filename));
  }
  const grepSection = trimmed(args.section);
  const grepPages = trimmed(args.pages);
  const grepReferences =
    args.references === "inbound" ||
    args.references === "outbound" ||
    args.references === "both"
      ? args.references
      : "none";
  if ((grepSection || grepPages || grepReferences !== "none") && !pathArg) {
    return fail(call, "Legal Grep scopes require one exact path.");
  }
  if (grepSection && grepPages) {
    return fail(call, "section and pages are alternative exact scopes; choose one.");
  }
  if (grepReferences !== "none" && !grepSection) {
    return fail(call, "references requires an exact section handle.");
  }
  const mode =
    args.output_mode === "content" ||
    args.output_mode === "count" ||
    (LEGAL_GREP_EXPERIMENT && args.output_mode === "sections") ||
    (WORKING_SET_EXPERIMENT && args.output_mode === "working_set")
      ? args.output_mode
      : LEAN_BATCH_FAMILY_TOOL_SHAPE
        ? "content"
        : "files_with_matches";
  const headLimit = positiveInt(
    args.head_limit,
    1,
    2_000,
    mode === "sections" ? 40 : 250,
  );
  const context = clampInt(args["-C"], 0, 10, 0);
  const numberLines = args["-n"] !== false;

  const rows: CodingOutputLine[] = [];
  const sectionQueues: { rendered: string; hits: number }[][] = [];
  const workingSetCandidates: WorkingSetCandidate[] = [];
  const workingSetMaps: WorkingSetMapCandidate[] = [];
  const hardReferenceHints: Array<{
    kind: "literal_reference";
    label: string;
    path: string;
    offset: number;
    limit: number;
    rendered: string;
  }> = [];
  const hardReferenceSeeds = new Set<string>();
  let truncated = false;
  for (const meta of targets) {
    const document = await extractLocalDocument(userId, meta.id);
    if (!document) continue;
    const lines = document.text.split(/\r?\n/u);
    const starts = sourceLineStarts(document.text, lines);
    let scopeSpans: TextRange[] | null = null;
    let scopedSkeleton: AgreementSkeleton | null = null;
    let mapSkeleton: AgreementSkeleton | null = null;
    if (grepSection) {
      scopedSkeleton =
        mapSkeleton ??
        (await documentStructure(document.text, meta.id, {
          tableCells: document.tableCells,
        }));
      const lookup = readSection(scopedSkeleton, grepSection);
      if (lookup.status !== "found" || !lookup.block) {
        return fail(
          call,
          `Section '${grepSection}' not found (${lookup.status}` +
            (lookup.matches.length
              ? `; candidates: ${lookup.matches.join(", ")}`
              : "") +
            ").",
        );
      }
      if (grepReferences === "none") {
        scopeSpans = [{ start: lookup.block.start, end: lookup.block.end }];
      } else {
        const graph = await documentGraph(
          document.text,
          meta.id,
          scopedSkeleton,
          { tableCells: document.tableCells },
        );
        const scope = oneHopLegalScope(
          scopedSkeleton,
          graph,
          lookup.block.label,
          grepReferences,
        );
        scopeSpans =
          scope?.nodes.map((node) => ({ start: node.start, end: node.end })) ?? [];
      }
    } else if (grepPages) {
      const selected = selectPages(document.pages, document.text, grepPages);
      if (selected.status !== "ok") {
        return fail(
          call,
          selected.status === "empty"
            ? "pages is required"
            : `Page '${selected.token}' could not be resolved (${selected.lookup.status}).`,
        );
      }
      scopeSpans = selected.pages.map((page) => ({
        start: page.start,
        end: page.end,
      }));
    }
    const matched: number[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const lineStart = starts[i];
      const lineEnd = starts[i + 1] ?? document.text.length;
      if (
        (!scopeSpans ||
          scopeSpans.some(
            (scope) => lineStart < scope.end && scope.start < lineEnd,
          )) &&
        re.test(lines[i])
      ) {
        matched.push(i);
      }
    }
    if (!matched.length) continue;
    if (mode === "working_set" && ACCRETIVE_WORKING_SET_EXPERIMENT) {
      mapSkeleton ??= await documentStructure(document.text, meta.id, {
        tableCells: document.tableCells,
      });
      workingSetMaps.push({
        documentId: meta.id,
        versionId: meta.current_version_id,
        filename: meta.filename,
        rows: workingSetMapRows(
          mapSkeleton,
          document.tableCells,
          document.text,
        ),
      });
    }
    // A handle is emitted only when the paired Read resolver accepts it.
    // Ambiguous TOC/body duplicates stay line-addressed instead of teaching
    // the model an attractive handle that must fail on the next turn.
    let sectionOf:
        | ((line: number, at?: number) => {
          handle: string;
          display: string;
          firstLine: number;
          lastLine: number;
          start: number;
          end: number;
        } | null)
      | null = null;
    let unitSkeleton: AgreementSkeleton | null = null;
    if (
      (mode === "content" || mode === "sections" || mode === "working_set") &&
      (!PURE_CODING_EXPERIMENT || LEAN_BATCH_HARDREFS_TOOL_SHAPE)
    ) {
      const skeleton =
        scopedSkeleton ??
        mapSkeleton ??
        (await documentStructure(document.text, meta.id, {
          tableCells: document.tableCells,
        }));
      unitSkeleton = skeleton;
      if (skeleton.nodes.length) {
        const offsets: number[] = [];
        let cursor = 0;
        for (const line of lines) {
          offsets.push(cursor);
          const next = document.text.indexOf("\n", cursor + line.length);
          cursor = next === -1 ? document.text.length : next + 1;
        }
        sectionOf = (line, at) => {
          const pos = at ?? offsets[line] ?? 0;
          let best: { label: string; span: number } | null = null;
          for (const node of skeleton.nodes) {
            if (pos >= node.start && pos < node.end) {
              const span = node.end - node.start;
              if (!best || span < best.span) best = { label: node.label, span };
            }
          }
          if (!best) return null;
          // A native cell's row is the useful retrieval unit for a hit:
          // models otherwise infer this parent themselves, which was the
          // only repeatable DOCX failure in the fair coding baseline.
          const row = /^(table:\d+\/row:\d+)\/col:\d+$/u.exec(best.label)?.[1];
          const preferred =
            row && readSection(skeleton, row).status === "found"
              ? row
              : best.label;
          const lookup = readSection(skeleton, preferred);
          if (lookup.status !== "found" || !lookup.block) return null;
          const preferredNode = skeleton.nodes.find(
            (node) => node.label === preferred,
          );
          const rowAddress = /^table:(\d+)\/row:(\d+)$/u.exec(preferred);
          const addresses = rowAddress
            ? document.tableCells
                .filter(
                  (cell) =>
                    cell.table === Number(rowAddress[1]) &&
                    cell.row === Number(rowAddress[2]) &&
                    cell.address,
                )
                .map((cell) => cell.address)
            : [];
          const display =
            (preferredNode?.display ?? preferred) +
            (addresses.length ? `; cells ${addresses.join(", ")}` : "");
          const firstLine =
            document.text.slice(0, lookup.block.start).split(/\r?\n/u).length;
          const lastLine =
            firstLine + lookup.block.text.split(/\r?\n/u).length - 1;
          return {
            handle: lookup.block.label,
            display,
            firstLine,
            lastLine,
            start: lookup.block.start,
            end: lookup.block.end,
          };
        };
      }
    }
    if (mode === "working_set") {
      for (const line of matched) {
        const section = sectionOf?.(line);
        const lookup =
          section && unitSkeleton
            ? readSection(unitSkeleton, section.handle)
            : null;
        const lineStart = starts[line];
        const lineEnd = starts[line + 1] ?? document.text.length;
        const range =
          lookup?.status === "found" && lookup.block
            ? { start: lookup.block.start, end: lookup.block.end }
            : {
                start: Math.max(0, lineStart - 1_500),
                end: Math.min(document.text.length, lineEnd + 1_500),
              };
        workingSetCandidates.push({
          ...range,
          documentId: meta.id,
          versionId: meta.current_version_id,
          filename: meta.filename,
          filePath:
            files.filter((candidate) => candidate.filename === meta.filename)
              .length === 1
              ? meta.filename
              : meta.id,
          sourceText: document.text,
          projection: lookup?.status === "found" ? "legal-unit" : "window",
          ...(lookup?.status === "found" && lookup.block
            ? { handle: lookup.block.label, contextLabel: section?.display }
            : {}),
          anchor: lineStart,
          hits: 1,
        });
      }
      continue;
    }
    if (mode === "files_with_matches") {
      rows.push({ rendered: codingPath(meta) });
      continue;
    }
    if (mode === "count") {
      rows.push({ rendered: `${codingPath(meta)}:${matched.length}` });
      continue;
    }
    if (mode === "sections") {
      const hitsByRecipe = new Map<string, number>();
      for (const line of matched) {
        const section = sectionOf?.(line);
        const filePath = codingPath(meta);
        const recipe = MIKE_GREP_FAMILY_TOOL_SHAPE
          ? section
            ? `Read file_path=${JSON.stringify(filePath)} section="${section.handle}"`
            : `Read file_path=${JSON.stringify(filePath)} offset=${line + 1} limit=1`
          : section
            ? `Read section="${section.handle}"`
            : `Read offset=${line + 1} limit=1`;
        const rendered = `${filePath}: ${recipe}`;
        hitsByRecipe.set(rendered, (hitsByRecipe.get(rendered) ?? 0) + 1);
      }
      sectionQueues.push(
        [...hitsByRecipe.entries()]
          .map(([rendered, hits]) => ({ rendered, hits }))
          .sort(
            (left, right) =>
              right.hits - left.hits ||
              left.rendered.localeCompare(right.rendered),
          ),
      );
      continue;
    }
    const matchedLines = new Set(matched);
    let hardReferenceGraph: CrossReferenceGraph | null = null;
    let lastPrinted = -2;
    for (const at of matched) {
      if (rows.length >= headLimit) {
        truncated = true;
        break;
      }
      const from = Math.max(0, at - context);
      const to = Math.min(lines.length - 1, at + context);
      if (context && lastPrinted >= 0 && from > lastPrinted + 1) {
        rows.push({ rendered: "--" });
      }
      for (let i = Math.max(from, lastPrinted + 1); i <= to; i += 1) {
        const isMatch = matchedLines.has(i);
        const handoffCandidate =
          isMatch || matchedLines.has(i - 1) || matchedLines.has(i + 1);
        const sep = isMatch ? ":" : "-";
        const filePath = codingPath(meta);
        const matchColumn = isMatch ? Math.max(0, lines[i].search(re)) : 0;
        const section = isMatch
          ? sectionOf?.(i, starts[i] + matchColumn)
          : null;
        if (
          isMatch &&
          LEAN_BATCH_HARDREFS_TOOL_SHAPE &&
          section &&
          unitSkeleton &&
          hardReferenceHints.length < 3
        ) {
          const seedKey = `${meta.id}:${section.handle}`;
          if (!hardReferenceSeeds.has(seedKey)) {
            hardReferenceSeeds.add(seedKey);
            hardReferenceGraph ??= await documentGraph(
              document.text,
              meta.id,
              unitSkeleton,
              { tableCells: document.tableCells },
            );
            const scope = oneHopLegalScope(
              unitSkeleton,
              hardReferenceGraph,
              section.handle,
              "outbound",
            );
            for (const target of scope?.nodes.slice(1) ?? []) {
              const firstLine =
                document.text.slice(0, target.start).split(/\r?\n/u).length;
              const lineCount = Math.min(
                2_000,
                document.text
                  .slice(target.start, target.end)
                  .split(/\r?\n/u).length,
              );
              const rendered =
                `[literal reference ${target.label}: ` +
                `Read(paths=[${JSON.stringify(filePath)}], offset=${firstLine}, limit=${lineCount})]`;
              if (
                !hardReferenceHints.some(
                  (candidate) => candidate.rendered === rendered,
                )
              ) {
                hardReferenceHints.push({
                  kind: "literal_reference",
                  label: target.label,
                  path: filePath,
                  offset: firstLine,
                  limit: lineCount,
                  rendered,
                });
              }
              if (hardReferenceHints.length >= 3) break;
            }
          }
        }
        const candidateSection = handoffCandidate
          ? section ?? sectionOf?.(i)
          : null;
        const page =
          isMatch &&
          STRUCTURE_PATH_EXPERIMENT &&
          !section &&
          meta.file_type.toLowerCase() === "pdf"
            ? pageAt(document.pages, starts[i] + matchColumn)
            : null;
        const pageLocator = page
          ? page.pdfPage !== null
            ? `pdf:${page.pdfPage}`
            : page.printedLabel !== null
              ? `printed:${page.printedLabel}`
              : `page:${page.ordinal}`
          : null;
        const pageFirstLine = page
          ? document.text.slice(0, page.start).split(/\r?\n/u).length
          : 0;
        const structureUnit = section
          ? {
              start: section.start,
              end: section.end,
              locator: section.handle,
              display: `Section ${section.display} [${section.handle}]`,
              firstLine: section.firstLine,
              lastLine: section.lastLine,
              projection: "legal-unit" as const,
            }
          : page && pageLocator
            ? {
                start: page.start,
                end: page.end,
                locator: pageLocator,
                display:
                  `PDF page ${page.pdfPage ?? page.ordinal}` +
                  (page.printedLabel !== null
                    ? ` (printed ${page.printedLabel})`
                    : ""),
                firstLine: pageFirstLine,
                lastLine:
                  pageFirstLine +
                  document.text.slice(page.start, page.end).split(/\r?\n/u)
                    .length -
                  1,
                projection: "pdf-page" as const,
              }
            : null;
        const structurePath = structureUnit
          ? registerStructurePath(meta, document, structureUnit)
          : null;
        let renderedPath = filePath;
        let renderedLineNumber = i + 1;
        let renderedLine = lines[i];
        let renderedMatchColumn = matchColumn;
        let sourceLineStart = starts[i];
        if (structurePath && structureUnit) {
          renderedPath = structurePath;
          const unitText = document.text.slice(
            structureUnit.start,
            structureUnit.end,
          );
          const unitLines = unitText.split(/\r?\n/u);
          const unitStarts = sourceLineStarts(unitText, unitLines);
          const localMatch = Math.max(
            0,
            starts[i] + matchColumn - structureUnit.start,
          );
          let localLine = 0;
          while (
            localLine + 1 < unitStarts.length &&
            unitStarts[localLine + 1] <= localMatch
          ) {
            localLine += 1;
          }
          renderedLineNumber = localLine + 1;
          renderedLine = unitLines[localLine] ?? "";
          renderedMatchColumn = Math.max(0, localMatch - unitStarts[localLine]);
          sourceLineStart = structureUnit.start + unitStarts[localLine];
        }
        const prefix = numberLines
          ? `${renderedPath}${sep}${renderedLineNumber}${sep}`
          : `${renderedPath}${sep}`;
        const sliceStart =
          renderedLine.length > GREP_LINE_CAP && isMatch
            ? Math.min(
                Math.max(
                  0,
                  renderedMatchColumn - Math.floor(GREP_LINE_CAP / 2),
                ),
                renderedLine.length - GREP_LINE_CAP,
              )
            : 0;
        const shown = renderedLine.slice(
          sliceStart,
          sliceStart + GREP_LINE_CAP,
        );
        const contact = structurePath && structureUnit
          ? `  [source=${meta.filename} | ${structureUnit.display} | source lines ${structureUnit.firstLine}-${structureUnit.lastLine}]`
          : isMatch &&
          (RETRIEVAL_EXPERIMENT_SHAPE === "h1-contact" ||
            LEGAL_GREP_EXPERIMENT)
            ? (() => {
                const recipe = MIKE_GREP_FAMILY_TOOL_SHAPE
                  ? section
                    ? `Read file_path=${JSON.stringify(filePath)} section="${section.handle}"`
                    : `Read file_path=${JSON.stringify(filePath)} offset=${i + 1} limit=1`
                  : section
                    ? `Read section="${section.handle}"`
                    : `Read offset=${i + 1} limit=1`;
                const extent = section
                  ? ` | lines ${section.firstLine}-${section.lastLine}`
                  : "";
                const page = pageAt(
                  document.pages,
                  starts[i] + matchColumn,
                );
                const pageFacts = page
                  ? ` | pdf ${page.pdfPage ?? "?"} | printed ${page.printedLabel ?? "?"}`
                  : "";
                return [
                  `  [${recipe}${extent}${pageFacts}]`,
                  `  [${recipe}${extent}]`,
                  `  [${recipe}]`,
                  `  [Read offset=${i + 1} limit=1]`,
                ].find((candidate) => candidate.length <= 120)!;
              })()
            : section &&
                !STRUCTURE_PATH_EXPERIMENT &&
                !LEAN_BATCH_HARDREFS_TOOL_SHAPE
              ? `  [${section.handle}]`
              : "";
        rows.push({
          rendered:
            `${prefix}${sliceStart ? "…" : ""}${shown}` +
            (sliceStart + shown.length < renderedLine.length ? "…" : "") +
            contact,
          span: [
            sourceLineStart + sliceStart,
            sourceLineStart + sliceStart + shown.length,
          ],
          handoffCandidate,
          source: {
            documentId: meta.id,
            versionId: document.versionId || meta.current_version_id,
            filename: meta.filename,
            ...(structureUnit
              ? { locator: structureUnit.locator }
              : candidateSection?.handle
                ? { locator: candidateSection.handle }
                : {}),
            ...(structurePath && { virtualPath: structurePath }),
            ...(structurePath &&
              structureUnit && { projection: structureUnit.projection }),
          },
        });
        lastPrinted = i;
      }
    }
    if (truncated) break;
  }
  if (mode === "working_set") {
    if (!workingSets) return fail(call, "Working-set state is unavailable");
    if (ACCRETIVE_WORKING_SET_EXPERIMENT) {
      return accretiveWorkingSetResult(
        call,
        materializeAccretiveWorkingSet(
          workingSetCandidates,
          workingSetMaps,
          args.max_chars,
          workingSets,
          {
            searched: targets.length,
            matched: new Set(
              workingSetCandidates.map((candidate) => candidate.documentId),
            ).size,
          },
        ),
      );
    }
    return result(
      call,
      materializeStatelessWorkingSet(
        workingSetCandidates,
        args.max_chars,
        workingSets,
      ),
    );
  }
  if (mode === "sections") {
    let cursor = 0;
    while (rows.length < headLimit) {
      let advanced = false;
      for (const queue of sectionQueues) {
        const item = queue[cursor];
        if (!item) continue;
        advanced = true;
        rows.push({ rendered: `${item.rendered} | hits=${item.hits}` });
        if (rows.length >= headLimit) break;
      }
      if (!advanced) break;
      cursor += 1;
    }
    truncated =
      sectionQueues.reduce((total, queue) => total + queue.length, 0) >
      rows.length;
  }
  if (!rows.length) return result(call, "No matches found");
  const limited = rows.slice(0, headLimit);
  const { kept, truncated: sizeTruncated } = takeCodingOutputLines(limited);
  const body = [
    kept.map((line) => line.rendered).join("\n"),
    ...hardReferenceHints.map((hint) => hint.rendered),
  ].join("\n");
  const output = codingTextResult(
    call,
    truncated || rows.length > headLimit || sizeTruncated
      ? `${body}\n(Results truncated, showing first ${headLimit} lines. Narrow the pattern or pass head_limit.)`
      : body,
    kept,
  );
  const visibleHints = hardReferenceHints.filter((hint) =>
    output.content.includes(hint.rendered),
  );
  return visibleHints.length
    ? {
        ...output,
        retrievalHints: visibleHints.map(({ rendered: _, ...hint }) =>
          hint,
        ),
      }
    : output;
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

const textCache = new Map<
  string,
  {
    text: string;
    cautions: string[];
    pages: PageMap;
    tableCells: TableCellSpan[];
  }
>();

export async function extractLocalDocument(
  userId: string,
  documentId: string,
  versionId?: string,
) {
  const file = await getLocalVersionFile(userId, documentId, versionId);
  if (!file) return null;
  const cacheKey =
    `${documentId}:${file.version.id}:` +
    (file.version.source_sha256 ?? file.version.created_at);
  const cached = textCache.get(cacheKey);
  if (cached !== undefined) {
    return {
      filename: file.document.filename,
      documentId,
      versionId: file.version.id,
      ...cached,
    };
  }

  const fileType = file.fileType.toLowerCase();
  const parser = textParserFor(fileType);
  const parsed =
    fileType === "pdf"
      ? await readLocalPdfSourceDoc(file.path).catch(() => null)
      : null;
  let bytes: Buffer | undefined;
  const sourceBytes = async () => (bytes ??= await readFile(file.path));
  const docxStructure =
    fileType === "docx"
      ? await extractDocxBodyStructure(await sourceBytes())
      : null;
  const spreadsheetStructure = isSpreadsheetDocumentType(fileType)
    ? await spreadsheetToLLMStructure(await sourceBytes())
    : null;
  const text: string =
    parsed?.text ??
    docxStructure?.text ??
    spreadsheetStructure?.text ??
    (parser
      ? await sourceBytes().then((value) =>
          cachedParse({
            scope: `user:${userId}`,
            parser: parser.parser,
            version: parser.version,
            bytes: value,
            parse: () => parser.run(value),
          }),
        )
      : "");
  // Additive metadata only: the sniffer's cautions ride alongside the text,
  // which stays byte-identical to what this function has always returned.
  const cautions =
    fileType === "docx"
      ? docxCautionNotes(
          await docxPathologyReportFor({
            fileType,
            scope: `user:${userId}`,
            bytes: await sourceBytes(),
          }),
        )
      : [];

  // The page map is built HERE because this is the only place that still
  // holds the engine artifact: `parsed` carries both the PDF page number and
  // the printed label the engine's header/footer detection found, and the
  // rendered text collapses them into one marker. Every consumer downstream
  // sees text only, so a map recovered later cannot tell "printed 47" from
  // "PDF page 47" — and a table of contents cites the printed one.
  //
  // Both PDF routes end at the engine, so both can be indexed: the ingested
  // artifact carries page BLOCKS, and the un-ingested route still renders
  // `[page N]` markers into the text. Fall through from one to the other, and
  // when a PDF yields neither, say the index is UNAVAILABLE — a PDF has
  // pages whether or not we managed to read them, and reporting "no pages"
  // would state a falsehood about the document to cover a gap in the
  // pipeline.
  const fromArtifact = parsed ? pageMapFromSourceDoc(parsed) : null;
  const pages: PageMap = fromArtifact?.pages.length
    ? fromArtifact
    : (() => {
        const recovered = pageMapFromMarkers(text);
        if (recovered.pages.length || fileType !== "pdf") return recovered;
        return { pages: [], source: "unindexed" as const };
      })();
  const tableCells: TableCellSpan[] =
    docxStructure?.tableCells ?? spreadsheetStructure?.tableCells ?? [];

  if (textCache.size >= 16) {
    textCache.delete(textCache.keys().next().value!);
  }
  textCache.set(cacheKey, { text, cautions, pages, tableCells });
  return {
    filename: file.document.filename,
    documentId,
    versionId: file.version.id,
    text,
    cautions,
    pages,
    tableCells,
  };
}

/**
 * Opt-in redline view (3i-2): the active version's body text with tracked
 * changes, comments, and manual ink redlines projected as markers. A read
 * view only — the edit paths keep anchoring against the default text.
 */
async function extractLocalRedlineDocument(userId: string, documentId: string) {
  const file = await getLocalVersionFile(userId, documentId);
  if (!file) return null;
  if (file.fileType.toLowerCase() !== "docx") {
    throw new Error("Redline view requires a DOCX document");
  }
  const projection = await projectDocxRedline(await readFile(file.path));
  return {
    filename: file.document.filename,
    document_id: documentId,
    version_id: file.version.id,
    version_number: file.version.version_number,
    view: "redline" as const,
    marker_legend: REDLINE_VIEW_LEGEND,
    text: projection.text,
    counts: projection.counts,
    ...(projection.notes.length ? { notes: projection.notes } : {}),
  };
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
export const MAX_TOOL_RESULT_CHARS = Number(
  process.env.MIKE_TOOL_RESULT_CAP || 64_000,
);

/**
 * A cap the model cannot act on is just a hole in the answer, so say what was
 * dropped and name the calls that fetch it back. Beaver can be more specific
 * than a byte offset: it has addressable section handles.
 */
function continuationHint(call: NormalizedToolCall): string {
  const documentId =
    typeof call.input?.document_id === "string" ? call.input.document_id : "";
  const target = documentId ? `document_id="${documentId}"` : "this document";
  if (call.name === "library_read") {
    return NAV_TOOL_SHAPE === "address"
      ? `Call library_outline with ${target}, then retry library_read with a narrower at address or max_chars; library_find can locate exact wording.`
      : `Call library_outline with ${target}, then retry library_read with a narrower section or max_chars; library_find can locate exact wording and offsets.`;
  }
  if (call.name === "library_find") {
    return NAV_TOOL_SHAPE === "address"
      ? "Narrow query or at, or lower max_results/context_chars, then retry library_find."
      : "Narrow query, pages, or section, or lower max_results/context_chars, then retry library_find.";
  }
  if (call.name === "library_outline") {
    return `Use a handle visible in the preview with library_read for ${target}.`;
  }
  if (call.name === "library_links") {
    return `Retry library_links for ${target} with one structural at address or a lower max_results.`;
  }
  if (/^(?:a2aj|caselaw|courtlistener|hansard|legal_pdf|public_legal_source)_/u.test(call.name)) {
    return `Retry ${call.name} with a narrower query, exact source identifier, or locator; reuse identifiers visible in the preview.`;
  }
  if (call.name.startsWith("library_")) {
    return `Retry ${call.name} with a smaller input batch or a more specific identifier.`;
  }
  return `Retry ${call.name} with narrower inputs.`;
}

function result(
  call: NormalizedToolCall,
  content: unknown,
): NormalizedToolResult {
  const serialized =
    typeof content === "string" ? content : JSON.stringify(content);
  const objectContent =
    content && typeof content === "object" && !Array.isArray(content)
      ? (content as Record<string, unknown>)
      : null;
  const reportedStatus =
    typeof objectContent?.status === "string" &&
    [
      "ok",
      "not_found",
      "ambiguous",
      "selection_required",
      "action_required",
      "truncated",
      "past_end",
      "already_exposed",
      "error",
    ].includes(objectContent.status)
      ? (objectContent.status as NormalizedToolResult["status"])
      : null;
  const status: NormalizedToolResult["status"] =
    reportedStatus ??
    (objectContent?.ok === false
      ? /ambiguous/iu.test(String(objectContent.error ?? ""))
        ? "ambiguous"
        : /not found|does not exist|no (?:matches|files)/iu.test(
              String(objectContent.error ?? ""),
            )
          ? "not_found"
          : "error"
      : objectContent?.truncated === true
        ? "truncated"
        : /past the end|outside section/iu.test(serialized)
          ? "past_end"
          : /ambiguous/iu.test(serialized)
            ? "ambiguous"
            : /^No (?:matches|files)/iu.test(serialized)
              ? "not_found"
              : "ok");
  if (serialized.length <= MAX_TOOL_RESULT_CHARS) {
    return { tool_use_id: call.id, content: serialized, status };
  }
  const ok =
    content && typeof content === "object" && !Array.isArray(content)
      ? (content as Record<string, unknown>).ok
      : undefined;
  const mutationReceipt =
    content &&
    typeof content === "object" &&
    !Array.isArray(content) &&
    (content as Record<string, unknown>).receipt === "mike-document:v1"
      ? serialized
      : undefined;
  const envelope = (keep: number) => {
    const headLength = Math.ceil(keep * 0.7);
    const tailLength = keep - headLength;
    return JSON.stringify({
      ...(typeof ok === "boolean" ? { ok } : {}),
      truncated: true,
      original_format: typeof content === "string" ? "text" : "json",
      omitted_characters: serialized.length - keep,
      preview: {
        head: serialized.slice(0, headLength),
        tail: tailLength ? serialized.slice(-tailLength) : "",
      },
      continuation: continuationHint(call),
    });
  };
  // JSON escaping makes the payload size data-dependent. A tiny binary
  // search keeps the most preview text that fits while preserving valid JSON.
  let low = 0;
  let high = Math.min(serialized.length, MAX_TOOL_RESULT_CHARS);
  let shortened = envelope(0);
  while (low <= high) {
    const keep = Math.floor((low + high) / 2);
    const candidate = envelope(keep);
    if (candidate.length <= MAX_TOOL_RESULT_CHARS) {
      shortened = candidate;
      low = keep + 1;
    } else {
      high = keep - 1;
    }
  }
  return {
    tool_use_id: call.id,
    content:
      shortened.length <= MAX_TOOL_RESULT_CHARS
        ? shortened
        : JSON.stringify({ truncated: true }),
    status: "truncated",
    ...(mutationReceipt ? { mutationReceipt } : {}),
  };
}

function codingTextResult(
  call: NormalizedToolCall,
  content: string,
  lines: CodingOutputLine[],
): NormalizedToolResult {
  const rendered = result(call, content);
  const sourceLines =
    call.name === "Grep"
      ? lines.filter((line) => line.handoffCandidate === true)
      : lines;
  return rendered.content === content
    ? {
        ...rendered,
        evidenceSpans: sourceLines.flatMap((line) =>
          line.span ? [line.span] : [],
        ),
        evidenceSegments: sourceLines.flatMap((line) =>
          line.span && line.source
            ? [
                {
                  ...line.source,
                  start: line.span[0],
                  end: line.span[1],
                  kind: call.name === "Grep" ? "candidate" : "evidence",
                },
              ]
            : [],
        ),
      }
    : rendered;
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
  const compactUnit = (unit: (typeof lookup.units)[number]) => ({
    kind: unit.kind,
    locator: unit.locator,
    text: unit.text,
    ...(unit.page_numbers.length ? { pages: unit.page_numbers } : {}),
    ...(unit.confidence !== null && unit.confidence < 1
      ? { confidence: unit.confidence }
      : {}),
    ...(unit.proposition ? { proposition: unit.proposition } : {}),
    ...(unit.note
      ? {
          note: {
            label: unit.note.label,
            ...(unit.note.warnings.length
              ? { warnings: unit.note.warnings }
              : {}),
          },
        }
      : {}),
  });
  return {
    ok: true,
    filename,
    status: lookup.status,
    exact: true,
    handle: lookup.evidence.handle,
    version_id: lookup.source.version_id,
    units: lookup.units.map(compactUnit),
    ...(lookup.before.length || lookup.after.length
      ? {
          context: {
            before: lookup.before.map(compactUnit),
            after: lookup.after.map(compactUnit),
          },
        }
      : {}),
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

function pdfEvidenceRefs(
  filename: string,
  lookup: LocalPdfLookupResult,
): NonNullable<NormalizedToolResult["evidenceRefs"]> {
  if (lookup.status !== "found") return [];
  return [...lookup.before, ...lookup.units, ...lookup.after]
    .filter((unit) => Boolean(unit.text))
    .map((unit) => ({
      handle: `${lookup.evidence.handle}#${unit.id}`,
      filename,
      locator: unit.locator,
      text: unit.text,
      exactSha256: sha256(unit.text),
      kind: "evidence" as const,
    }));
}

function receiptEvidenceRefs(
  receipts: Array<LegalEvidenceReceipt | undefined>,
): NonNullable<NormalizedToolResult["evidenceRefs"]> {
  return receipts.flatMap((receipt) =>
    receipt?.span_text
      ? [
          {
            handle: receipt.evidence_id,
            filename: receipt.name ?? receipt.citation,
            locator: receipt.locator.label,
            text: receipt.span_text,
            exactSha256: sha256(receipt.span_text),
            kind: "evidence" as const,
          },
        ]
      : [],
  );
}

function publicLegalEvidenceRefs(
  payload: Record<string, unknown>,
): NonNullable<NormalizedToolResult["evidenceRefs"]> {
  const evidence =
    payload.evidence &&
    typeof payload.evidence === "object" &&
    !Array.isArray(payload.evidence)
      ? (payload.evidence as Record<string, unknown>)
      : null;
  const baseHandle =
    typeof evidence?.handle === "string"
      ? evidence.handle
      : `public:${String(payload.provider ?? "source")}:${String(payload.identifier ?? "document")}`;
  const filename = String(
    payload.title ?? payload.identifier ?? "Public legal source",
  );
  const blocks = [
    payload.block,
    ...(Array.isArray(payload.before) ? payload.before : []),
    ...(Array.isArray(payload.after) ? payload.after : []),
  ];
  const refs = blocks.flatMap((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const block = raw as Record<string, unknown>;
    const text = typeof block.text === "string" ? block.text : "";
    if (!text) return [];
    const locator = String(block.label ?? `context ${index + 1}`);
    return [
      {
        handle: `${baseHandle}#${locator}:${sha256(text)}`,
        filename,
        locator,
        text,
        exactSha256: sha256(text),
        kind: "evidence" as const,
      },
    ];
  });
  if (refs.length) return refs;
  const documentText = typeof payload.text === "string" ? payload.text : "";
  return documentText
    ? [
        {
          handle: `${baseHandle}#document:${sha256(documentText)}`,
          filename,
          locator: "document",
          text: documentText,
          exactSha256: sha256(documentText),
          kind: "evidence" as const,
        },
      ]
    : [];
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

type InsertBlocksRequest = {
  blocks: string[];
  position: "before" | "after";
  anchorText?: string;
  occurrence?: number;
};

function parseInsertBlocksRequest(raw: unknown): InsertBlocksRequest | null | string {
  if (!Array.isArray(raw)) return null;
  const inserts = raw.filter(
    (item) =>
      item &&
      typeof item === "object" &&
      (item as Record<string, unknown>).op === "insert_blocks",
  );
  if (!inserts.length) return null;
  if (raw.length !== 1) return "insert_blocks must be the only op in its call";
  const item = inserts[0] as Record<string, unknown>;
  const blocks = Array.isArray(item.blocks)
    ? item.blocks.filter((block): block is string => typeof block === "string")
    : [];
  if (
    !blocks.length ||
    blocks.length > 20 ||
    blocks.some(
      (block) =>
        !block.trim() || block.length > TEXT_OP_STRING_LIMIT || /[\r\n]/u.test(block),
    )
  ) {
    return "insert_blocks.blocks must contain 1 to 20 non-empty single-paragraph strings";
  }
  const scope = item.scope as Record<string, unknown> | undefined;
  if (!scope || (scope.kind !== "whole_document" && scope.kind !== "find_text")) {
    return "insert_blocks scope must be whole_document or find_text";
  }
  if (scope.kind === "find_text" && !trimmed(scope.text)) {
    return "insert_blocks find_text scope requires exact anchor text";
  }
  return {
    blocks,
    position: item.position === "before" ? "before" : "after",
    ...(scope.kind === "find_text" ? { anchorText: trimmed(scope.text) } : {}),
    ...(typeof scope.occurrence === "number"
      ? { occurrence: Math.trunc(scope.occurrence) }
      : {}),
  };
}

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
    } else if (rawScope.kind === "at") {
      if (!boundedString(rawScope.at) || !(rawScope.at as string).trim()) {
        return `${at}.scope.at is required for at`;
      }
      // Carried unresolved: resolution needs the pinned version's text, and
      // the contract is that every scope resolves against THAT version.
      scope = {
        kind: "at",
        at: (rawScope.at as string).trim(),
        ...(typeof rawScope.follow === "string" ? { follow: rawScope.follow } : {}),
        ...(typeof rawScope.depth === "number"
          ? { depth: Math.trunc(rawScope.depth) }
          : {}),
      } as unknown as TextOpScope;
    } else {
      return `${at}.scope.kind must be whole_document, at, find_text, or range`;
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
      turnEditState?: LocalAssistantEditTurnState,
    ) => Promise<unknown>;
    fallback: string;
  }
> = {
  library_link_docx_citations: {
    run: (userId, documentId, _versionId, turnEditState) =>
      linkLocalDocxCitations(userId, documentId, {
        saveVersion: async ({ sourceVersionId, filename, bytes }) => {
          const committed = await commitLocalAssistantTurnVersion({
              userId,
              documentId,
              sourceVersionId,
              filename,
              bytes,
              trackedEdits: [],
              turnEditState,
            });
          if (!committed) {
            throw new Error(
              "The active version changed or the update would invalidate an earlier same-turn tracked-edit receipt",
            );
          }
          return {
            ...committed.version,
            parentVersionId: committed.parentVersionId,
          };
        },
      }),
    fallback: "DOCX citation linking failed",
  },
  library_fix_docx_supras: {
    run: (userId, documentId, _versionId, turnEditState) =>
      fixLocalDocxSupraCrossReferences(userId, documentId, {
        saveVersion: async ({ sourceVersionId, filename, bytes }) => {
          const committed = await commitLocalAssistantTurnVersion({
              userId,
              documentId,
              sourceVersionId,
              filename,
              bytes,
              trackedEdits: [],
              turnEditState,
            });
          if (!committed) {
            throw new Error(
              "The active version changed or the update would invalidate an earlier same-turn tracked-edit receipt",
            );
          }
          return {
            ...committed.version,
            parentVersionId: committed.parentVersionId,
          };
        },
      }),
    fallback: "DOCX supra cleanup failed",
  },
  library_lint_docx_structure: {
    run: (userId, documentId, versionId) =>
      lintLocalDocxStructure(userId, documentId, versionId),
    fallback: "DOCX structural lint failed",
  },
};

export const LOCAL_TURN_EDIT_TOOL_NAMES = new Set([
  "library_revise_docx",
  "library_apply_text_ops",
  "library_delete_and_renumber_docx",
  "library_link_docx_citations",
  "library_fix_docx_supras",
  "Edit",
]);

const upstreamMikeResult = (
  call: NormalizedToolCall,
  content: unknown,
): NormalizedToolResult => ({
  tool_use_id: call.id,
  content: typeof content === "string" ? content : JSON.stringify(content),
});

function upstreamMikeCitationReminder(docLabel: string, filename: string) {
  const isSpreadsheet = isSpreadsheetDocumentType(
    filename.split(".").pop() ?? "",
  );
  const shapeLine = isSpreadsheet
    ? `Use this citation object shape for this spreadsheet: {"ref": 1, "doc_id": "${docLabel}", "quotes": [{"sheet": "Sheet name", "cell": "B7", "quote": "plain cell value"}]}. Cite by "sheet" + "cell" (A1 address or range), not by page.`
    : `Use this citation object shape: {"ref": 1, "doc_id": "${docLabel}", "quotes": [{"page": 1, "quote": "exact verbatim text from the document"}]}. Include top-level "page" and "quote" too only if they match the first quote.`;
  return [
    `[Citation requirement for ${docLabel} ("${filename}")]:`,
    "If your final answer makes any factual claim from this document, include inline [N] markers and append a final <CITATIONS> JSON block.",
    `Every citation entry for this document MUST use "doc_id": "${docLabel}".`,
    shapeLine,
    'Do not use "marker" or "text" keys in the citation block; use "ref" and "quotes".',
  ].join("\n");
}

function upstreamMikeSectionsMarkdown(value: unknown) {
  if (!Array.isArray(value)) return "";
  const blocks: string[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const section = raw as Record<string, unknown>;
    if (section.pageBreak === true && blocks.length) blocks.push("---");
    const heading = trimmed(section.heading);
    if (heading) {
      blocks.push(`${"#".repeat(clampInt(section.level, 1, 3, 1))} ${heading}`);
    }
    const content = trimmed(section.content);
    if (content) blocks.push(content);
    const table =
      section.table &&
      typeof section.table === "object" &&
      !Array.isArray(section.table)
        ? (section.table as Record<string, unknown>)
        : null;
    const headers = stringArray(table?.headers);
    const rows = Array.isArray(table?.rows)
      ? table.rows.filter(Array.isArray).map((row) => stringArray(row))
      : [];
    if (headers.length) {
      const cell = (text: string) => text.replace(/\|/gu, "\\|").replace(/\r?\n/gu, " ");
      blocks.push(
        `| ${headers.map(cell).join(" | ")} |\n` +
          `| ${headers.map(() => "---").join(" | ")} |` +
          (rows.length
            ? `\n${rows
                .map(
                  (row) =>
                    `| ${headers.map((_, index) => cell(row[index] ?? "")).join(" | ")} |`,
                )
                .join("\n")}`
            : ""),
      );
    }
  }
  return blocks.join("\n\n");
}

async function runUpstreamMikeRetrievalCall(params: {
  call: NormalizedToolCall;
  userId: string;
  allowedDocumentIds?: Set<string>;
  readState?: LocalAssistantReadTurnState;
  wholeReadMaxChars?: number;
  citationReminders?: boolean;
}): Promise<NormalizedToolResult | null> {
  const {
    call,
    userId,
    allowedDocumentIds,
    readState,
    wholeReadMaxChars = 0,
    citationReminders = true,
  } = params;
  if (
    ![
      "list_documents",
      "fetch_documents",
      "read_document",
      "find_in_document",
    ].includes(call.name)
  ) {
    return null;
  }

  const storedDocuments = (await listLocalLibrary(userId, "file")).documents;
  const storedById = new Map(
    storedDocuments.map((document) => [document.id, document]),
  );
  // Upstream project chat exposes turn-local doc-N labels, not the durable
  // database UUIDs used by Beaver's local store. Preserve attachment order so
  // the AVAILABLE DOCUMENTS prompt and every tool agree on the same labels.
  const documents = (
    allowedDocumentIds
      ? [...allowedDocumentIds].map((documentId) => storedById.get(documentId))
      : storedDocuments
  ).filter(
    (document): document is (typeof storedDocuments)[number] => !!document,
  );
  const byId = new Map(documents.map((document) => [document.id, document]));
  const labelledDocuments = documents.map((document, index) => ({
    document,
    docLabel: `doc-${index}`,
  }));
  const byLabel = new Map(
    labelledDocuments.map(({ document, docLabel }) => [docLabel, document]),
  );
  const filenameCounts = new Map<string, number>();
  for (const { document } of labelledDocuments) {
    const key = document.filename.toLocaleLowerCase("en-US");
    filenameCounts.set(key, (filenameCounts.get(key) ?? 0) + 1);
  }
  const byFilename = new Map(
    labelledDocuments.flatMap(({ document }) => {
      const key = document.filename.toLocaleLowerCase("en-US");
      return filenameCounts.get(key) === 1 ? [[key, document] as const] : [];
    }),
  );
  const labelById = new Map(
    labelledDocuments.map(({ document, docLabel }) => [document.id, docLabel]),
  );
  const resolveDocument = (requested: string) =>
    byLabel.get(requested) ??
    byId.get(requested) ??
    byFilename.get(requested.toLocaleLowerCase("en-US"));
  const readOne = async (requested: string) => {
    const listed = resolveDocument(requested);
    const docLabel = listed ? labelById.get(listed.id) ?? requested : requested;
    const documentId = listed?.id ?? "";
    if (!listed) {
      return {
        content: `Document '${requested}' not found.`,
        duplicate: false,
        evidenceSegments: [] as NonNullable<
          NormalizedToolResult["evidenceSegments"]
        >,
      };
    }
    const file = await getLocalVersionFile(userId, documentId);
    if (!file) {
      return {
        content: "Document could not be read.",
        duplicate: false,
        evidenceSegments: [] as NonNullable<
          NormalizedToolResult["evidenceSegments"]
        >,
      };
    }
    const key = `${documentId}:${file.version.id}`;
    const prior = readState?.get(key);
    if (prior && SUPPRESS_DUPLICATE_WHOLE_READS) {
      return {
        content: JSON.stringify({
          ok: true,
          already_read: true,
          doc_id: prior.docLabel ?? docLabel,
          document_id: prior.documentId,
          filename: prior.filename,
          version_id: prior.versionId,
          content:
            "This document/version was already read earlier in this response. The full text is not repeated to avoid unnecessary token use.",
          next_required_action:
            "Use the prior read_document/fetch_documents result, call find_in_document for targeted checks, or proceed to edit_document.",
        }),
        duplicate: true,
        evidenceSegments: [] as NonNullable<
          NormalizedToolResult["evidenceSegments"]
        >,
      };
    }
    const draftingMarkdown =
      MARKDOWN_READ_DOCX && file.fileType.toLowerCase() === "docx"
        ? await (async () => {
            const bytes = await readFile(file.path);
            const source = await extractDocxDraftingSource(bytes).catch(
              () => null,
            );
            if (!source) return null;
            if (!STRUCTURE_INDEX_ENABLED) return source.markdown;
            // The index is best-effort orientation; if derivation ever fails
            // on a docx the drafting source accepted, serve the plain markdown
            // rather than failing the read (the arm must never be worse than e2e).
            try {
              return attachStructureIndex(
                source.markdown,
                renderStructureIndex(await deriveSectionNodes(bytes)),
              );
            } catch {
              return source.markdown;
            }
          })()
        : null;
    const document = draftingMarkdown
      ? {
          filename: file.document.filename,
          documentId,
          versionId: file.version.id,
          text: draftingMarkdown,
          cautions: [],
          pages: { pages: [], source: "unindexed" as const },
          tableCells: [],
        }
      : await extractLocalDocument(userId, documentId);
    if (!document) {
      return {
        content: "Document could not be read.",
        duplicate: false,
        evidenceSegments: [] as NonNullable<
          NormalizedToolResult["evidenceSegments"]
        >,
      };
    }
    const previouslyDelivered =
      prior?.deliveredChars ?? prior?.sourceChars ?? 0;
    readState?.set(key, {
      documentId,
      docLabel,
      versionId: file.version.id,
      filename: document.filename,
      sourceChars: document.text.length,
      deliveredChars: SUPPRESS_DUPLICATE_WHOLE_READS
        ? document.text.length
        : previouslyDelivered + document.text.length,
    });
    return {
      content: document.text,
      duplicate: false,
      evidenceSegments: document.text
        ? [
            {
              documentId,
              versionId: file.version.id,
              filename: document.filename,
              projection: "canonical",
              kind: "evidence" as const,
              start: 0,
              end: document.text.length,
            },
          ]
        : [],
    };
  };

  if (call.name === "list_documents") {
    if (
      !ADAPTIVE_MIKE_TOOL_SHAPE &&
      !MIKE_GREP_FAMILY_TOOL_SHAPE &&
      !LEAN_BATCH_FAMILY_TOOL_SHAPE
    ) {
      return upstreamMikeResult(
        call,
        labelledDocuments.map(({ document, docLabel }) => ({
          doc_id: docLabel,
          filename: document.filename,
          file_type: document.file_type,
        })),
      );
    }
    const inventoryRows = await Promise.all(
      labelledDocuments.map(async ({ document, docLabel }) => {
        const extracted = await extractLocalDocument(userId, document.id);
        const opening =
          LEAN_BATCH_FAMILY_TOOL_SHAPE && extracted
            ? /[^\s].*/u.exec(extracted.text)
            : null;
        const openingLine = opening?.[0].slice(0, 160) ?? "";
        return {
          document: {
            doc_id: docLabel,
            filename: document.filename,
            file_type: document.file_type,
            characters: extracted?.text.length ?? 0,
            lines: extracted ? extracted.text.split(/\r?\n/u).length : 0,
            pages: extracted?.pages.pages.length ?? 0,
            ...(openingLine ? { opening_line: openingLine } : {}),
          },
          evidence:
            openingLine && extracted
              ? {
                  documentId: document.id,
                  versionId: extracted.versionId,
                  filename: document.filename,
                  locator: "opening line",
                  projection: "canonical" as const,
                  kind: "candidate" as const,
                  start: opening!.index,
                  end: opening!.index + openingLine.length,
                }
              : null,
        };
      }),
    );
    const inventory = inventoryRows.map((row) => row.document);
    return {
      ...upstreamMikeResult(call, {
        documents: inventory,
        totals: {
          documents: inventory.length,
          characters: inventory.reduce(
            (sum, document) => sum + document.characters,
            0,
          ),
          lines: inventory.reduce((sum, document) => sum + document.lines, 0),
          pages: inventory.reduce((sum, document) => sum + document.pages, 0),
        },
      }),
      evidenceSegments: inventoryRows.flatMap((row) =>
        row.evidence ? [row.evidence] : [],
      ),
    };
  }

  if (call.name === "read_document") {
    const requested = trimmed(call.input.doc_id);
    const listed = resolveDocument(requested);
    const docLabel = listed ? labelById.get(listed.id) ?? requested : requested;
    const section = trimmed(call.input.section);
    const pages = Array.isArray(call.input.pages)
      ? call.input.pages
          .map(Number)
          .filter((page) => Number.isInteger(page) && page > 0)
      : [];
    const bounded =
      ADAPTIVE_MIKE_TOOL_SHAPE &&
      (section.length > 0 ||
        pages.length > 0 ||
        typeof call.input.offset === "number" ||
        typeof call.input.max_chars === "number");
    if (bounded) {
      if (!listed) {
        return upstreamMikeResult(call, {
          ok: false,
          error: `Document '${requested}' not found.`,
        });
      }
      if (section && pages.length) {
        return upstreamMikeResult(call, {
          ok: false,
          error: "Choose section or pages in one read, not both.",
        });
      }
      const document = await extractLocalDocument(userId, listed.id);
      if (!document) {
        return upstreamMikeResult(call, {
          ok: false,
          error: "Document could not be read.",
        });
      }
      let spans: Array<{ start: number; end: number; locator: string }> = [];
      if (section) {
        const skeleton = compileAgreementSkeleton(document.text, listed.id, {
          tableCells: document.tableCells,
        });
        const selected = readSection(skeleton, section);
        if (selected.status !== "found" || !selected.block) {
          return upstreamMikeResult(call, {
            ok: false,
            status: selected.status,
            requested_section: section,
            matches: selected.matches,
            error: `Section '${section}' could not be resolved exactly.`,
          });
        }
        spans = [
          {
            start: selected.block.start,
            end: selected.block.end,
            locator: selected.block.label,
          },
        ];
      } else if (pages.length) {
        const byOrdinal = new Map(
          document.pages.pages.map((page) => [page.ordinal, page]),
        );
        const missing = [...new Set(pages)].filter(
          (page) => !byOrdinal.has(page),
        );
        if (missing.length) {
          return upstreamMikeResult(call, {
            ok: false,
            error: `Page ordinal(s) unavailable: ${missing.join(", ")}.`,
            available_pages: document.pages.pages.length,
          });
        }
        spans = [...new Set(pages)]
          .sort((left, right) => left - right)
          .map((ordinal) => {
            const page = byOrdinal.get(ordinal)!;
            return {
              start: page.start,
              end: page.end,
              locator: `page ${ordinal}`,
            };
          });
      } else {
        spans = [{ start: 0, end: document.text.length, locator: "document" }];
      }

      const selectedChars = spans.reduce(
        (sum, span) => sum + Math.max(0, span.end - span.start),
        0,
      );
      const offset = clampInt(call.input.offset, 0, selectedChars, 0);
      const maxChars = clampInt(call.input.max_chars, 1, 200_000, 24_000);
      let skip = offset;
      let remaining = maxChars;
      const chunks: string[] = [];
      const evidenceSegments: NonNullable<
        NormalizedToolResult["evidenceSegments"]
      > = [];
      for (const span of spans) {
        const spanLength = Math.max(0, span.end - span.start);
        if (skip >= spanLength) {
          skip -= spanLength;
          continue;
        }
        if (remaining <= 0) break;
        const start = span.start + skip;
        const end = Math.min(span.end, start + remaining);
        const text = document.text.slice(start, end);
        chunks.push(`--- ${span.locator} | chars ${start}-${end} ---\n${text}`);
        evidenceSegments.push({
          documentId: listed.id,
          versionId: document.versionId,
          filename: document.filename,
          locator: `${span.locator}; chars ${start}-${end}`,
          projection: "canonical",
          kind: "evidence" as const,
          start,
          end,
        });
        remaining -= end - start;
        skip = 0;
      }
      const deliveredChars = evidenceSegments.reduce(
        (sum, span) => sum + span.end - span.start,
        0,
      );
      const nextOffset = offset + deliveredChars;
      const nextRead =
        nextOffset < selectedChars
          ? {
              doc_id: docLabel,
              ...(section ? { section } : {}),
              ...(pages.length ? { pages: [...new Set(pages)].sort((a, b) => a - b) } : {}),
              offset: nextOffset,
              max_chars: maxChars,
            }
          : null;
      return {
        ...upstreamMikeResult(call, {
          ok: true,
          doc_id: docLabel,
          filename: document.filename,
          selection: section
            ? { section }
            : pages.length
              ? { pages: [...new Set(pages)].sort((a, b) => a - b) }
              : { document: true },
          offset,
          selected_characters: selectedChars,
          returned_characters: deliveredChars,
          truncated: nextRead !== null,
          text: chunks.join("\n\n"),
          ...(nextRead
            ? {
                next_read: nextRead,
                continuation: `Call read_document with ${JSON.stringify(nextRead)}.`,
              }
            : {}),
        }),
        evidenceSegments,
      };
    }
    const read = await readOne(requested);
    const content =
      listed && !read.duplicate
        ? `${upstreamMikeCitationReminder(docLabel, listed.filename)}\n\n${read.content}`
        : read.content;
    return {
      ...upstreamMikeResult(call, content),
      evidenceSegments: read.evidenceSegments,
    };
  }

  if (call.name === "fetch_documents") {
    const requestedDocuments = stringArray(call.input.doc_ids);
    if (wholeReadMaxChars > 0) {
      const seenVersions = new Set<string>();
      const alreadyReadChars = [...(readState?.values() ?? [])].reduce(
        (total, read) =>
          total + (read.deliveredChars ?? read.sourceChars ?? 0),
        0,
      );
      let requestedChars = 0;
      let newFiles = 0;
      for (const requested of requestedDocuments) {
        const listed = resolveDocument(requested);
        if (!listed) continue;
        const file = await getLocalVersionFile(userId, listed.id);
        if (!file) continue;
        const key = `${listed.id}:${file.version.id}`;
        const seenInCall = seenVersions.has(key);
        if (
          SUPPRESS_DUPLICATE_WHOLE_READS &&
          (seenInCall || readState?.has(key))
        ) {
          continue;
        }
        seenVersions.add(key);
        const document = await extractLocalDocument(userId, listed.id);
        if (!document) continue;
        requestedChars += document.text.length;
        if (!seenInCall && !readState?.has(key)) newFiles += 1;
      }
      const projectedChars = alreadyReadChars + requestedChars;
      if (projectedChars > wholeReadMaxChars) {
        return {
          ...upstreamMikeResult(call, {
            ok: false,
            status: "selection_required",
            code: "WHOLE_READ_OVER_CONTEXT_BUDGET",
            requested_files: requestedDocuments.length,
            new_files: newFiles,
            already_read_chars: alreadyReadChars,
            requested_chars: requestedChars,
            projected_chars: projectedChars,
            max_chars: wholeReadMaxChars,
            next_required_action:
              "Keep any primary instrument, draft, or precedent whole in a smaller fetch_documents call; use Grep and bounded Read for supporting sources.",
          }),
          status: "selection_required",
        };
      }
    }
    const parts: string[] = [];
    const evidenceSegments: NonNullable<
      NormalizedToolResult["evidenceSegments"]
    > = [];
    for (const requested of requestedDocuments) {
      const document = resolveDocument(requested);
      const docLabel = document
        ? labelById.get(document.id) ?? requested
        : requested;
      const filename = document?.filename ?? requested;
      const read = await readOne(requested);
      parts.push(
        `--- ${filename} (${docLabel}) ---\n${
          read.duplicate
            ? read.content
            : citationReminders
              ? `${upstreamMikeCitationReminder(docLabel, filename)}\n\n${read.content}`
              : read.content
        }`,
      );
      evidenceSegments.push(...read.evidenceSegments);
    }
    return {
      ...upstreamMikeResult(call, parts.join("\n\n")),
      evidenceSegments,
    };
  }

  const requested = trimmed(call.input.doc_id);
  const query = trimmed(call.input.query);
  if (!query) return upstreamMikeResult(call, { ok: false, error: "Empty query." });
  const listed = resolveDocument(requested);
  if (!listed) {
    return upstreamMikeResult(call, {
      ok: false,
      error: `Document '${requested}' not found.`,
    });
  }
  const documentId = listed.id;
  const document = await extractLocalDocument(userId, documentId);
  if (!document) {
    return upstreamMikeResult(call, {
      ok: false,
      filename: listed.filename,
      error: "Document could not be read.",
    });
  }
  const maxResults = clampInt(call.input.max_results, 1, 100, 20);
  const contextChars = clampInt(call.input.context_chars, 0, 10_000, 80);
  const matches = findTextMatches({
    text: document.text,
    query,
    maxResults,
    contextChars,
  });
  const candidateReadPath =
    (filenameCounts.get(listed.filename.toLocaleLowerCase("en-US")) ?? 0) === 1
      ? listed.filename
      : labelById.get(documentId) ?? requested;
  return {
    ...upstreamMikeResult(call, {
      ok: true,
      filename: listed.filename,
      query,
      total_matches: matches.totalMatches,
      returned: matches.hits.length,
      truncated: matches.totalMatches > matches.hits.length,
      hits: matches.hits.map((hit) => {
        const start = Math.max(0, hit.at - contextChars);
        const end = Math.min(
          document.text.length,
          hit.at + hit.excerpt.length + contextChars,
        );
        const page = document.pages.pages.find(
          (candidate) => candidate.start <= hit.at && hit.at < candidate.end,
        );
        const candidateStartLine =
          document.text.slice(0, start).split(/\r?\n/u).length;
        const candidateEndLine =
          document.text.slice(0, end).split(/\r?\n/u).length;
        return {
          ...hit,
          locator: `chars ${start}-${end}`,
          ...(page ? { page: page.ordinal } : {}),
          ...(MIKE_GREP_FAMILY_TOOL_SHAPE
            ? {
                read: {
                  file_path: candidateReadPath,
                  offset: candidateStartLine,
                  limit: Math.max(1, candidateEndLine - candidateStartLine + 1),
                },
              }
            : ADAPTIVE_MIKE_TOOL_SHAPE
              ? {
                  read: {
                    doc_id: labelById.get(documentId) ?? requested,
                    offset: start,
                    max_chars: Math.max(1, end - start),
                  },
                }
              : {}),
        };
      }),
    }),
    evidenceSegments: matches.hits.map((hit) => ({
      documentId,
      versionId: document.versionId,
      filename: document.filename,
      projection: "canonical",
      kind: "candidate" as const,
      start: Math.max(0, hit.at - contextChars),
      end: Math.min(
        document.text.length,
        hit.at + hit.excerpt.length + contextChars,
      ),
    })),
  };
}

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
  legalEvidenceState?: LegalEvidenceTurnState,
  turnEditState?: LocalAssistantEditTurnState,
  turnReadState?: LocalAssistantReadTurnState,
  workingSets?: LocalAssistantWorkingSetTurnState,
): Promise<NormalizedToolResult[]> {
  const publicState = publicLegalState ?? createPublicLegalSourceState();
  let editTail: Promise<unknown> = Promise.resolve();
  let workingSetTail: Promise<unknown> = Promise.resolve();
  let wholeReadTail: Promise<unknown> = Promise.resolve();
  return Promise.all(
    calls.map((call) => {
      const execute = async () => {
      let args = call.input;

      if (CODING_TOOL_SHAPE) {
        const resolved = await resolveCodingDocumentReferences(
          userId,
          args,
          allowedDocumentIds,
        );
        if (resolved.error) return fail(call, resolved.error);
        args = resolved.input;
      }

      if (LEAN_BATCH_FAMILY_TOOL_SHAPE && call.name === "Read") {
        const paths = stringArray(args.paths);
        if (!paths.length) return fail(call, "paths must name at least one document");
        const bounded = args.offset !== undefined || args.limit !== undefined;
        if (bounded && paths.length !== 1) {
          return fail(
            call,
            "A bounded Read accepts exactly one path; omit offset and limit to read a batch completely.",
          );
        }
        if (!bounded) {
          const upstream = await runUpstreamMikeRetrievalCall({
            call: {
              ...call,
              name: "fetch_documents",
              input: { doc_ids: paths },
            },
            userId,
            allowedDocumentIds,
            readState: turnReadState,
            citationReminders: false,
          });
          if (upstream) return upstream;
        }
        args = { ...args, file_path: paths[0] };
      }

      if (ORIGIN_MIKE_TOOL_SHAPE || call.name === "fetch_documents") {
        const upstream = await runUpstreamMikeRetrievalCall({
          call,
          userId,
          allowedDocumentIds,
          readState: turnReadState,
          wholeReadMaxChars:
            call.name === "fetch_documents" ? WHOLE_READ_MAX_CHARS : 0,
        });
        if (upstream) return upstream;
      }

      if (call.name === "describe_tools") {
        const deferredTools = partitionTools(LOCAL_ASSISTANT_TOOLS).deferred;
        const availableDomains = domainEntriesForTools(deferredTools).map(
          ([name]) => name,
        );
        const domains = stringArray(args.domains).filter(
          (domain) => availableDomains.includes(domain),
        );
        if (!domains.length) {
          return fail(
            call,
            `domains must name at least one of: ${availableDomains.join(", ")}`,
          );
        }
        const opened = toolsForDomains(
          deferredTools,
          domains,
        );
        // Prose travels with its domain: the research instructions explain
        // tools that were not loaded, so they arrive with them rather than
        // being paid for on every turn of every session.
        const guidance = domains
          .map((domain) => DOMAIN_PROMPTS[domain])
          .filter(Boolean)
          .join("\n\n");
        return result(call, {
          ok: true,
          domains,
          ...(guidance ? { guidance } : {}),
          // The host adds trusted schemas out of band. The transcript needs
          // names and guidance, not a duplicate copy of every schema.
          opened: opened.map((entry) => entry.function.name),
        });
      }
      if (call.name === LEGAL_EVIDENCE_PLAN_TOOL_NAME) {
        const planned = legalEvidenceState
          ? planLegalEvidence(args, legalEvidenceState)
          : { ok: false, errors: ["Legal evidence state is unavailable"] };
        return result(call, planned);
      }
      if (call.name === LEGAL_EVIDENCE_TOOL_NAME) {
        const submitted = legalEvidenceState
          ? submitLegalEvidenceAnswer(args, legalEvidenceState)
          : { ok: false, errors: ["Legal evidence state is unavailable"] };
        return {
          ...result(call, submitted),
          terminal: submitted.terminal === true,
        };
      }
      if (
        CODING_TOOL_SHAPE &&
        (call.name === "Glob" ||
          call.name === "Grep" ||
          call.name === "Read" ||
          (RETRIEVAL_EXPERIMENT_TOOLS.some(
            (entry) => entry.function.name === call.name,
          )) ||
          call.name === "Edit")
      ) {
        return runCodingShapeCall(
          call,
          args,
          userId,
          allowedDocumentIds,
          turnEditState,
          workingSets,
        );
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
      if (publicLegalResult) {
        return {
          ...result(call, publicLegalResult),
          evidenceRefs: publicLegalEvidenceRefs(publicLegalResult),
        };
      }
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
  if (call.name === "legal_pdf_lookup") {
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
      if (
        call.name === "library_create_docx" ||
        (ORIGIN_MIKE_TOOL_SHAPE && call.name === "generate_docx")
      ) {
        const title = trimmed(args.title);
        const filename = trimmed(args.filename);
        const markdown =
          call.name === "generate_docx"
            ? COMPACT_AUTHOR_MIKE_TOOL_SHAPE ||
              LEAN_BATCH_FAMILY_TOOL_SHAPE ||
              MARKDOWN_SWAP_MIKE_TOOL_SHAPE ||
              MARKDOWN_E2E_MIKE_TOOL_SHAPE
              ? trimmed(args.markdown)
              : upstreamMikeSectionsMarkdown(args.sections)
            : trimmed(args.markdown);
        if (!title || title.length > 256 || !markdown) {
          return fail(call, "DOCX title or Markdown is invalid");
        }
        if (
          filename &&
          (filename.length > 200 ||
            !filename.toLocaleLowerCase().endsWith(".docx") ||
            /[\\/:*?"<>|\u0000-\u001f]/u.test(filename))
        ) {
          return fail(call, "DOCX filename must be a plain .docx filename");
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
            filename: filename || rendered.filename,
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
          const diagnostics = LEGAL_GREP_EXPERIMENT
            ? await compilerDiagnostics(
                userId,
                document.id,
                document.current_version_id,
              )
            : null;
          const downloadUrl =
            `/single-documents/${encodeURIComponent(document.id)}/file` +
            `?version_id=${encodeURIComponent(document.current_version_id)}`;
          const receipt = {
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
            ...(diagnostics ? { compiler_diagnostics: diagnostics } : {}),
            download_url: downloadUrl,
          };
          if (ORIGIN_MIKE_TOOL_SHAPE && call.name === "generate_docx") {
            const docLabel = `doc-${Math.max(
              0,
              [...(allowedDocumentIds ?? [])].indexOf(document.id),
            )}`;
            return {
              ...result(call, {
                filename: document.filename,
                document_id: document.id,
                version_id: document.current_version_id,
                version_number: document.active_version_number,
                message: `Document '${document.filename}' has been generated successfully.`,
                doc_id: docLabel,
                next_required_action: [
                  `Before writing your final response, call read_document with doc_id "${docLabel}".`,
                  "Base your description on the generated document's actual returned text, not on memory of what you intended to generate.",
                  "Do not include download links, URLs, or markdown links to the document in your prose response; the document card is shown automatically by the UI.",
                  `Give a concise description of the generated document and, if you make factual claims about its contents, cite it with [N] markers and a final <CITATIONS> block using doc_id "${docLabel}", not any source/template document.`,
                ].join(" "),
              }),
              mutationReceipt: JSON.stringify(receipt),
            };
          }
          return result(call, receipt);
        } catch {
          return fail(call, "DOCX creation failed");
        }
      }

      if (call.name === "library_revise_docx") {
        return runLocalReviseDocx(
          call,
          userId,
          documentId,
          args,
          turnEditState,
        );
      }

      if (call.name === "library_delete_and_renumber_docx") {
        let versionId = trimmed(args.version_id);
        const target = trimmed(args.target);
        if (!documentId || !target) {
          return fail(call, "document_id and target are required");
        }
        const turnVersion = turnEditState?.get(documentId);
        if (turnVersion) {
          if (
            versionId &&
            versionId !== turnVersion.versionId &&
            versionId !== turnVersion.parentVersionId
          ) {
            return fail(call, "version_id is not the active turn version");
          }
          versionId = turnVersion.versionId;
        }
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
            return fail(call, "Renumbering requires a DOCX Library version");
          }

          const bytes = await readFile(file.path);
          const body = await extractDocxBodyStructure(bytes);
          if (!body.text) {
            return fail(call, "DOCX body text could not be extracted");
          }
          const plan = deleteProvisionAndRenumberSiblings(body.text, target);
          if (plan.failures.length) {
            return result(call, {
              ok: false,
              error: "Delete-and-renumber refused; the document is unchanged",
              document_id: documentId,
              version_id: file.version.id,
              source_sha256: file.version.source_sha256,
              target,
              mapping: plan.mapping,
              failures: plan.failures,
            });
          }
          const edits = trackedEditsForRenumberPlan(body.text, plan.applied);
          if (typeof edits === "string") return fail(call, edits);
          const edited = await applyTrackedEdits(bytes, edits, {
            author: "Beaver",
          });
          if (edited.errors.length || !edited.changes.length) {
            return result(call, {
              ok: false,
              error: "Delete-and-renumber could not be represented as tracked changes; the document is unchanged",
              edit_errors: edited.errors,
            });
          }
          const acceptedText = await extractDocxBodyText(edited.bytes);
          const actualComparable = comparableAcceptedText(acceptedText);
          const expectedComparable = comparableAcceptedText(plan.text);
          if (actualComparable !== expectedComparable) {
            let mismatch = 0;
            while (
              mismatch < actualComparable.length &&
              actualComparable[mismatch] === expectedComparable[mismatch]
            ) {
              mismatch += 1;
            }
            return result(call, {
              ok: false,
              error:
                "Tracked-change verification disagreed with the renumber plan; the document is unchanged",
              mismatch_at: mismatch,
              expected_excerpt: expectedComparable.slice(
                Math.max(0, mismatch - 80),
                mismatch + 160,
              ),
              actual_excerpt: actualComparable.slice(
                Math.max(0, mismatch - 80),
                mismatch + 160,
              ),
              tracked_changes: edited.changes.map((change) => ({
                deleted: change.deletedText,
                inserted: change.insertedText,
              })),
            });
          }

          const trackedEdits: LocalTrackedEdit[] = edited.changes.map(
            (change) => ({
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
            }),
          );
          const committed = await commitLocalAssistantTurnVersion({
            userId,
            documentId,
            sourceVersionId: file.version.id,
            filename: file.version.filename,
            bytes: edited.bytes,
            trackedEdits,
            turnEditState,
          });
          if (!committed) {
            return fail(call, "version_id is no longer active");
          }
          const { version, parentVersionId } = committed;
          const downloadUrl =
            `/single-documents/${encodeURIComponent(documentId)}/file` +
            `?version_id=${encodeURIComponent(version.id)}`;
          return result(call, {
            ok: true,
            receipt: "mike-document:v1",
            operation_receipt: "mike-delete-and-renumber:v1",
            action: "revised",
            document_id: documentId,
            parent_version_id: parentVersionId,
            input_source_sha256: file.version.source_sha256,
            version_id: version.id,
            version_number: version.version_number,
            filename: version.filename,
            file_type: version.file_type,
            source_sha256: version.source_sha256,
            target,
            mapping: plan.mapping,
            verification: plan.verification,
            plan_sha256: sha256(JSON.stringify(plan.applied)),
            splices: plan.applied.map((receipt) => ({
              kind: receipt.kind,
              start: receipt.start,
              end: receipt.end,
              from: receipt.from,
              to: receipt.to,
              removed_sha256: sha256(receipt.removed),
              inserted: receipt.inserted,
            })),
            change_count: trackedEdits.length,
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
              deleted_text:
                edit.deletedText.length > 500
                  ? `${edit.deletedText.slice(0, 500)}…`
                  : edit.deletedText,
              inserted_text: edit.insertedText,
              reason: edit.reason,
              status: edit.status,
            })),
          });
        } catch (error) {
          return fail(
            call,
            errorText(error, "Delete-and-renumber failed"),
          );
        }
      }

      if (call.name === "library_apply_text_ops") {
        let versionId = trimmed(args.version_id);
        if (!documentId) return fail(call, "document_id is required");
        const turnVersion = turnEditState?.get(documentId);
        if (turnVersion) {
          if (
            versionId &&
            versionId !== turnVersion.versionId &&
            versionId !== turnVersion.parentVersionId
          ) {
            return fail(call, "version_id is not the active turn version");
          }
          versionId = turnVersion.versionId;
        }
        const blockInsert = parseInsertBlocksRequest(args.ops);
        if (typeof blockInsert === "string") return fail(call, blockInsert);
        const requests = blockInsert ? [] : parseTextOpRequests(args.ops);
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
          const bytes = await readFile(file.path);
          // Addresses resolve against the PINNED version's own text, on the
          // same plane the writer uses (extractDocxBodyStructure, no fallback),
          // so an offset that named a clause for reading names it for
          // editing. Resolution happens here rather than inside the op
          // engine, which needs offsets and not a skeleton.
          const addressed = requests.some(
            (request) => (request.scope as { kind: string }).kind === "at",
          );
          let resolvedRequests = requests;
          if (addressed) {
            const body = await extractDocxBodyStructure(bytes);
            const docText = body.text;
            if (!docText) {
              return fail(
                call,
                "DOCX body text could not be extracted, so an `at` scope cannot be resolved. Report the file rather than editing from partial text.",
              );
            }
            const skeleton = compileAgreementSkeleton(docText, documentId, {
              tableCells: body.tableCells,
            });
            const map = pageMapFromMarkers(docText);
            const spansFor = (
              scope: { at: string; follow?: string; depth?: number },
            ): { start: number; end: number }[] | string => {
              const address = parseAddress(scope.at);
              if (!address) return `scope.at '${scope.at}' is not an address`;
              if (address.kind === "offset") {
                return `scope.at '${scope.at}' is a raw offset; edits scope to a provision or a page, never a bare offset`;
              }
              if (address.kind === "page") {
                const lookup = resolvePage(map, docText, address.spec);
                if (lookup.status !== "found") {
                  return `scope.at '${scope.at}' did not resolve to a page (${lookup.status})`;
                }
                return [{ start: lookup.page.start, end: lookup.page.end }];
              }
              const seed = readSection(skeleton, address.locator);
              if (seed.status !== "found" || !seed.block) {
                return `scope.at '${scope.at}' did not resolve to a provision (${seed.status})`;
              }
              const follow = (scope.follow ?? "none") as FollowDirection;
              if (follow === "none") {
                return [{ start: seed.block.start, end: seed.block.end }];
              }
              const walked = graphScope(
                skeleton,
                crossReferenceGraph(docText, documentId, { skeleton }),
                seed.block.label,
                { follow, depth: scope.depth ?? 1 },
              );
              if (!walked) return `scope.at '${scope.at}' is not a skeleton node`;
              return walked.nodes.map((node) => ({
                start: node.start,
                end: node.end,
              }));
            };
            const mapped: typeof requests = [];
            for (const [index, request] of requests.entries()) {
              const scope = request.scope as unknown as {
                kind: string;
                at: string;
                follow?: string;
                depth?: number;
              };
              if (scope.kind !== "at") {
                mapped.push(request);
                continue;
              }
              const spans = spansFor(scope);
              if (typeof spans === "string") {
                return fail(call, `ops[${index}].${spans}`);
              }
              mapped.push({ ...request, scope: { kind: "spans", spans } });
            }
            resolvedRequests = mapped;
          }
          const applied = blockInsert
            ? await insertTrackedBlocks(bytes, blockInsert, { author: "Beaver" }).then(
                (inserted) => ({
                  bytes: inserted.bytes,
                  edits: inserted.changes.map((change) => ({
                    changeId: change.id,
                    delWId: change.delId,
                    insWId: change.insId,
                    deletedText: change.deletedText,
                    insertedText: change.insertedText,
                    contextBefore: change.contextBefore,
                    contextAfter: change.contextAfter,
                  })),
                  reports: [
                    {
                      op: "insert_blocks",
                      replacements: inserted.changes.length,
                      notes: [],
                    },
                  ],
                  replacementCount: inserted.changes.length,
                  editErrors: inserted.errors.map(
                    (error) => `change ${error.index + 1}: ${error.reason}`,
                  ),
                }),
              )
            : await applyTextOpsToDocx(bytes, resolvedRequests);
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
          const reason = blockInsert
            ? "insert_blocks"
            : requests
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
          const committed = await commitLocalAssistantTurnVersion({
            userId,
            documentId,
            filename: file.version.filename,
            bytes: applied.bytes,
            sourceVersionId: file.version.id,
            trackedEdits,
            turnEditState,
          });
          if (!committed) return fail(call, "version_id is no longer active");
          const { version, parentVersionId } = committed;
          const downloadUrl =
            `/single-documents/${encodeURIComponent(documentId)}/file` +
            `?version_id=${encodeURIComponent(version.id)}`;
          return result(call, {
            ok: true,
            receipt: "mike-document:v1",
            action: "revised",
            document_id: documentId,
            parent_version_id: parentVersionId,
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
        const projectionMode = trimmed(args.mode);
        if (
          call.name === "library_read" &&
          (projectionMode === "drafting" || projectionMode === "redline") &&
          (trimmed(args.at) ||
            trimmed(args.from) === "end" ||
            (trimmed(args.follow) && trimmed(args.follow) !== "none"))
        ) {
          return fail(
            call,
            `mode=${projectionMode} is a whole-document projection and cannot be combined with at, from=end, or follow. Use mode=text for addressed navigation.`,
          );
        }
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
        if (call.name === "library_read" && args.mode === "redline") {
          try {
            const projection = await extractLocalRedlineDocument(
              userId,
              documentId,
            );
            return projection
              ? result(call, { ok: true, ...projection })
              : fail(call, "Document not found");
          } catch (error) {
            return fail(
              call,
              errorText(error, "Redline view could not be read"),
            );
          }
        }
        const document = await extractLocalDocument(userId, documentId);
        if (!document) return fail(call, "Document not found");
        if (call.name === "library_read") {
          // One address grammar, with the three original parameters still
          // honoured so nothing calling the old shape breaks.
          // Arm isolation is enforced HERE as well as in the schema: an arm
          // must not be able to use the other arm's vocabulary even if a
          // parameter reaches it, or the comparison leaks through the
          // handler while the tool list looks clean.
          const addressArm = NAV_TOOL_SHAPE === "address";
          const address = addressArm ? parseAddress(trimmed(args.at)) : null;
          const followRequested = trimmed(args.follow);
          if (
            addressArm &&
            followRequested &&
            followRequested !== "none" &&
            address?.kind !== "section"
          ) {
            return fail(
              call,
              "follow and depth require a structural at address; page, offset, and omitted addresses cannot be graph-followed",
            );
          }
          const sectionLocator = addressArm
            ? address?.kind === "section"
              ? address.locator
              : ""
            : trimmed(args.section);
          const fromEnd = addressArm && trimmed(args.from) === "end";
          /**
           * head/tail over any addressed span. Reading the END of a span is
           * not a convenience: execution pages, schedules and the closing
           * words of a clause are at the end, and reaching them by offset
           * arithmetic costs a length probe and gets it wrong on a span
           * whose length the caller cannot see.
           */
          const windowOf = (body: string, maxChars: number) => {
            if (body.length <= maxChars) {
              return { body, cut: false, at: 0 };
            }
            return fromEnd
              ? { body: body.slice(body.length - maxChars), cut: true, at: body.length - maxChars }
              : { body: body.slice(0, maxChars), cut: true, at: 0 };
          };
          if (sectionLocator) {
            const skeleton = await documentStructure(document.text, documentId, {
              tableCells: document.tableCells,
            });
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
            const maxChars = clampInt(args.max_chars, 200, 300_000, 60_000);
            const view = windowOf(lookup.block.text, maxChars);
            // follow expands the ADDRESS, so it belongs here as much as on
            // find: "read this clause and what it depends on" is one request,
            // not a read followed by a graph walk the caller has to stitch.
            const readFollow = (
              addressArm ? trimmed(args.follow) || "none" : "none"
            ) as FollowDirection;
            let related: Array<{
              section: string;
              display: string;
              text: string;
              start: number;
              end: number;
            }> = [];
            if (readFollow !== "none") {
              const walked = graphScope(
                skeleton,
                await documentGraph(document.text, documentId, skeleton, {
                  tableCells: document.tableCells,
                }),
                lookup.block.label,
                { follow: readFollow, depth: clampInt(args.depth, 1, 3, 1) },
              );
              // One shared budget: following must not multiply what a read
              // costs by the size of the neighbourhood.
              let budget = Math.max(0, maxChars - view.body.length);
              for (const node of walked?.nodes ?? []) {
                if (node.label === lookup.block.label || budget <= 0) continue;
                const body = document.text.slice(node.start, node.end).slice(0, budget);
                budget -= body.length;
                related.push({
                  section: node.label,
                  display: node.display,
                  text: body,
                  start: node.start,
                  end: node.start + body.length,
                });
              }
            }
            const relatedForModel = related.map(
              ({ start: _start, end: _end, ...item }) => item,
            );
            return {
              ...result(call, {
              ok: true,
              filename: document.filename,
              ...(document.cautions.length
                ? { notes_of_caution: document.cautions }
                : {}),
              section: lookup.block.label,
              parent: lookup.block.parentLabel,
              ...(fromEnd && view.cut ? { read_from: "end" } : {}),
              text: view.body,
              ...(relatedForModel.length ? { related: relatedForModel } : {}),
              ...(readFollow !== "none" && !related.length
                ? { related_note: "No resolved cross-references in that direction." }
                : {}),
              truncated: view.cut,
              ...(view.cut
                ? {
                    continuation: fromEnd
                      ? `Section head omitted; call library_read with at="${lookup.block.label}" for the start.`
                      : `Section continues; call library_read with at="off:${lookup.block.start + maxChars}" for the rest, or from="end" for its tail.`,
                  }
                : {}),
              }),
              evidenceSegments: [
                {
                  documentId,
                  versionId: document.versionId,
                  filename: document.filename,
                  locator: lookup.block.label,
                  projection: "canonical",
                  kind: "evidence" as const,
                  start: lookup.block.start + view.at,
                  end: lookup.block.start + view.at + view.body.length,
                },
                ...related.map((item) => ({
                  documentId,
                  versionId: document.versionId,
                  filename: document.filename,
                  locator: item.section,
                  projection: "canonical",
                  kind: "evidence" as const,
                  start: item.start,
                  end: item.end,
                })),
              ],
            };
          }
          // Page address. The point of pagination here is that a contents
          // page cites it: the reply carries the section handles printed on
          // the page so the next call can be a structural read, which is the
          // address that survives re-pagination.
          const pageRequest =
            addressArm && address?.kind === "page" ? address.spec : "";
          if (pageRequest) {
            const lookup = resolvePage(
              document.pages,
              document.text,
              pageRequest,
            );
            if (lookup.status === "no_pages") {
              return result(call, {
                ok: false,
                error:
                  document.pages.source === "unindexed"
                    ? 'This PDF has pages, but no page index could be built for it — the engine returned no page records for this file. Use at="<provision>" for a provision or at="off:<offset>" for a window, and treat any page number in the text as unverified.'
                    : 'This document has no fixed pagination (a DOCX is not paginated until something renders it). Use at="<provision>" for a provision or at="off:<offset>" for a window.',
              });
            }
            if (lookup.status === "not_found") {
              return result(call, {
                ok: false,
                error:
                  `No ${lookup.sense === "pdf" ? "PDF page" : "printed page"} '${lookup.requested}'. This document has ${lookup.count} pages, ${lookup.first} through ${lookup.last}.`,
              });
            }
            const maxChars = clampInt(args.max_chars, 200, 300_000, 24_000);
            const pageView = windowOf(lookup.text, maxChars);
            const pageBody = pageView.body;
            const pageCut = pageView.cut;
            const onPage = pageSections(
              await documentStructure(document.text, documentId, {
                tableCells: document.tableCells,
              }),
              lookup.page,
            );
            return {
              ...result(call, {
              ok: true,
              filename: document.filename,
              ...(document.cautions.length
                ? { notes_of_caution: document.cautions }
                : {}),
              page: pageLabel(lookup.page),
              pdf_page: lookup.page.pdfPage,
              printed_label: lookup.page.printedLabel,
              matched_on: lookup.matchedOn,
              sections: onPage.starts
                .slice(0, 24)
                .map((node) => ({ section: node.label, display: node.display })),
              ...(onPage.starts.length > 24 ? { sections_truncated: true } : {}),
              ...(onPage.continuedFrom.length
                ? {
                    continued_from: onPage.continuedFrom[0].label,
                  }
                : {}),
              text: pageBody,
              truncated: pageCut,
              ...(pageCut
                ? {
                    continuation: `Page continues; call library_read with at="off:${lookup.page.start + pageBody.length}", or read one of the listed sections.`,
                  }
                : {}),
              }),
              evidenceSegments: [
                {
                  documentId,
                  versionId: document.versionId,
                  filename: document.filename,
                  locator: pageLabel(lookup.page),
                  projection: "canonical",
                  kind: "evidence" as const,
                  start: lookup.page.start + pageView.at,
                  end: lookup.page.start + pageView.at + pageBody.length,
                },
              ],
            };
          }
          // Windowed read: offset composes with library_find's `at` for
          // documents without numbered structure. Untargeted reads keep the
          // historical 300k head.
          const offset = clampInt(
            addressArm
              ? address?.kind === "offset"
                ? address.start
                : 0
              : args.offset,
            0,
            100_000_000,
            0,
          );
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
          // from="end" on an unaddressed read is `tail` over the whole
          // document, which is how a caller reaches an execution page
          // without first asking how long the document is.
          const start = fromEnd
            ? Math.max(offset, document.text.length - maxChars)
            : offset;
          const window = document.text.slice(start, start + maxChars);
          const windowCut = start + window.length < document.text.length;
          /**
           * CAPABILITY ON CONTACT. The schema can only advertise addressing
           * in the abstract, identically for a paginated PDF and a DOCX with
           * no pages at all. The document itself knows. On the opening read
           * — the moment of contact — say what THIS document affords, so the
           * model asks for things that exist instead of guessing from a
           * generic description.
           *
           * Only on the opening read: it costs a skeleton compile, and
           * repeating it on every windowed read would pay that per turn for
           * information that has not changed.
           */
          const opening = addressArm && start === 0;
          let affords: Record<string, unknown> | null = null;
          if (opening) {
            const skeletonNow = await documentStructure(
              document.text,
              documentId,
              { tableCells: document.tableCells },
            );
            const schemes = pageSchemes(document.pages);
            const sections = skeletonNow.nodes.filter(
              (node) =>
                node.kind !== "subsection" &&
                node.kind !== "table" &&
                node.kind !== "row" &&
                node.kind !== "cell",
            ).length;
            const tables = skeletonNow.nodes.filter(
              (node) => node.kind === "table",
            ).length;
            const cells = skeletonNow.nodes.filter(
              (node) => node.kind === "cell",
            ).length;
            affords = {
              ...(sections ? { sections } : {}),
              ...(tables ? { tables, cells } : {}),
              ...(document.pages.pages.length
                ? {
                    pages: document.pages.pages.length,
                    page_addresses: [
                      ...(schemes.pdfPages ? ["pdf"] : []),
                      ...(schemes.printedLabels ? ["printed"] : []),
                    ],
                  }
                : { pages: 0, pages_note: document.pages.source }),
              ...(skeletonNow.crossReferences.internal
                ? { cross_references: skeletonNow.crossReferences.internal }
                : {}),
              ...(skeletonNow.outline?.entries?.length
                ? { contents_outline: skeletonNow.outline.entries.length }
                : {}),
              ...(sections || tables
                ? {}
                : {
                    note: "No numbered structure detected; address by page or offset, or search.",
                  }),
            };
          }
          return {
            ...result(call, {
            ok: true,
            filename: document.filename,
            ...(document.cautions.length
              ? { notes_of_caution: document.cautions }
              : {}),
            ...(start > 0 ? { offset: start } : {}),
            ...(affords ? { addressable: affords } : {}),
            text: window,
            truncated: windowCut,
            ...(windowCut
              ? {
                  continuation: `Document continues (${document.text.length.toLocaleString("en-CA")} chars total); call library_read with at="off:${start + window.length}" to keep reading, from="end" for the tail, or library_outline / library_find to target a section.`,
                }
              : {}),
            }),
            evidenceSegments: window.length
              ? [
                  {
                    documentId,
                    versionId: document.versionId,
                    filename: document.filename,
                    locator: start
                      ? `window beginning at ${start}`
                      : "opening window",
                    projection: "canonical",
                    kind: "evidence" as const,
                    start,
                    end: start + window.length,
                  },
                ]
              : [],
          };
        }
        // Page-scoped search. The filter runs on OFFSETS after the match, so
        // every `at` stays a document offset that library_read offset=
        // accepts; scoping must narrow where you look, never renumber what
        // you find. The internal cap is raised first, because applying
        // max_results before the filter would return nothing whenever the
        // first hits all sit outside the scope.
        const findArm = NAV_TOOL_SHAPE === "address";
        const findAddress = findArm ? parseAddress(trimmed(args.at)) : null;
        if (findArm && findAddress?.kind === "offset") {
          return fail(
            call,
            "library_find does not accept offset at addresses; use a structural or page at address, or omit at to search the whole document",
          );
        }
        const findFollowRequested = trimmed(args.follow);
        if (
          findArm &&
          findFollowRequested &&
          findFollowRequested !== "none" &&
          findAddress?.kind !== "section"
        ) {
          return fail(
            call,
            "follow and depth require a structural at address; page and omitted addresses cannot be graph-followed",
          );
        }
        const pageSpec =
          findArm && findAddress?.kind === "page" ? findAddress.spec : "";
        let scope: PageSpan[] | null = null;
        if (pageSpec) {
          const selection = selectPages(document.pages, document.text, pageSpec);
          if (selection.status === "empty") {
            return fail(call, "The at page range was empty");
          }
          if (selection.status === "failed") {
            const lookup = selection.lookup;
            return result(call, {
              ok: false,
              error:
                lookup.status === "no_pages"
                  ? document.pages.source === "unindexed"
                    ? "This PDF has pages, but no page index could be built for it; omit at to search the whole document."
                    : "This document has no fixed pagination; omit at to search the whole document."
                  : `Page '${selection.token}' not found. This document has ${lookup.status === "not_found" ? lookup.count : 0} pages, ${lookup.status === "not_found" ? lookup.first : "?"} through ${lookup.status === "not_found" ? lookup.last : "?"}.`,
            });
          }
          scope = selection.pages;
        }
        // Structural scope, composed with the page scope by INTERSECTION:
        // two filters both given read as "in these pages AND in this part of
        // the document", which is the only reading under which asking for
        // more narrowing does not widen the result.
        const seedLocator =
          findArm && findAddress?.kind === "section" ? findAddress.locator : "";
        let structural: { label: string; start: number; end: number }[] | null =
          null;
        let followed: { follow: string; depth: number; nodes: number } | null =
          null;
        if (seedLocator) {
          const skeletonForScope = await documentStructure(
            document.text,
            documentId,
            { tableCells: document.tableCells },
          );
          const seed = readSection(skeletonForScope, seedLocator);
          if (seed.status !== "found" || !seed.block) {
            return result(call, {
              ok: false,
              error:
                `Section '${seedLocator}' not found (${seed.status}` +
                (seed.matches.length
                  ? `; candidates: ${seed.matches.join(", ")}`
                  : "") +
                "). Call library_outline for the available handles.",
            });
          }
          const follow = (
            findArm ? trimmed(args.follow) || "none" : "none"
          ) as FollowDirection;
          // The graph is only compiled when it is actually going to be
          // walked; a plain section scope costs a skeleton and nothing more.
          const walked =
            follow === "none"
              ? null
              : graphScope(
                  skeletonForScope,
                  await documentGraph(
                    document.text,
                    documentId,
                    skeletonForScope,
                    { tableCells: document.tableCells },
                  ),
                  seed.block.label,
                  { follow, depth: clampInt(args.depth, 1, 3, 1) },
                );
          const scoped = walked?.nodes ?? [
            skeletonForScope.nodes.find(
              (node) => node.label === seed.block!.label,
            ),
          ];
          structural = scoped
            .filter((node): node is NonNullable<typeof node> => Boolean(node))
            .map((node) => ({
              label: node.label,
              start: node.start,
              end: node.end,
            }));
          if (!structural.length) {
            // readSection resolved a SourceDoc block that no skeleton node
            // backs — report it rather than searching the whole document.
            return result(call, {
              ok: false,
              error: `Section '${seedLocator}' resolved to '${seed.block.label}', which is not a skeleton node.`,
            });
          }
          followed = {
            follow,
            depth: walked?.depth ?? 0,
            nodes: structural.length,
          };
        }
        const query = trimmed(args.query);
        const matches =
          args.regex === true
            ? findRegexMatches({
                text: document.text,
                pattern: query,
                maxResults: scope || seedLocator ? 500 : clampInt(args.max_results, 1, 50, 20),
                contextChars: clampInt(args.context_chars, 40, 2000, 500),
                caseInsensitive: args.case_insensitive === true,
              })
            : findTextMatches({
                text: document.text,
                query,
                maxResults: scope || seedLocator ? 500 : clampInt(args.max_results, 1, 50, 20),
                contextChars: clampInt(args.context_chars, 40, 2000, 500),
              });
        if ("error" in matches) return fail(call, matches.error);
        // The grep-analog composes like file:line does for code: each hit
        // carries its offset plus the deepest enclosing structural handle,
        // so the follow-up is a section read, not a whole-document read.
        const skeleton = await documentStructure(document.text, documentId, {
          tableCells: document.tableCells,
        });
        const filtered = matches.hits.filter(
          (hit) =>
            (!scope ||
              scope.some((page) => page.start <= hit.at && hit.at < page.end)) &&
            (!structural ||
              structural.some((span) => span.start <= hit.at && hit.at < span.end)),
        );
        const cap = clampInt(args.max_results, 1, 50, 20);
        const narrowed = Boolean(scope || structural);
        const inScope = filtered;
        const kept = narrowed ? inScope.slice(0, cap) : inScope;
        const hits = kept.map((hit) => {
          const owner = skeleton.nodes
            .filter((node) => node.start <= hit.at && hit.at < node.end)
            .sort((a, b) => b.depth - a.depth)[0];
          const page = document.pages.pages.length
            ? pageAt(document.pages, hit.at)
            : null;
          // `at` is a character offset here and an ADDRESS on library_read.
          // In the address arm that collision is a trap — at="12345" parses
          // as a structural locator, not an offset — so the address arm
          // hands back something directly passable instead.
          return {
            ...hit,
            ...(NAV_TOOL_SHAPE === "address"
              ? { at: `off:${hit.at}`, offset: hit.at }
              : {}),
            section: owner?.label ?? null,
            ...(page ? { page: pageLabel(page) } : {}),
          };
        });
        return result(call, {
          ok: true,
          filename: document.filename,
          ...(document.cautions.length
            ? { notes_of_caution: document.cautions }
            : {}),
          query,
          totalMatches: matches.totalMatches,
          ...(narrowed
            ? {
                ...(scope ? { pages_searched: scope.length } : {}),
                ...(followed
                  ? {
                      sections_searched: followed.nodes,
                      ...(followed.follow !== "none"
                        ? { followed: followed.follow, hops: followed.depth }
                        : {}),
                    }
                  : {}),
                matches_in_scope: inScope.length,
                ...(inScope.length > kept.length ? { truncated: true } : {}),
              }
            : {}),
          hits,
        });
      }

      if (call.name === "library_outline") {
        if (!documentId) return fail(call, "document_id is required");
        const document = await extractLocalDocument(userId, documentId);
        if (!document) return fail(call, "Document not found");
        const skeleton = await documentStructure(document.text, documentId, {
          tableCells: document.tableCells,
        });
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
        // The page map rides on the orientation call, because a page number
        // is unusable until the caller knows WHICH schemes this document
        // has: whether printed labels were detected at all, and where they
        // diverge from the PDF page. Reporting it here is what lets a
        // pinpoint citation, an index entry or a contents line be followed.
        const map = document.pages;
        const schemes = pageSchemes(map);
        const divergent = map.pages.filter(
          (page) =>
            page.printedLabel !== null &&
            page.printedLabel !== String(page.pdfPage),
        );
        const tableCount = skeleton.nodes.filter(
          (node) => node.kind === "table",
        ).length;
        const cellCount = skeleton.nodes.filter(
          (node) => node.kind === "cell",
        ).length;
        return result(call, {
          ok: true,
          filename: document.filename,
          ...(document.cautions.length
            ? { notes_of_caution: document.cautions }
            : {}),
          nodes: skeleton.nodes.length,
          ...(tableCount ? { tables: tableCount, cells: cellCount } : {}),
          pages: map.pages.length
            ? {
                count: map.pages.length,
                addressable_by: [
                  ...(schemes.pdfPages ? ["pdf"] : []),
                  ...(schemes.printedLabels ? ["printed"] : []),
                ],
                first: pageLabel(map.pages[0]),
                last: pageLabel(map.pages[map.pages.length - 1]),
                ...(divergent.length
                  ? {
                      printed_differs_from_pdf: divergent.length,
                      example: pageLabel(divergent[0]),
                    }
                  : {}),
              }
            : { count: 0, reason: map.source },
          outline: renderAgreementOutline(skeleton, {
            maxChars: clampInt(args.max_chars, 1_000, 40_000, 8_000),
          }),
        });
      }

      if (call.name === "library_links") {
        if (!documentId) return fail(call, "document_id is required");
        const document = await extractLocalDocument(userId, documentId);
        if (!document) return fail(call, "Document not found");
        const linkAt = trimmed(args.at);
        const linkAddress = parseAddress(linkAt);
        if (linkAt && linkAddress?.kind !== "section") {
          return fail(
            call,
            "library_links requires a structural at address; omit at for the document-level census",
          );
        }
        const skeleton = await documentStructure(document.text, documentId, {
          tableCells: document.tableCells,
        });
        const graph = await documentGraph(
          document.text,
          documentId,
          skeleton,
          { tableCells: document.tableCells },
        );
        const cap = clampInt(args.max_results, 1, 200, 40);
        const handle = (node: { label: string; display: string }) => ({
          section: node.label,
          display: node.display,
        });
        // A whole-document abstention is a real answer, not an empty one:
        // it says the skeleton is too thin to address this numbering, so a
        // miss would carry no information. Surface it rather than returning
        // zero edges and letting the caller read that as "no references".
        const census = {
          ok: true as const,
          filename: document.filename,
          ...(document.cautions.length
            ? { notes_of_caution: document.cautions }
            : {}),
          counts: graph.counts,
          ...(graph.documentAbstained ? { abstained: true } : {}),
          ...(graph.note ? { note: graph.note } : {}),
        };

        const locator = linkAddress?.kind === "section" ? linkAddress.locator : "";
        if (!locator) {
          return result(call, {
            ...census,
            hubs: referenceHubs(graph).map((hub) => ({
              section: hub.label,
              referenced_by: hub.incoming,
            })),
          });
        }

        const lookup = readSection(skeleton, locator);
        if (lookup.status !== "found" || !lookup.block) {
          return result(call, {
            ok: false,
            error:
              `Section '${locator}' not found (${lookup.status}` +
              (lookup.matches.length
                ? `; candidates: ${lookup.matches.join(", ")}`
                : "") +
              "). Call library_outline for the available handles.",
          });
        }
        const around = nodeNeighbourhood(skeleton, lookup.block.label);
        if (!around) {
          return result(call, {
            ok: false,
            error: `Section '${locator}' resolved to '${lookup.block.label}', which is not a skeleton node.`,
          });
        }
        const links = nodeLinks(graph, around.node.label);
        return result(call, {
          ...census,
          section: around.node.label,
          display: around.node.display,
          ...(around.node.heading ? { heading: around.node.heading } : {}),
          ancestors: around.ancestors.map(handle),
          siblings: around.siblings.slice(0, cap).map(handle),
          ...(around.siblings.length > cap ? { siblings_truncated: true } : {}),
          children: around.children.slice(0, cap).map(handle),
          ...(around.children.length > cap ? { children_truncated: true } : {}),
          references_out: links.outgoing.slice(0, cap).map((edge) => ({
            reference: edge.raw.replace(/\s+/gu, " ").trim(),
            target: edge.targetLabel,
            status: edge.status,
            ...(edge.reason ? { reason: edge.reason } : {}),
            at: edge.sourceStart,
          })),
          ...(links.outgoing.length > cap
            ? { references_out_truncated: true }
            : {}),
          references_in: links.incoming.slice(0, cap).map((edge) => ({
            from: edge.sourceLabel,
            reference: edge.raw.replace(/\s+/gu, " ").trim(),
            at: edge.sourceStart,
          })),
          ...(links.incoming.length > cap
            ? { references_in_truncated: true }
            : {}),
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
        await parseLocalPdfOnDemand({
          documentId,
          versionId: file.version.id,
          sourcePath: file.path,
          sourceSha256: file.version.source_sha256,
        });
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
        return {
          ...result(call, compactPdfLookup(file.version.filename, lookup)),
          evidenceRefs: pdfEvidenceRefs(file.version.filename, lookup),
        };
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
          return {
            ...result(call, compactPdfLookup(file.version.filename, lookup)),
            evidenceRefs: pdfEvidenceRefs(file.version.filename, lookup),
          };
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
              turnEditState,
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
          if (!file) return fail(call, "Library version not found");
          if (!["docx", "pdf"].includes(file.fileType.toLowerCase())) {
            return fail(
              call,
              "Table of Authorities requires a Word or PDF Library version",
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
      if (citator) {
        if (legalEvidenceState) {
          for (const evidence of citator.evidences ?? []) {
            registerLegalEvidence(legalEvidenceState, evidence);
          }
        }
        return {
          ...result(call, citator.payload),
          evidenceRefs: receiptEvidenceRefs(citator.evidences ?? []),
        };
      }

      const compared = await executeCompareVersionsTool(userId, call.name, args);
      if (compared) return result(call, compared);

      const a2aj = await executeA2AJTool(call.name, args);
      if (a2aj) {
        if (a2aj.document?.url) a2ajDocuments?.push(a2aj.document);
        if (a2aj.lookup?.status === "found" && a2aj.lookup.block) {
          a2ajLookups?.push(a2aj.lookup);
        }
        for (const lookup of a2aj.lookups ?? []) {
          if (lookup.status === "found" && lookup.block) a2ajLookups?.push(lookup);
        }
        if (legalEvidenceState) {
          registerLegalEvidence(legalEvidenceState, a2aj.evidence, {
            document: a2aj.document,
            lookup: a2aj.lookup,
          });
          for (let index = 0; index < (a2aj.evidences?.length ?? 0); index += 1) {
            registerLegalEvidence(legalEvidenceState, a2aj.evidences?.[index], {
              lookup: a2aj.lookups?.[index],
            });
          }
        }
        return {
          ...result(call, a2aj.payload),
          evidenceRefs: receiptEvidenceRefs([
            a2aj.evidence,
            ...(a2aj.evidences ?? []),
          ]),
        };
      }

      return result(call, { ok: false, error: `Unknown tool: ${call.name}` });
      };
      if (
        call.name === "Grep" &&
        call.input.output_mode === "working_set"
      ) {
        const queued = workingSetTail.then(execute);
        workingSetTail = queued.then(
          () => undefined,
          () => undefined,
        );
        return queued;
      }
      if (
        (ORIGIN_MIKE_TOOL_SHAPE &&
          SUPPRESS_DUPLICATE_WHOLE_READS &&
          ["read_document", "fetch_documents"].includes(call.name)) ||
        (WHOLE_READ_MAX_CHARS && call.name === "fetch_documents")
      ) {
        const queued = wholeReadTail.then(execute);
        wholeReadTail = queued.then(
          () => undefined,
          () => undefined,
        );
        return queued;
      }
      if (!LOCAL_TURN_EDIT_TOOL_NAMES.has(call.name)) return execute();
      const queued = editTail.then(execute);
      editTail = queued.then(
        () => undefined,
        () => undefined,
      );
      return queued;
    }),
  );
}
