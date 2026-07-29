// Email (.eml) text extraction: RFC 5322 headers plus MIME bodies, decoded
// deterministically.
//
// Legal matters are mostly email, and an *undecoded* message is worse than an
// unreadable one — quoted-printable soft breaks split numbers mid-digit, so
// "$85,000" reaches the reader as "$85,0=\n00" and both the model and the
// deterministic auditors see an amount the sender never wrote. Everything here
// is a defined decoding of a defined encoding; anything that is not becomes a
// typed abstention rather than a guess.
//
// Working note: MIME part bodies are handled as latin1 strings, which is
// byte-preserving and index-preserving, so string offsets slice the Buffer
// correctly. Charset decoding happens only after transfer decoding, because
// quoted-printable and base64 both yield bytes, not characters.

const MAX_DEPTH = 8;
const MAX_PART_BYTES = 8 * 1024 * 1024;

export interface EmailAttachment {
  filename: string;
  contentType: string;
  bytes: number;
}

export type EmailAbstentionReason =
  | "not_an_email"
  | "unsupported_encoding"
  | "unsupported_charset"
  | "part_too_large"
  | "nesting_too_deep"
  | "encrypted"
  | "no_text_part";

export interface EmailAbstention {
  reason: EmailAbstentionReason;
  detail: string;
}

export interface EmailMessage {
  /** Lower-cased header name -> decoded value; first occurrence wins. */
  headers: Map<string, string>;
  /** The decoded message body. */
  body: string;
  attachments: EmailAttachment[];
  abstentions: EmailAbstention[];
}

/** Headers shown to a reader, in the order a reader expects them. */
const DISPLAY_HEADERS = ["from", "to", "cc", "bcc", "date", "subject"] as const;

/** Any one of these is enough to call a byte stream an email. */
const EMAIL_MARKERS = [
  "from",
  "date",
  "subject",
  "message-id",
  "received",
  "mime-version",
];

function splitHeadersAndBody(raw: Buffer): { head: string; body: Buffer } {
  const s = raw.toString("latin1");
  const crlf = s.indexOf("\r\n\r\n");
  const lf = s.indexOf("\n\n");
  const [at, skip] =
    crlf >= 0 && (lf < 0 || crlf <= lf)
      ? [crlf, 4]
      : lf >= 0
        ? [lf, 2]
        : [-1, 0];
  if (at < 0) return { head: s, body: Buffer.alloc(0) };
  // Header bytes are ASCII plus encoded-words; UTF-8 also covers the common
  // modern case of raw 8-bit header text.
  return {
    head: raw.subarray(0, at).toString("utf8"),
    body: raw.subarray(at + skip),
  };
}

const ENCODED_WORD_RE = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/gu;

function decodeEncodedWords(value: string): string {
  return value.replace(ENCODED_WORD_RE, (whole, charset, kind, payload) => {
    try {
      const bytes = /^[Bb]$/u.test(String(kind))
        ? Buffer.from(String(payload), "base64")
        : decodeQuotedPrintable(String(payload).replace(/_/gu, " "));
      return decodeCharset(bytes, String(charset)).text;
    } catch {
      return whole;
    }
  });
}

function parseHeaders(head: string): Map<string, string> {
  const out = new Map<string, string>();
  let current = "";
  const flush = () => {
    const idx = current.indexOf(":");
    if (idx > 0) {
      const name = current.slice(0, idx).trim().toLowerCase();
      if (!out.has(name)) {
        out.set(name, decodeEncodedWords(current.slice(idx + 1).trim()));
      }
    }
    current = "";
  };
  for (const line of head.split(/\r?\n/u)) {
    // A leading space or tab continues the previous header (RFC 5322 folding).
    if (/^[ \t]/u.test(line) && current) {
      current += ` ${line.trim()}`;
      continue;
    }
    flush();
    current = line;
  }
  flush();
  return out;
}

/** Decode quoted-printable to bytes. Soft line breaks vanish; strays stay. */
function decodeQuotedPrintable(input: string): Buffer {
  const out: number[] = [];
  for (let i = 0; i < input.length; i++) {
    if (input[i] !== "=") {
      out.push(input.charCodeAt(i) & 0xff);
      continue;
    }
    const rest = input.slice(i + 1);
    if (rest.startsWith("\r\n")) {
      i += 2;
      continue;
    }
    if (rest.startsWith("\n")) {
      i += 1;
      continue;
    }
    const pair = rest.slice(0, 2);
    if (/^[0-9A-Fa-f]{2}$/u.test(pair)) {
      out.push(parseInt(pair, 16));
      i += 2;
      continue;
    }
    out.push(0x3d);
  }
  return Buffer.from(out);
}

