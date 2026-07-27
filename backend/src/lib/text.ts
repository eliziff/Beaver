// Shared tiny text utilities. Each existed 2-5 times as file-local copies;
// define them once here and nowhere else.

/** Collapse runs of blank characters (not NBSP) to single spaces and trim. */
export function normalizeWhitespace(text: string): string {
  return text.trim().replace(/[ \t\r\n\f\v]+/gu, " ");
}

/** Decode the XML entities OOXML uses. `&amp;` is decoded last so encoded entities never double-decode. */
export function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/gu, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&amp;/gu, "&");
}

/** Encode text for insertion into an XML text node. */
export function escapeXmlText(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

/** Escape a literal string for use inside a RegExp. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
