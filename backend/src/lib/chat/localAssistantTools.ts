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
import { extractDocxBodyText } from "../docxTrackedChanges";
import {
  isPresentationDocumentType,
  isSpreadsheetDocumentType,
  isWordDocumentType,
} from "../documentTypes";
import { getLocalVersionFile, listLocalLibrary } from "../localDocumentStore";
import {
  LOCAL_PDF_LOCATOR_KINDS,
  lookupLocalPdfStructure,
  type LocalPdfLocatorKind,
} from "../localPdfLookup";
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
import { extractPdfText, findTextMatches } from "./tools/documentOps";
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
        "List documents in the user's local Mike Library. Use this before claiming a Library document is unavailable. Optionally filter filenames with query.",
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
        "Read the active version of a document from the local Mike Library. Pass the document_id returned by library_list.",
      parameters: {
        type: "object",
        properties: {
          document_id: { type: "string" },
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
        "Search inside a local Mike Library document and return exact matching excerpts with surrounding context. Use this for notes, footnotes, clauses, names, and other targeted lookups.",
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
        "Inspect one Table of Authorities job returned by toa_submit_library_document. Returns bounded progress, review readiness, output downloads, and the exact Mike page to open.",
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

export const LOCAL_ASSISTANT_TOOLS: OpenAIToolSchema[] = [
  ...LOCAL_LIBRARY_TOOLS,
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

function result(
  call: NormalizedToolCall,
  content: unknown,
): NormalizedToolResult {
  return {
    tool_use_id: call.id,
    content: typeof content === "string" ? content : JSON.stringify(content),
  };
}

export async function runLocalAssistantTools(
  userId: string,
  calls: NormalizedToolCall[],
  a2ajLookups?: A2AJLocatorLookup[],
  a2ajDocuments?: A2AJDocument[],
  courtlistenerState?: LocalCourtlistenerState,
  publicLegalState?: PublicLegalSourceState,
): Promise<NormalizedToolResult[]> {
  const publicState = publicLegalState ?? createPublicLegalSourceState();
  return Promise.all(
    calls.map(async (call) => {
      const args = call.input;
      const publicLegalResult = await executePublicLegalSourceTool(
        call.name,
        args,
        publicState,
      );
      if (publicLegalResult) return result(call, publicLegalResult);
      if (courtlistenerState) {
        const courtlistenerResult = await runLocalCourtlistenerTool(
          call,
          courtlistenerState,
        );
        if (courtlistenerResult) return courtlistenerResult;
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
              !query || document.filename.toLowerCase().includes(query),
          )
          .map((document) => ({
            document_id: document.id,
            filename: document.filename,
            file_type: document.file_type,
            kind: document.library_kind,
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
          return result(call, { ok: false, error: "PDF Library version not found" });
        }
        if (file.fileType.toLowerCase() !== "pdf") {
          return result(call, {
            ok: false,
            error: "Exact structural lookup requires a parsed PDF version",
          });
        }
        const lookup = await lookupLocalPdfStructure(file.path, {
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
        });
        return result(call, {
          ok: lookup.status === "found",
          filename: file.version.filename,
          ...lookup,
        });
      }

      if (call.name === "library_link_docx_citations") {
        const documentId =
          typeof args.document_id === "string" ? args.document_id.trim() : "";
        if (!documentId) {
          return result(call, { ok: false, error: "document_id is required" });
        }
        try {
          return result(
            call,
            await linkLocalDocxCitations(userId, documentId),
          );
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
        const jobId =
          typeof args.job_id === "string" ? args.job_id.trim() : "";
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
        return result(
          call,
          document
            ? { ok: true, source: "A2AJ", ...document }
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
        return result(
          call,
          lookup
            ? {
                ok: lookup.status === "found",
                source: "A2AJ",
                ...lookup,
                url: undefined,
              }
            : { ok: false, source: "A2AJ", error: "Document not found" },
        );
      }

      return result(call, { ok: false, error: `Unknown tool: ${call.name}` });
    }),
  );
}
