import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  fetchA2AJDocument,
  lookupA2AJLocator,
  searchA2AJ,
  type A2AJDocument,
  type A2AJLocatorLookup,
} from "../a2aj";
import { docxToPdf } from "../convert";
import { linkLocalDocxCitations } from "../docxCitationLinking";
import { fixLocalDocxSupraCrossReferences } from "../docxDeterministicCleanup";
import { lintLocalDocxStructure } from "../docxStructuralLint";
import { extractDocxDraftingSource } from "../docxDraftingSource";
import { resolveDocxEvidenceCitations } from "../docxEvidenceCitations";
import {
  applyTrackedEdits,
  extractDocxBodyText,
  type EditInput,
} from "../docxTrackedChanges";
import {
  isPresentationDocumentType,
  isSpreadsheetDocumentType,
  isWordDocumentType,
} from "../documentTypes";
import {
  addLocalVersion,
  createLocalDocument,
  deleteLocalDocument,
  getLocalVersionFile,
  listLocalLibrary,
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
import { extractPresentationText } from "../officeText";
import { spreadsheetToLLMText } from "../spreadsheet";
import {
  getTableOfAuthoritiesJob,
  submitTableOfAuthoritiesDocument,
} from "../tableOfAuthorities";
import { A2AJ_TOOL_NAMES, A2AJ_TOOLS } from "./tools/a2ajTools";
import { COURTLISTENER_TOOLS } from "./tools/courtlistenerTools";
import { PUBLIC_LEGAL_SOURCE_TOOLS } from "./tools/publicLegalSourceTools";
import {
  createPublicLegalSourceState,
  executePublicLegalSourceTool,
  type PublicLegalSourceState,
} from "./publicLegalSourceState";
import {
  extractPdfText,
  findTextMatches,
  renderMarkdownDocx,
} from "./tools/documentOps";
import { TOOLS } from "./tools/toolSchemas";
import {
  runLocalCourtlistenerTool,
  type LocalCourtlistenerState,
} from "./localCourtlistenerTools";

const LOCAL_LIBRARY_TOOLS: OpenAIToolSchema[] = [
  {
    type: "function",
    function: {
      name: "library_list",
      description:
        "List documents in the user's local Beaver Library. Use this before claiming a Library document is unavailable. Optionally filter filenames with query.",
      parameters: {
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
    },
  },
  {
    type: "function",
    function: {
      name: "library_read",
      description:
        "Read the active version of a document from the local Beaver Library. Use mode=drafting once when adapting a DOCX precedent; it preserves headings, lists, tables, emphasis, and note pairing for translation into semantic Markdown.",
      parameters: {
        type: "object",
        properties: {
          document_id: { type: "string" },
          mode: {
            type: "string",
            enum: ["text", "drafting"],
            description:
              "Defaults to text. Drafting is DOCX-only, version-bound, and returns bounded semantic HTML as document data.",
          },
        },
        required: ["document_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "library_find",
      description:
        "Search inside a local Beaver Library document and return exact matching excerpts with surrounding context. Use this for notes, footnotes, clauses, names, and other targeted lookups.",
      parameters: {
        type: "object",
        properties: {
          document_id: { type: "string" },
          query: { type: "string" },
          max_results: {
            type: "integer",
            minimum: 1,
            maximum: 50,
          },
          context_chars: {
            type: "integer",
            minimum: 40,
            maximum: 2000,
          },
        },
        required: ["document_id", "query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "library_lookup",
      description:
        "Return only an exact structural unit from a parsed local Library PDF: page/range, artifact paragraph/range, paired footnote/range with propositions, or an exactly encoded section/provision. Prefer this over library_read for pinpoint requests. It never guesses or reparses the whole document.",
      parameters: {
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
    },
  },
  {
    type: "function",
    function: {
      name: "library_evidence",
      description:
        "Rehydrate a prior mike-evidence handle from its exact immutable Library PDF version. Use this after compaction or in a later turn instead of asking for the same locator again. The server verifies source, parser, artifact IDs, and text hash before returning text.",
      parameters: {
        type: "object",
        properties: {
          handle: {
            type: "string",
            description: "Opaque mike-evidence:v1 handle from library_lookup.",
          },
        },
        required: ["handle"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "provider_pdf_lookup",
      description:
        "Resolve an opaque provider PDF reference returned by a legal-source tool and return one exact parsed structural unit. If parsing is still queued, this reports that state without reading the whole PDF. To rehydrate prior exact evidence, pass its handle with the same reference_id instead of a locator.",
      parameters: {
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
          locator_kind: {
            type: "string",
            enum: [...LOCAL_PDF_LOCATOR_KINDS],
          },
          locator: { type: "string" },
          end_locator: { type: "string" },
          context_blocks: {
            type: "integer",
            minimum: 0,
            maximum: 2,
          },
          page: { type: "integer", minimum: 1 },
          occurrence: { type: "integer", minimum: 1 },
        },
        required: ["reference_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "library_link_docx_citations",
      description:
        "Create a new version of a local Library DOCX with verified provider links on its footnote citations. This bounded workflow splits and routes the footnotes itself; do not read, split, classify, or construct citation URLs before calling it.",
      parameters: {
        type: "object",
        properties: {
          document_id: {
            type: "string",
            description: "DOCX document_id returned by library_list.",
          },
        },
        required: ["document_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "library_fix_docx_supras",
      description:
        "Run the deterministic first pass for a local Library DOCX: turn unambiguous plain 'supra note N' numbers into native updating Word footnote cross-references. It creates a new version when it changes anything and reports ambiguous/restarted/split cases for review. Call this before asking the model to reason through or manually rewrite supra references.",
      parameters: {
        type: "object",
        properties: {
          document_id: {
            type: "string",
            description: "DOCX document_id returned by library_list.",
          },
        },
        required: ["document_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "library_lint_docx_structure",
      description:
        "Run the deterministic structural lint on a local Library DOCX: broken internal cross-references, references to missing schedules/exhibits, literal numbering gaps and duplicates, and duplicate or unused defined terms. Read-only; returns verified findings with paragraph locations plus a receipt of what was checked and what was abstained from. Call this instead of asking the model to scan a document for these drafting errors.",
      parameters: {
        type: "object",
        properties: {
          document_id: {
            type: "string",
            description: "DOCX document_id returned by library_list.",
          },
          version_id: {
            type: "string",
            description:
              "Optional explicit Library version id. Omit for the active version.",
          },
        },
        required: ["document_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "toa_submit_library_document",
      description:
        "Submit one owned DOCX Library version to the existing local Table of Authorities workflow. Detection is deterministic first and can use a bounded cached Codex splitter only for unresolved citation units. Never pass or invent filesystem paths.",
      parameters: {
        type: "object",
        properties: {
          document_id: {
            type: "string",
            description: "DOCX document_id returned by library_list.",
          },
          version_id: {
            type: "string",
            description:
              "Optional explicit Library version id. Omit for the active version.",
          },
          split_fallback: {
            type: "string",
            enum: ["off", "auto"],
            description:
              "Use auto to invoke the cached bounded Codex splitter only when deterministic citation splitting is incomplete. Defaults to auto.",
          },
        },
        required: ["document_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "toa_job_status",
      description:
        "Inspect one Table of Authorities job returned by toa_submit_library_document. Returns bounded progress, review readiness, output downloads, and the exact Beaver page to open.",
      parameters: {
        type: "object",
        properties: {
          job_id: { type: "string", pattern: "^[0-9a-f]{32}$" },
        },
        required: ["job_id"],
      },
    },
  },
];

const LOCAL_DOCX_TOOLS: OpenAIToolSchema[] = (
  TOOLS as OpenAIToolSchema[]
).flatMap((tool) => {
  if (tool.function.name === "generate_docx") {
    return [
      {
        ...tool,
        function: {
          ...tool.function,
          name: "library_create_docx",
          description: `${tool.function.description} Store it as a durable new item in the local Library; matter chats attach it to that matter automatically.`,
        },
      },
    ];
  }
  if (tool.function.name === "edit_document") {
    const sharedProperties = tool.function.parameters.properties as Record<
      string,
      unknown
    >;
    return [
      {
        ...tool,
        function: {
          ...tool.function,
          name: "library_revise_docx",
          description:
            "Create a new immutable version of an existing local Library DOCX using precise tracked substitutions. Pass the exact active version_id you read; stale or non-DOCX versions fail without changing the document.",
          parameters: {
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
            },
            required: ["document_id", "version_id", "edits"],
          },
        },
      },
    ];
  }
  return [];
});

const LOCAL_ASK_INPUTS_TOOLS = (TOOLS as OpenAIToolSchema[]).filter(
  (tool) => tool.function.name === "ask_inputs",
);

export const LOCAL_ASSISTANT_TOOLS: OpenAIToolSchema[] = [
  ...LOCAL_ASK_INPUTS_TOOLS,
  ...LOCAL_LIBRARY_TOOLS,
  ...LOCAL_DOCX_TOOLS,
  ...(COURTLISTENER_TOOLS as OpenAIToolSchema[]),
  ...(A2AJ_TOOLS as OpenAIToolSchema[]),
  ...(PUBLIC_LEGAL_SOURCE_TOOLS as OpenAIToolSchema[]),
];

const textCache = new Map<string, string>();

function arrayBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

async function extractLocalDocument(userId: string, documentId: string) {
  const file = await getLocalVersionFile(userId, documentId);
  if (!file) return null;
  const cacheKey = `${documentId}:${file.version.id}:${file.version.created_at}`;
  const cached = textCache.get(cacheKey);
  if (cached !== undefined) {
    return { filename: file.document.filename, text: cached };
  }

  const bytes = await readFile(file.path);
  const fileType = file.fileType.toLowerCase();
  let text = "";
  if (fileType === "pdf") {
    text = await extractPdfText(arrayBuffer(bytes));
  } else if (fileType === "docx") {
    text = await extractDocxBodyText(bytes);
    if (!text) {
      const mammoth = await import("mammoth");
      text = (await mammoth.extractRawText({ buffer: bytes })).value;
    }
  } else if (isSpreadsheetDocumentType(fileType)) {
    text = spreadsheetToLLMText(bytes);
  } else if (fileType === "pptx") {
    text = await extractPresentationText(bytes);
  } else if (
    isPresentationDocumentType(fileType) ||
    isWordDocumentType(fileType)
  ) {
    text = await extractPdfText(arrayBuffer(await docxToPdf(bytes)));
  }

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

const SAFE_PDF_EVIDENCE_ERRORS = new Set([
  "Invalid PDF evidence handle",
  "Invalid PDF evidence receipt",
  "PDF evidence receipt handle does not match its content",
  "PDF evidence receipt does not belong to this source",
  "PDF evidence source bytes no longer match their version",
  "PDF evidence no longer matches the authoritative source artifacts",
]);

function pdfEvidenceError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return SAFE_PDF_EVIDENCE_ERRORS.has(message)
    ? message
    : "PDF evidence is unavailable";
}

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

export async function runLocalAssistantTools(
  userId: string,
  calls: NormalizedToolCall[],
  a2ajLookups?: A2AJLocatorLookup[],
  a2ajDocuments?: A2AJDocument[],
  courtlistenerState?: LocalCourtlistenerState,
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
      const documentId =
        typeof args.document_id === "string" ? args.document_id.trim() : "";
      if (
        allowedDocumentIds &&
        documentId &&
        !allowedDocumentIds.has(documentId)
      ) {
        return result(call, {
          ok: false,
          error: "Document is not attached to this matter",
        });
      }
      if (call.name === "provider_pdf_lookup") {
        const reference =
          typeof args.reference_id === "string" ? args.reference_id.trim() : "";
        const handle =
          typeof args.handle === "string" ? args.handle.trim() : "";
        if (!reference) {
          return result(call, {
            ok: false,
            status: "error",
            error: "reference_id is required",
          });
        }
        try {
          const resolved = handle
            ? await rehydrateProviderPdfReference(reference, handle)
            : await lookupProviderPdfReference(reference, {
                locatorKind: args.locator_kind as LocalPdfLocatorKind,
                locator: typeof args.locator === "string" ? args.locator : "",
                endLocator:
                  typeof args.end_locator === "string"
                    ? args.end_locator
                    : undefined,
                contextBlocks:
                  typeof args.context_blocks === "number"
                    ? args.context_blocks
                    : undefined,
                page: typeof args.page === "number" ? args.page : undefined,
                occurrence:
                  typeof args.occurrence === "number"
                    ? args.occurrence
                    : undefined,
              });
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
        const title = typeof args.title === "string" ? args.title.trim() : "";
        const markdown =
          typeof args.markdown === "string" ? args.markdown.trim() : "";
        if (!title || title.length > 256 || !markdown) {
          return result(call, {
            ok: false,
            error: "DOCX title or Markdown is invalid",
          });
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
          if ("error" in rendered) {
            return result(call, { ok: false, error: rendered.error });
          }
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
                markdownSha256: crypto
                  .createHash("sha256")
                  .update(markdown)
                  .digest("hex"),
                fieldValuesSha256: crypto
                  .createHash("sha256")
                  .update(JSON.stringify(args.fields ?? []))
                  .digest("hex"),
                sourceRegistrySha256: crypto
                  .createHash("sha256")
                  .update(JSON.stringify(args.sources ?? []))
                  .digest("hex"),
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
                return result(call, {
                  ok: false,
                  error: "Matter not found",
                });
              }
            } catch {
              await deleteLocalDocument(userId, document.id).catch(
                () => undefined,
              );
              return result(call, {
                ok: false,
                error: "Could not attach document to matter",
              });
            }
          }
          allowedDocumentIds?.add(document.id);
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
          });
        } catch {
          return result(call, { ok: false, error: "DOCX creation failed" });
        }
      }

      if (call.name === "library_revise_docx") {
        const versionId =
          typeof args.version_id === "string" ? args.version_id.trim() : "";
        const rawEdits = Array.isArray(args.edits) ? args.edits : [];
        if (!documentId || !versionId || !rawEdits.length) {
          return result(call, {
            ok: false,
            error: "document_id, version_id, and edits are required",
          });
        }
        if (
          rawEdits.length > 100 ||
          rawEdits.some(
            (edit) =>
              !edit ||
              typeof edit !== "object" ||
              typeof (edit as Record<string, unknown>).find !== "string" ||
              typeof (edit as Record<string, unknown>).replace !== "string" ||
              typeof (edit as Record<string, unknown>).context_before !==
                "string" ||
              typeof (edit as Record<string, unknown>).context_after !==
                "string" ||
              ((edit as Record<string, unknown>).find as string).length >
                100_000 ||
              ((edit as Record<string, unknown>).replace as string).length >
                100_000 ||
              ((edit as Record<string, unknown>).context_before as string)
                .length > 100_000 ||
              ((edit as Record<string, unknown>).context_after as string)
                .length > 100_000,
          )
        ) {
          return result(call, { ok: false, error: "edits are invalid" });
        }
        try {
          const file = await getLocalVersionFile(userId, documentId, versionId);
          if (!file) {
            return result(call, {
              ok: false,
              error: "DOCX Library version not found",
            });
          }
          if (file.document.current_version_id !== versionId) {
            return result(call, {
              ok: false,
              error: "version_id is not the active version",
            });
          }
          if (file.fileType.toLowerCase() !== "docx") {
            return result(call, {
              ok: false,
              error: "Revision requires a DOCX Library version",
            });
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
          const edited = await applyTrackedEdits(
            await readFile(file.path),
            edits,
            { author: "Beaver" },
          );
          if (edited.errors.length || !edited.changes.length) {
            return result(call, {
              ok: false,
              error: "No revision was saved",
              edit_errors: edited.errors,
            });
          }
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
            },
          });
          if (!version) {
            return result(call, {
              ok: false,
              error: "version_id is no longer active",
            });
          }
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
          });
        } catch {
          return result(call, { ok: false, error: "DOCX revision failed" });
        }
      }

      if (call.name === "library_list") {
        const kind =
          args.kind === "file" || args.kind === "template" ? args.kind : "all";
        const query =
          typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
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
          }));
        return result(call, { ok: true, documents });
      }

      if (call.name === "library_read" || call.name === "library_find") {
        const documentId =
          typeof args.document_id === "string" ? args.document_id.trim() : "";
        if (!documentId) {
          return result(call, { ok: false, error: "document_id is required" });
        }
        if (call.name === "library_read" && args.mode === "drafting") {
          try {
            const source = await extractLocalDraftingDocument(
              userId,
              documentId,
            );
            return result(
              call,
              source
                ? { ok: true, ...source }
                : { ok: false, error: "Document not found" },
            );
          } catch (error) {
            return result(call, {
              ok: false,
              error:
                error instanceof Error
                  ? error.message
                  : "Drafting source could not be read",
            });
          }
        }
        const document = await extractLocalDocument(userId, documentId);
        if (!document) {
          return result(call, { ok: false, error: "Document not found" });
        }
        if (call.name === "library_read") {
          const maxChars = 300_000;
          return result(call, {
            ok: true,
            filename: document.filename,
            text: document.text.slice(0, maxChars),
            truncated: document.text.length > maxChars,
          });
        }
        const query = typeof args.query === "string" ? args.query.trim() : "";
        const maxResults =
          typeof args.max_results === "number"
            ? Math.min(Math.max(Math.trunc(args.max_results), 1), 50)
            : 20;
        const contextChars =
          typeof args.context_chars === "number"
            ? Math.min(Math.max(Math.trunc(args.context_chars), 40), 2000)
            : 500;
        const matches = findTextMatches({
          text: document.text,
          query,
          maxResults,
          contextChars,
        });
        return result(call, {
          ok: true,
          filename: document.filename,
          query,
          ...matches,
        });
      }

      if (call.name === "library_lookup") {
        const documentId =
          typeof args.document_id === "string" ? args.document_id.trim() : "";
        const versionId =
          typeof args.version_id === "string" ? args.version_id.trim() : "";
        if (!documentId) {
          return result(call, { ok: false, error: "document_id is required" });
        }
        const file = await getLocalVersionFile(
          userId,
          documentId,
          versionId || undefined,
        );
        if (!file) {
          return result(call, {
            ok: false,
            error: "PDF Library version not found",
          });
        }
        if (file.fileType.toLowerCase() !== "pdf") {
          return result(call, {
            ok: false,
            error: "Exact structural lookup requires a parsed PDF version",
          });
        }
        const artifactSession = localPdfEvidenceHandles
          ? localPdfArtifactSessionForTurn(localPdfEvidenceHandles, file.path)
          : undefined;
        const lookup = await lookupLocalPdfStructure(
          file.path,
          {
            locatorKind: args.locator_kind as LocalPdfLocatorKind,
            locator: typeof args.locator === "string" ? args.locator : "",
            endLocator:
              typeof args.end_locator === "string"
                ? args.end_locator
                : undefined,
            contextBlocks:
              typeof args.context_blocks === "number"
                ? args.context_blocks
                : undefined,
            page: typeof args.page === "number" ? args.page : undefined,
            occurrence:
              typeof args.occurrence === "number" ? args.occurrence : undefined,
          },
          { artifactSession },
        );
        if (lookup.status === "found") {
          localPdfEvidenceHandles?.add(lookup.evidence.handle);
        }
        return result(call, compactPdfLookup(file.version.filename, lookup));
      }

      if (call.name === "library_evidence") {
        const handle =
          typeof args.handle === "string" ? args.handle.trim() : "";
        if (!handle) {
          return result(call, { ok: false, error: "handle is required" });
        }
        try {
          const receipt = await readLocalPdfEvidenceReceipt(handle);
          if (
            allowedDocumentIds &&
            !allowedDocumentIds.has(receipt.source.document_id)
          ) {
            return result(call, {
              ok: false,
              error: "Document is not attached to this matter",
            });
          }
          const file = await getLocalVersionFile(
            userId,
            receipt.source.document_id,
            receipt.source.version_id,
          );
          if (!file || file.fileType.toLowerCase() !== "pdf") {
            return result(call, {
              ok: false,
              error: "PDF Library version not found",
            });
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
          return result(call, {
            ok: false,
            error: pdfEvidenceError(error),
          });
        }
      }

      if (call.name === "library_link_docx_citations") {
        const documentId =
          typeof args.document_id === "string" ? args.document_id.trim() : "";
        if (!documentId) {
          return result(call, { ok: false, error: "document_id is required" });
        }
        try {
          return result(call, await linkLocalDocxCitations(userId, documentId));
        } catch (error) {
          return result(call, {
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : "DOCX citation linking failed",
          });
        }
      }

      if (call.name === "library_fix_docx_supras") {
        const documentId =
          typeof args.document_id === "string" ? args.document_id.trim() : "";
        if (!documentId) {
          return result(call, { ok: false, error: "document_id is required" });
        }
        try {
          return result(
            call,
            await fixLocalDocxSupraCrossReferences(userId, documentId),
          );
        } catch (error) {
          return result(call, {
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : "DOCX supra cleanup failed",
          });
        }
      }

      if (call.name === "library_lint_docx_structure") {
        const documentId =
          typeof args.document_id === "string" ? args.document_id.trim() : "";
        const versionId =
          typeof args.version_id === "string" ? args.version_id.trim() : "";
        if (!documentId) {
          return result(call, { ok: false, error: "document_id is required" });
        }
        try {
          return result(
            call,
            await lintLocalDocxStructure(
              userId,
              documentId,
              versionId || undefined,
            ),
          );
        } catch (error) {
          return result(call, {
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : "DOCX structural lint failed",
          });
        }
      }

      if (call.name === "toa_submit_library_document") {
        const documentId =
          typeof args.document_id === "string" ? args.document_id.trim() : "";
        const versionId =
          typeof args.version_id === "string" ? args.version_id.trim() : "";
        if (!documentId) {
          return result(call, { ok: false, error: "document_id is required" });
        }
        try {
          const file = await getLocalVersionFile(
            userId,
            documentId,
            versionId || undefined,
          );
          if (!file) {
            return result(call, {
              ok: false,
              error: "DOCX Library version not found",
            });
          }
          if (file.fileType.toLowerCase() !== "docx") {
            return result(call, {
              ok: false,
              error: "Table of Authorities requires a DOCX Library version",
            });
          }
          const job = await submitTableOfAuthoritiesDocument({
            bytes: await readFile(file.path),
            filename: file.version.filename,
            splitFallback: args.split_fallback === "off" ? "off" : "auto",
          });
          return result(call, {
            ok: true,
            document_id: documentId,
            version_id: file.version.id,
            filename: file.version.filename,
            job,
            next_required_action:
              "Use toa_job_status with this job id until detection is complete, then give the user job.open_path.",
          });
        } catch (error) {
          return result(call, {
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : "Table of Authorities submission failed",
          });
        }
      }

      if (call.name === "toa_job_status") {
        const jobId = typeof args.job_id === "string" ? args.job_id.trim() : "";
        try {
          return result(call, {
            ok: true,
            job: await getTableOfAuthoritiesJob(jobId),
          });
        } catch (error) {
          return result(call, {
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : "Table of Authorities status lookup failed",
          });
        }
      }

      if (call.name === A2AJ_TOOL_NAMES.search) {
        const documents = await searchA2AJ({
          query: typeof args.query === "string" ? args.query : "",
          docType: args.doc_type === "laws" ? "laws" : "cases",
          searchType: args.search_type === "name" ? "name" : "full_text",
          language: args.search_language === "fr" ? "fr" : "en",
          size: typeof args.size === "number" ? args.size : undefined,
          dataset: typeof args.dataset === "string" ? args.dataset : undefined,
          startDate:
            typeof args.start_date === "string" ? args.start_date : undefined,
          endDate:
            typeof args.end_date === "string" ? args.end_date : undefined,
          sortResults:
            args.sort_results === "newest_first" ||
            args.sort_results === "oldest_first"
              ? args.sort_results
              : "default",
        });
        return result(call, {
          ok: true,
          source: "A2AJ",
          results: documents,
          next_required_action: "Use a2aj_fetch before relying on source text.",
        });
      }

      if (call.name === A2AJ_TOOL_NAMES.fetch) {
        const document = await fetchA2AJDocument({
          citation: typeof args.citation === "string" ? args.citation : "",
          docType: args.doc_type === "laws" ? "laws" : "cases",
          language: args.output_language === "fr" ? "fr" : "en",
          section: typeof args.section === "string" ? args.section : undefined,
        });
        if (document?.url) a2ajDocuments?.push(document);
        const pdfFallback = document
          ? await queueA2ajPdfFallback(document)
          : null;
        return result(
          call,
          document
            ? {
                ok: true,
                source: "A2AJ",
                ...document,
                ...(pdfFallback ? { pdf_fallback: pdfFallback } : {}),
              }
            : { ok: false, source: "A2AJ", error: "Document not found" },
        );
      }

      if (call.name === A2AJ_TOOL_NAMES.lookup) {
        const lookup = await lookupA2AJLocator({
          citation: typeof args.citation === "string" ? args.citation : "",
          docType: args.doc_type === "laws" ? "laws" : "cases",
          language: args.output_language === "fr" ? "fr" : "en",
          kind:
            args.locator_type === "page"
              ? "page"
              : args.locator_type === "section"
                ? "section"
                : "paragraph",
          locator: typeof args.locator === "string" ? args.locator : "",
          contextBlocks:
            typeof args.context_blocks === "number"
              ? args.context_blocks
              : undefined,
        });
        if (lookup?.status === "found" && lookup.block) {
          a2ajLookups?.push(lookup);
        }
        const pdfFallback = lookup ? await queueA2ajPdfFallback(lookup) : null;
        return result(
          call,
          lookup
            ? {
                ok: lookup.status === "found",
                source: "A2AJ",
                ...lookup,
                url: undefined,
                ...(pdfFallback ? { pdf_fallback: pdfFallback } : {}),
              }
            : { ok: false, source: "A2AJ", error: "Document not found" },
        );
      }

      return result(call, { ok: false, error: `Unknown tool: ${call.name}` });
    }),
  );
}