function decodeCharset(
  bytes: Buffer,
  charset: string,
): { text: string; abstention?: EmailAbstention } {
  const label =
    charset.trim().toLowerCase().replace(/^["']|["']$/gu, "") || "utf-8";
  try {
    return { text: new TextDecoder(label).decode(bytes) };
  } catch {
    return {
      text: new TextDecoder("utf-8").decode(bytes),
      abstention: { reason: "unsupported_charset", detail: label },
    };
  }
}

function parseContentType(value: string | undefined): {
  type: string;
  params: Record<string, string>;
} {
  const raw = (value ?? "text/plain").trim();
  const [typePart, ...rest] = raw.split(";");
  const params: Record<string, string> = {};
  for (const chunk of rest) {
    const idx = chunk.indexOf("=");
    if (idx < 0) continue;
    const key = chunk.slice(0, idx).trim().toLowerCase();
    params[key] = chunk
      .slice(idx + 1)
      .trim()
      .replace(/^["']|["']$/gu, "");
  }
  return { type: typePart.trim().toLowerCase(), params };
}

/** Split a multipart body on its boundary delimiters. */
function splitParts(body: Buffer, boundary: string): Buffer[] {
  const s = body.toString("latin1");
  const delim = `--${boundary}`;
  const out: Buffer[] = [];
  let idx = s.indexOf(delim);
  while (idx >= 0) {
    const afterDelim = idx + delim.length;
    if (s.startsWith("--", afterDelim)) break; // closing delimiter
    const lineEnd = s.indexOf("\n", afterDelim);
    if (lineEnd < 0) break;
    const next = s.indexOf(delim, lineEnd);
    let stop = next < 0 ? s.length : next;
    // The CRLF before a delimiter belongs to the delimiter, not the part.
    if (s[stop - 1] === "\n") stop--;
    if (s[stop - 1] === "\r") stop--;
    out.push(body.subarray(lineEnd + 1, Math.max(lineEnd + 1, stop)));
    if (next < 0) break;
    idx = next;
  }
  return out;
}

function decodeTransfer(
  headers: Map<string, string>,
  body: Buffer,
): { bytes: Buffer; abstention?: EmailAbstention } {
  const cte = (headers.get("content-transfer-encoding") ?? "7bit")
    .trim()
    .toLowerCase();
  if (cte === "base64") {
    return {
      bytes: Buffer.from(body.toString("latin1").replace(/\s+/gu, ""), "base64"),
    };
  }
  if (cte === "quoted-printable") {
    return { bytes: decodeQuotedPrintable(body.toString("latin1")) };
  }
  if (["7bit", "8bit", "binary", ""].includes(cte)) return { bytes: body };
  return {
    bytes: body,
    abstention: { reason: "unsupported_encoding", detail: cte },
  };
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/giu, "")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/(?:p|div|tr|li|h[1-6])>/giu, "\n")
    .replace(/<[^>]+>/gu, "")
    .replace(/&nbsp;/giu, " ")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#0?39;|&apos;/giu, "'")
    .replace(/&amp;/giu, "&")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

interface Accumulator {
  attachments: EmailAttachment[];
  abstentions: EmailAbstention[];
}

function attachmentName(
  headers: Map<string, string>,
  params: Record<string, string>,
): string | null {
  const disposition = headers.get("content-disposition") ?? "";
  const match = /filename\*?=("?)([^";]+)\1/iu.exec(disposition);
  if (match) return decodeEncodedWords(match[2].trim());
  if (params.name) return decodeEncodedWords(params.name);
  return /\battachment\b/iu.test(disposition) ? "(unnamed attachment)" : null;
}

/** Render one MIME part to text, collecting attachments and abstentions. */
function renderPart(
  headers: Map<string, string>,
  body: Buffer,
  depth: number,
  acc: Accumulator,
): string {
  if (depth > MAX_DEPTH) {
    acc.abstentions.push({
      reason: "nesting_too_deep",
      detail: `MIME nesting beyond ${MAX_DEPTH} levels`,
    });
    return "";
  }
  const { type, params } = parseContentType(headers.get("content-type"));

  if (type.startsWith("multipart/")) {
    const boundary = params.boundary;
    if (!boundary) {
      acc.abstentions.push({
        reason: "no_text_part",
        detail: `${type} without a boundary parameter`,
      });
      return "";
    }
    const children = splitParts(body, boundary).map((raw) => {
      const split = splitHeadersAndBody(raw);
      return { headers: parseHeaders(split.head), body: split.body };
    });
    if (type === "multipart/alternative") {
      // Prefer the plain-text rendition; it is what the sender typed.
      const ranked = [...children].sort(
        (a, b) => alternativeRank(a.headers) - alternativeRank(b.headers),
      );
      for (const child of ranked) {
        const text = renderPart(child.headers, child.body, depth + 1, acc);
        if (text.trim()) return text;
      }
      return "";
    }
    return children
      .map((child) => renderPart(child.headers, child.body, depth + 1, acc))
      .filter((text) => text.trim())
      .join("\n\n");
  }

  if (type === "message/rfc822") {
    const split = splitHeadersAndBody(body);
    const inner = parseHeaders(split.head);
    const text = renderPart(inner, split.body, depth + 1, acc);
    return [renderHeaderBlock(inner), text].filter(Boolean).join("\n\n");
  }

  if (/^application\/(?:pkcs7-mime|pgp-encrypted)/u.test(type)) {
    acc.abstentions.push({ reason: "encrypted", detail: type });
    return "";
  }

  if (body.byteLength > MAX_PART_BYTES) {
    acc.abstentions.push({
      reason: "part_too_large",
      detail: `${type} part of ${body.byteLength} bytes`,
    });
    return "";
  }

  const filename = attachmentName(headers, params);
  if (!type.startsWith("text/") || filename) {
    if (filename) {
      acc.attachments.push({
        filename,
        contentType: type,
        bytes: body.byteLength,
      });
    }
    return "";
  }

  const transfer = decodeTransfer(headers, body);
  if (transfer.abstention) acc.abstentions.push(transfer.abstention);
  const decoded = decodeCharset(transfer.bytes, params.charset ?? "utf-8");
  if (decoded.abstention) acc.abstentions.push(decoded.abstention);
  return type === "text/html" ? htmlToText(decoded.text) : decoded.text.trim();
}

function alternativeRank(headers: Map<string, string>): number {
  const { type } = parseContentType(headers.get("content-type"));
  if (type === "text/plain") return 0;
  if (type === "text/html") return 1;
  return 2;
}

function renderHeaderBlock(headers: Map<string, string>): string {
  return DISPLAY_HEADERS.filter((name) => headers.get(name))
    .map((name) => `${name.replace(/^./u, (c) => c.toUpperCase())}: ${headers.get(name)}`)
    .join("\n");
}

/** Parse an .eml byte stream into decoded headers, body, and attachments. */
export function parseEmail(bytes: Buffer): EmailMessage {
  const { head, body } = splitHeadersAndBody(bytes);
  const headers = parseHeaders(head);
  const acc: Accumulator = { attachments: [], abstentions: [] };

  if (!EMAIL_MARKERS.some((name) => headers.has(name))) {
    acc.abstentions.push({
      reason: "not_an_email",
      detail: "no From/Date/Subject/Message-ID/Received header",
    });
    return {
      headers,
      body: bytes.toString("utf8").trim(),
      attachments: [],
      abstentions: acc.abstentions,
    };
  }

  const rendered = renderPart(headers, body, 0, acc).trim();
  if (!rendered && !acc.attachments.length) {
    acc.abstentions.push({
      reason: "no_text_part",
      detail: "the message carried no decodable text part",
    });
  }
  return {
    headers,
    body: rendered,
    attachments: acc.attachments,
    abstentions: acc.abstentions,
  };
}

/**
 * The reading view of an email: the headers a lawyer needs for provenance,
 * the decoded body, and a named list of attachments — which are real evidence
 * that something exists but was not ingested with this file.
 */
export function extractEmailText(bytes: Buffer): string {
  const message = parseEmail(bytes);
  const parts = [renderHeaderBlock(message.headers), message.body].filter(
    Boolean,
  );
  if (message.attachments.length) {
    parts.push(
      `[Attachments not included in this file: ${message.attachments
        .map((a) => `${a.filename} (${a.contentType}, ${a.bytes} bytes)`)
        .join("; ")}]`,
    );
  }
  if (message.abstentions.length) {
    parts.push(
      `[Not decoded: ${message.abstentions
        .map((a) => `${a.reason} (${a.detail})`)
        .join("; ")}]`,
    );
  }
  return parts.join("\n\n");
}
