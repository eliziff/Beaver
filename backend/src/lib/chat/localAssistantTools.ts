import { readFile } from "node:fs/promises";
import { fetchA2AJDocument, lookupA2AJLocator, searchA2AJ } from "../a2aj";
import { docxToPdf } from "../convert";
import { extractDocxBodyText } from "../docxTrackedChanges";
import {
  isPresentationDocumentType,
  isSpreadsheetDocumentType,
  isWordDocumentType,
} from "../documentTypes";
import { getLocalVersionFile, listLocalLibrary } from "../localDocumentStore";
import type {
  NormalizedToolCall,
  NormalizedToolResult,
  OpenAIToolSchema,
} from "../llm";
import { extractPresentationText } from "../officeText";
import { spreadsheetToLLMText } from "../spreadsheet";
import { A2AJ_TOOL_NAMES, A2AJ_TOOLS } from "./tools/a2ajTools";
import { extractPdfText, findTextMatches } from "./tools/documentOps";

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
];

export const LOCAL_ASSISTANT_TOOLS: OpenAIToolSchema[] = [
  ...LOCAL_LIBRARY_TOOLS,
  ...(A2AJ_TOOLS as OpenAIToolSchema[]),
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
): Promise<NormalizedToolResult[]> {
  return Promise.all(
    calls.map(async (call) => {
      const args = call.input;
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
        return result(
          call,
          lookup
            ? {
                ok: lookup.status === "found",
                source: "A2AJ",
                ...lookup,
              }
            : { ok: false, source: "A2AJ", error: "Document not found" },
        );
      }

      return result(call, { ok: false, error: `Unknown tool: ${call.name}` });
    }),
  );
}
