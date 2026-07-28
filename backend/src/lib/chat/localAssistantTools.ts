import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { appUrl } from "../appRoutes";
import { SYSTEM_ASSISTANT_WORKFLOWS } from "../systemWorkflows";
import type { A2AJDocument, A2AJLocatorLookup } from "../a2aj";
import { linkLocalDocxCitations } from "../docxCitationLinking";
import { fixLocalDocxSupraCrossReferences } from "../docxDeterministicCleanup";
import { lintLocalDocxStructure } from "../docxStructuralLint";
import { anchorCoverage } from "../legalTextAnchors";
import {
  compileAgreementSkeleton,
  readSection,
  renderAgreementOutline,
} from "../legalTextSkeleton";
import { extractDocxDraftingSource } from "../docxDraftingSource";
import { resolveDocxEvidenceCitations } from "../docxEvidenceCitations";
import { applyTrackedEdits, type EditInput } from "../docxTrackedChanges";
import {
  addLocalVersion,
  createLocalDocument,
  deleteLocalDocument,
  getLocalVersionFile,
  listLocalLibrary,
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
  findTextMatches,
  renderMarkdownDocx,
  textParserFor,
} from "./tools/documentOps";
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
  description: "Optional explicit Library version id. Omit for the active version.",
};

const LOCAL_LIBRARY_TOOLS: OpenAIToolSchema[] = [
  tool(
    "library_list",
    "List documents in the user's local Beaver Library with deterministic Beaver app_url fields. Use this before claiming a Library document is unavailable. Optionally filter filenames with query.",
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
    "library_read",
    "Read the active version of a document from the local Beaver Library. Use mode=drafting once when adapting a DOCX precedent; it preserves headings, lists, tables, emphasis, and note pairing for translation into semantic Markdown.",
    {
      type: "object",
      properties: {
        document_id: { type: "string" },
        mode: {
          type: "string",
          enum: ["text", "drafting"],
          description:
            "Defaults to text. Drafting is DOCX-only, version-bound, and returns bounded semantic HTML as document data.",
        },
        section: {
          type: "string",
          description:
            "Optional structural locator parsed from the document's own numbering — 'Section 8.01(b)', '8.01', 'Article VIII', 'Schedule 7.01', 's. 8(2)'. Returns only that span (children included) instead of the full text. Call library_outline first for the exact handles.",
        },
      },
      required: ["document_id"],
    },
  ),
  tool(
    "library_outline",
    "Deterministic structural map of a Library document parsed from its own numbering: the ARTICLE/PART tree, every Section and (a)/(i) subsection with the exact handle library_read's section parameter accepts, defined terms with their defining section, schedules/exhibits, and cross-reference counts. A ~100-page agreement maps to 1-3k tokens with nothing structural omitted — prefer this over reading full text when deciding what exists or planning pinpoint reads.",
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
    "Search inside a local Beaver Library document and return exact matching excerpts with surrounding context. Use this for notes, footnotes, clauses, names, and other targeted lookups.",
    {
      type: "object",
      properties: {
        document_id: { type: "string" },
        query: { type: "string" },
        max_results: { type: "integer", minimum: 1, maximum: 50 },
        context_chars: { type: "integer", minimum: 40, maximum: 2000 },
      },
      required: ["document_id", "query"],
    },
  ),
  tool(
    "library_lookup",
    "Return only an exact structural unit from a parsed local Library PDF: page/range, artifact paragraph/range, paired footnote/range with propositions, or an exactly encoded section/provision. Prefer this over library_read for pinpoint requests. It never guesses or reparses the whole document.",
    {
      type: "object",
      properties: {
        document_id: { type: "string" },
        version_id: {
          type: "string",
          description: "Optional exact Library version. Defaults to active.",
        },
        locator_kind: {
          type: "string",
          enum: [...LOCAL_PDF_LOCATOR_KINDS],
          description:
            "paragraph means parser artifact order; use provision_paragraph for an explicitly encoded legal provision.",
        },
        locator: {
          type: "string",
          description:
            "Exact start locator, pair_id, symbol note label, heading, or provider-encoded provision ID.",
        },
        end_locator: {
          type: "string",
          description:
            "Optional inclusive range end for page, paragraph, or footnote; maximum 20 units.",
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
            "Optional reference/body page to disambiguate a restarted footnote label.",
        },
        occurrence: {
          type: "integer",
          minimum: 1,
          description:
            "Optional occurrence to disambiguate a restarted footnote label.",
        },
      },
      required: ["document_id", "locator_kind", "locator"],
    },
  ),
  tool(
    "library_evidence",
    "Rehydrate a prior mike-evidence handle from its exact immutable Library PDF version. Use this after compaction or in a later turn instead of asking for the same locator again. The server verifies source, parser, artifact IDs, and text hash before returning text.",
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
    "Resolve an opaque provider PDF reference returned by a legal-source tool and return one exact parsed structural unit. If parsing is still queued, this reports that state without reading the whole PDF. To rehydrate prior exact evidence, pass its handle with the same reference_id instead of a locator.",
    {
      type: "object",
      properties: {
        reference_id: {
          type: "string",
          description:
            "Opaque mike-provider-pdf:v1 reference returned by a source tool.",
        },
        handle: {
          type: "string",
          description:
            "Optional mike-evidence:v1 handle previously returned for this exact provider PDF reference.",
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
    "Create a new version of a local Library DOCX with verified provider links on its footnote citations. This bounded workflow splits and routes the footnotes itself; do not read, split, classify, or construct citation URLs before calling it.",
    {
      type: "object",
      properties: { document_id: DOCUMENT_ID_PROPERTY },
      required: ["document_id"],
    },
  ),
  tool(
    "library_fix_docx_supras",
    "Run the deterministic first pass for a local Library DOCX: turn unambiguous plain 'supra note N' numbers into native updating Word footnote cross-references. It creates a new version when it changes anything and reports ambiguous/restarted/split cases for review. Call this before asking the model to reason through or manually rewrite supra references.",
    {
      type: "object",
      properties: { document_id: DOCUMENT_ID_PROPERTY },
      required: ["document_id"],
    },
  ),
  tool(
    "library_lint_docx_structure",
    "Run the deterministic structural lint on a local Library DOCX: broken internal cross-references, references to missing schedules/exhibits, literal numbering gaps and duplicates, and duplicate or unused defined terms. Read-only; returns verified findings with paragraph locations plus a receipt of what was checked and what was abstained from. Call this instead of asking the model to scan a document for these drafting errors.",
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
    "Deterministically diff typed anchors (money, percentages, ratio multiples, full dates, durations, statutory and case citations) between source Library documents and draft deliverables. Canonical value matching: $2.25 million equals $2,250,000 and March 15, 2027 equals 3/15/2027. source_only rows are omission candidates the drafts never state in any form; draft_only rows are grounding candidates no source contains; words-vs-numerals mismatches are drafting defects. Purely mechanical — triage the rows for task relevance before acting on them.",
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
            "Library document_ids of the draft deliverables to audit.",
        },
        max_rows_per_class: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description:
            "Cap on reported rows per anchor class and direction. Defaults to 40.",
        },
      },
      required: ["source_document_ids", "draft_document_ids"],
    },
  ),
  tool(
    "toa_submit_library_document",
    "Submit one owned DOCX Library version to the existing local Table of Authorities workflow. Detection is deterministic first and can use a bounded cached Codex splitter only for unresolved citation units. Never pass or invent filesystem paths.",
    {
      type: "object",
      properties: {
        document_id: DOCUMENT_ID_PROPERTY,
        version_id: OPTIONAL_VERSION_ID_PROPERTY,
        split_fallback: {
          type: "string",
          enum: ["off", "auto"],
          description:
            "Use auto to invoke the cached bounded Codex splitter only when deterministic citation splitting is incomplete. Defaults to auto.",
        },
      },
      required: ["document_id"],
    },
  ),
  tool(
    "toa_job_status",
    "Inspect one Table of Authorities job returned by toa_submit_library_document. Returns bounded progress, review readiness, output downloads, and the exact Beaver page to open.",
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
          description: `${schema.function.description} Store it as a durable new item in the local Library; matter chats attach it to that matter automatically.`,
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
        "Apply requested edits, revisions, or redlines to an existing local Library DOCX as tracked changes. Beaver shows the resulting document card automatically. Use this for action requests instead of replying with proposed or suggested changes in prose. Pass the exact active version_id you read; stale or non-DOCX versions fail without changing the document.",
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
                "Exact active version_id returned by library_list or a prior document receipt.",
            },
            edits: sharedProperties.edits,
            annotate: {
              type: "boolean",
              description:
                "Markup mode: render each edit's reason as an anchored Word comment on its tracked change, so the rationale is visible in the deliverable. Edits without a reason get no comment and are counted in the receipt; the new version is auto-checked by the structural lint.",
            },
          },
          required: ["document_id", "version_id", "edits"],
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

