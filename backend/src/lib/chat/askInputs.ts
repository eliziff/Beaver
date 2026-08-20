import type {
  AskInputItem,
  AskInputOption,
  AskInputsEvent,
} from "./types";

function clean(value: unknown, fallback = "") {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

export function normalizeAskInputsEvent(
  args: Record<string, unknown>,
): AskInputsEvent {
  const rawItems = Array.isArray(args.items) ? args.items : [];
  const seenIds = new Set<string>();
  const items = rawItems
    .map((item, index): AskInputItem | null => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const row = item as Record<string, unknown>;
      const id =
        clean(row.id) ||
        `${row.kind === "documents" ? "documents" : "choice"}-${index + 1}`;

      if (row.kind === "documents") {
        const rawTypes = Array.isArray(row.document_types)
          ? row.document_types
          : [];
        const documentTypes = rawTypes
          .filter((type): type is string => typeof type === "string")
          .map((type) => type.trim())
          .filter(Boolean)
          .map((type) => type.slice(0, 300))
          .slice(0, 8);
        return {
          id: id.slice(0, 80),
          kind: "documents",
          document_types: documentTypes,
        };
      }

      const question = clean(row.question, "Please choose an option.");
      const rawOptions = Array.isArray(row.options) ? row.options : [];
      const options = rawOptions
        .map((option): AskInputOption | null => {
          if (!option || typeof option !== "object") return null;
          const optionRow = option as Record<string, unknown>;
          const value = clean(optionRow.value) || clean(optionRow.label);
          return value ? { value: value.slice(0, 500) } : null;
        })
        .filter((option): option is AskInputOption => !!option)
        .slice(0, 8);
      return {
        id: id.slice(0, 80),
        kind: "choice",
        question: question.slice(0, 500),
        options: options.length ? options : [{ value: "Continue" }],
      };
    })
    .filter((item): item is AskInputItem => {
      if (!item || seenIds.has(item.id)) return false;
      seenIds.add(item.id);
      return true;
    })
    .slice(0, 12);

  return { type: "ask_inputs", items };
}
