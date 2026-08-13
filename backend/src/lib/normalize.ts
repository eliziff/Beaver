export function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function normalizeDocumentFilename(
  nextName: unknown,
  currentName: string,
): string | null {
  if (typeof nextName !== "string") return null;
  const trimmed = nextName.trim().slice(0, 200);
  if (!trimmed) return null;
  if (/\.[a-z0-9]{1,6}$/i.test(trimmed)) return trimmed;
  const ext = currentName.match(/\.[a-z0-9]{1,6}$/i)?.[0] ?? "";
  return `${trimmed}${ext}`;
}

export type DocumentMetadata = {
  jurisdiction: string | null;
  areas_of_law: string[];
  document_types: string[];
  description: string | null;
};

export function normalizeDocumentMetadata(value: unknown): DocumentMetadata {
  const source = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const text = (input: unknown, max: number) =>
    typeof input === "string" && input.trim()
      ? input.trim().slice(0, max)
      : null;
  const list = (input: unknown) => Array.isArray(input)
    ? [...new Set(input.filter((item): item is string => typeof item === "string")
        .map((item) => item.trim()).filter(Boolean))].slice(0, 20)
    : [];
  return {
    jurisdiction: text(source.jurisdiction, 160),
    areas_of_law: list(source.areas_of_law),
    document_types: list(source.document_types),
    description: text(source.description, 500),
  };
}

export function normalizeDocumentNotes(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 500)
    : null;
}

export type LibraryKind = "file" | "template";

export function normalizeLibraryKind(value: unknown): LibraryKind | null {
  if (value === "file" || value === "files") return "file";
  if (value === "template" || value === "templates") return "template";
  return null;
}