export const LOCAL_ASSISTANT_TOOLS: OpenAIToolSchema[] = [
  ...LOCAL_ASK_INPUTS_TOOLS,
  ...LOCAL_LIBRARY_TOOLS,
  ...LOCAL_DOCX_TOOLS,
  ...(TEXT_OPS_TOOLS as OpenAIToolSchema[]),
  ...(WORKFLOW_TOOLS as OpenAIToolSchema[]),
  ...(RESEARCH_TOOLS_DISABLED
    ? []
    : [
        ...(COURTLISTENER_TOOLS as OpenAIToolSchema[]),
        ...(A2AJ_TOOLS as OpenAIToolSchema[]),
        ...(PUBLIC_LEGAL_SOURCE_TOOLS as OpenAIToolSchema[]),
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

const textCache = new Map<string, string>();

export async function extractLocalDocument(userId: string, documentId: string) {
  const file = await getLocalVersionFile(userId, documentId);
  if (!file) return null;
  const cacheKey = `${documentId}:${file.version.id}:${file.version.created_at}`;
  const cached = textCache.get(cacheKey);
  if (cached !== undefined) {
    return { filename: file.document.filename, text: cached };
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

  if (textCache.size >= 16) {
    textCache.delete(textCache.keys().next().value!);
  }
  textCache.set(cacheKey, text);
  return { filename: file.document.filename, text };
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

function result(
  call: NormalizedToolCall,
  content: unknown,
): NormalizedToolResult {
  return {
    tool_use_id: call.id,
    content: typeof content === "string" ? content : JSON.stringify(content),
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
            next_required_action:
              "The document card is shown automatically. Briefly confirm completion; do not repeat a document URL or paste the draft into chat.",
          });
        } catch {
          return fail(call, "DOCX creation failed");
        }
      }

      if (call.name === "library_revise_docx") {
        const versionId = trimmed(args.version_id);
        const rawEdits = Array.isArray(args.edits) ? args.edits : [];
        if (!documentId || !versionId || !rawEdits.length) {
          return fail(call, "document_id, version_id, and edits are required");
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
                reason:
                  typeof edit.reason === "string" ? edit.reason : undefined,
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
          const edited = await applyTrackedEdits(
            await readFile(file.path),
            edits,
            { author: "Beaver", annotate },
          );
          if (edited.errors.length || !edited.changes.length) {
            return result(call, {
              ok: false,
              error: "No revision was saved",
              edit_errors: edited.errors,
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
          // Markup deliverables get deterministic same-turn feedback: the
          // structural lint runs on the freshly produced version.
          const lint = annotate
            ? await lintLocalDocxStructure(userId, documentId, version.id).catch(
                () => null,
              )
            : null;
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
            edits_without_reason: annotate
              ? edits.filter((edit) => !edit.reason?.trim()).length
              : undefined,
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
            next_required_action:
              "The tracked-edit card is shown automatically. Briefly confirm completion; do not repeat a document URL or substitute a prose change list.",
          });
        } catch {
          return fail(call, "DOCX revision failed");
        }
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
                "No tracked changes were created and no new version was saved. Report the per-op notes (flagged spellings, skipped sites) to the user; to correct a flagged word, call this tool again with replace_text scoped to that exact text.",
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
              "The tracked-edit card is shown automatically. Briefly confirm what was changed and mention any unchanged_sites; do not repeat a document URL or paste the transformed text.",
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
              !query || document.filename.toLowerCase().includes(query),
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
            app_url: appUrl({
              kind: "library-document",
              libraryKind: document.library_kind,
              projectId: matterId,
            }),
          }));
        return result(call, { ok: true, documents });
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
            return result(call, {
              ok: true,
              filename: document.filename,
              section: lookup.block.label,
              parent: lookup.block.parentLabel,
              text: lookup.block.text.slice(0, maxChars),
              truncated: lookup.block.text.length > maxChars,
            });
          }
          const maxChars = 300_000;
          return result(call, {
            ok: true,
            filename: document.filename,
            text: document.text.slice(0, maxChars),
            truncated: document.text.length > maxChars,
          });
        }
        const query = trimmed(args.query);
        const matches = findTextMatches({
          text: document.text,
          query,
          maxResults: clampInt(args.max_results, 1, 50, 20),
          contextChars: clampInt(args.context_chars, 40, 2000, 500),
        });
        return result(call, {
          ok: true,
          filename: document.filename,
          query,
          ...matches,
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
            nodes: 0,
            outline:
              "No numbered structure detected; use library_read or library_find.",
          });
        }
        return result(call, {
          ok: true,
          filename: document.filename,
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
              "Use toa_job_status with this job id until detection is complete, then link the user to job.app_url.",
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
