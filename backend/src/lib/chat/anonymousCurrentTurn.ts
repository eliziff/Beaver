import { parseAskInputsResponsePayload } from "./messageFormatting";
import type { AskInputsResponseRequest, ChatMessage } from "./types";

export type AnonymousCurrentTurn =
  | {
      kind: "message";
      turnId?: string;
      message: ChatMessage & { role: "user"; content: string };
    }
  | {
      kind: "ask_inputs_response";
      content: string;
      files?: ChatMessage["files"];
      response: AskInputsResponseRequest;
    };

type ParseResult =
  | { ok: true; turn: AnonymousCurrentTurn }
  | { ok: false; detail: string };

function filesFrom(value: unknown): ChatMessage["files"] | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 50) return null;
  const files = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    const filename =
      typeof row.filename === "string" ? row.filename.trim().slice(0, 500) : "";
    const documentId =
      typeof row.document_id === "string"
        ? row.document_id.trim().slice(0, 200)
        : "";
    return filename && documentId
      ? { filename, document_id: documentId }
      : null;
  });
  return files.every(
    (file): file is { filename: string; document_id: string } => file !== null,
  )
    ? files
    : null;
}

function workflowFrom(value: unknown): ChatMessage["workflow"] | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id.trim().slice(0, 200) : "";
  const title =
    typeof row.title === "string" ? row.title.trim().slice(0, 500) : "";
  return id && title ? { id, title } : null;
}

function localResponseDocuments(value: unknown) {
  if (!Array.isArray(value) || value.length > 50) return null;
  const documents = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    const documentId =
      typeof row.document_id === "string"
        ? row.document_id.trim().slice(0, 200)
        : "";
    const filename =
      typeof row.filename === "string" ? row.filename.trim().slice(0, 500) : "";
    return documentId && filename
      ? { document_id: documentId, filename }
      : null;
  });
  return documents.every(
    (
      document,
    ): document is { document_id: string; filename: string } =>
      document !== null,
  )
    ? documents
    : null;
}

export function parseAnonymousCurrentTurn(value: unknown): ParseResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, detail: "current_turn must be an object" };
  }
  const row = value as Record<string, unknown>;
  const content =
    typeof row.content === "string" ? row.content.trim() : "";
  if (!content) {
    return { ok: false, detail: "current_turn.content is required" };
  }
  const files = filesFrom(row.files);
  if (files === null) {
    return {
      ok: false,
      detail: "current_turn.files must contain Library document references",
    };
  }

  if (row.kind === "message") {
    const turnId =
      row.turn_id === undefined
        ? undefined
        : typeof row.turn_id === "string" &&
            /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(
              row.turn_id.trim(),
            )
          ? row.turn_id.trim()
          : null;
    if (turnId === null) {
      return { ok: false, detail: "current_turn.turn_id must be a UUID" };
    }
    const workflow = workflowFrom(row.workflow);
    if (workflow === null) {
      return { ok: false, detail: "current_turn.workflow is invalid" };
    }
    return {
      ok: true,
      turn: {
        kind: "message",
        ...(turnId ? { turnId } : {}),
        message: {
          role: "user",
          content,
          files,
          workflow,
        },
      },
    };
  }

  if (row.kind === "ask_inputs_response") {
    const response = parseAskInputsResponsePayload({
      responses: row.responses,
    });
    if (response && Array.isArray(row.responses)) {
      const rawById = new Map(
        row.responses.flatMap((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) {
            return [];
          }
          const current = item as Record<string, unknown>;
          return typeof current.id === "string"
            ? [[current.id.trim().slice(0, 80), current] as const]
            : [];
        }),
      );
      for (const item of response.responses) {
        if (item.kind !== "documents") continue;
        const documents = localResponseDocuments(
          rawById.get(item.id)?.documents,
        );
        if (documents === null) {
          return {
            ok: false,
            detail: "current_turn.responses contains invalid documents",
          };
        }
        item.documents = documents;
      }
    }
    return response
      ? {
          ok: true,
          turn: {
            kind: "ask_inputs_response",
            content,
            files,
            response,
          },
        }
      : { ok: false, detail: "current_turn.responses is invalid" };
  }

  return {
    ok: false,
    detail: "current_turn.kind must be message or ask_inputs_response",
  };
}

export function parseExpectedTranscriptVersion(
  value: unknown,
): { ok: true; version: number } | { ok: false; detail: string } {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? { ok: true, version: value as number }
    : {
        ok: false,
        detail: "expected_version must be a non-negative integer",
      };
}
