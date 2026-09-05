export const MAX_WORD_EDITS = 20;
export const MAX_WORD_ANCHOR_CHARS = 255;
export const WORD_FORMATS = ["bold", "italic", "underline", "heading1", "heading2", "heading3"];

export function parseWordEdits(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_WORD_EDITS) return null;
  const parsed = [];
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return null;
    const { original, replacement, formats, occurrence, reason } = row;
    if (typeof original !== "string" || !original || original.length > MAX_WORD_ANCHOR_CHARS ||
        /[\r\n^]/u.test(original) || (replacement === undefined) === (formats === undefined) ||
        (replacement !== undefined && (typeof replacement !== "string" || replacement.length > 10_000)) ||
        (formats !== undefined && (!Array.isArray(formats) || !formats.length ||
          !formats.every((format) => WORD_FORMATS.includes(format)) ||
          new Set(formats).size !== formats.length)) ||
        (occurrence !== undefined && occurrence !== "all")) return null;
    parsed.push({ original,
      ...(replacement !== undefined ? { replacement } : { formats }),
      ...(occurrence ? { occurrence } : {}),
      ...(typeof reason === "string" && reason.trim() ? { reason: reason.trim().slice(0, 500) } : {}),
    });
  }
  return parsed;
}
