import PostalMime, { decodeWords } from "postal-mime";

const MAX_EMAIL_BYTES = 100 * 1024 * 1024;
const MAX_PART_BYTES = 8 * 1024 * 1024;
const MAX_HEADERS_BYTES = 256 * 1024;
const MAX_DEPTH = 8;
const DISPLAY_HEADERS = ["from", "to", "cc", "bcc", "date", "subject"] as const;
const EMAIL_MARKERS = new Set([
  "from",
  "date",
  "subject",
  "message-id",
  "received",
  "mime-version",
]);
const SAFE_TRANSFER_ENCODINGS = new Set([
  "",
  "7bit",
  "8bit",
  "binary",
  "base64",
  "quoted-printable",
]);

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
  headers: Map<string, string>;
  body: string;
  attachments: EmailAttachment[];
  abstentions: EmailAbstention[];
}

const add = (
  abstentions: EmailAbstention[],
  reason: EmailAbstentionReason,
  detail: string,
) => {
  if (!abstentions.some((item) => item.reason === reason && item.detail === detail)) {
    abstentions.push({ reason, detail });
  }
};

function rawHeaderValues(bytes: Buffer, name: string) {
  const expression = new RegExp(
    `^${name}\\s*:\\s*([^\\r\\n]*(?:\\r?\\n[ \\t]+[^\\r\\n]*)*)`,
    "gimu",
  );
  return [...bytes.toString("latin1").matchAll(expression)].map((match) =>
    match[1].replace(/\r?\n[ \t]+/gu, " ").trim());
}

function htmlToText(html: string) {
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

function renderHeaderBlock(headers: Map<string, string>) {
  return DISPLAY_HEADERS.flatMap((name) => {
    const value = headers.get(name);
    return value
      ? [`${name[0].toUpperCase()}${name.slice(1)}: ${value}`]
      : [];
  }).join("\n");
}

function staticAbstentions(bytes: Buffer) {
  const abstentions: EmailAbstention[] = [];
  for (const raw of rawHeaderValues(bytes, "content-transfer-encoding")) {
    const encoding = raw.toLowerCase();
    if (!SAFE_TRANSFER_ENCODINGS.has(encoding)) {
      add(abstentions, "unsupported_encoding", encoding);
    }
  }
  for (const value of rawHeaderValues(bytes, "content-type")) {
    const type = value.split(";", 1)[0].trim().toLowerCase();
    if (/^application\/(?:pkcs7-mime|pgp-encrypted)$/u.test(type)) {
      add(abstentions, "encrypted", type);
    }
    const charset = /\bcharset\s*=\s*["']?([^;"'\s]+)/iu.exec(value)?.[1];
    if (!charset) continue;
    try {
      new TextDecoder(charset);
    } catch {
      add(abstentions, "unsupported_charset", charset.toLowerCase());
    }
  }
  return abstentions;
}

function failedMessage(
  reason: EmailAbstentionReason,
  detail: string,
): EmailMessage {
  return {
    headers: new Map(),
    body: "",
    attachments: [],
    abstentions: [{ reason, detail }],
  };
}

/**
 * Parse an RFC 5322/MIME message through PostalMime. Beaver owns only the
 * bounded, plain-text result; the maintained parser owns transfer encodings,
 * charsets, multipart selection, encoded words, and attachment decoding.
 */
export async function parseEmail(bytes: Buffer): Promise<EmailMessage> {
  if (bytes.byteLength > MAX_EMAIL_BYTES) {
    return failedMessage("part_too_large", `email of ${bytes.byteLength} bytes`);
  }

  const abstentions = staticAbstentions(bytes);
  let email;
  try {
    email = await PostalMime.parse(bytes, {
      attachmentEncoding: "arraybuffer",
      maxHeadersSize: MAX_HEADERS_BYTES,
      maxNestingDepth: MAX_DEPTH,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const nesting = /nest|depth/iu.test(message);
    return failedMessage(
      nesting ? "nesting_too_deep" : "no_text_part",
      nesting
        ? `MIME nesting beyond ${MAX_DEPTH} levels`
        : "the message could not be decoded safely",
    );
  }

  const headers = new Map<string, string>();
  for (const { key, value } of email.headers) {
    if (!headers.has(key)) headers.set(key, decodeWords(value));
  }
  if (![...headers.keys()].some((name) => EMAIL_MARKERS.has(name))) {
    return {
      headers,
      body: bytes.toString("utf8").trim(),
      attachments: [],
      abstentions: [{
        reason: "not_an_email",
        detail: "no From/Date/Subject/Message-ID/Received header",
      }],
    };
  }

  let body = (email.text || (email.html ? htmlToText(email.html) : "")).trim();
  if (Buffer.byteLength(body) > MAX_PART_BYTES) {
    add(abstentions, "part_too_large", `text part of ${Buffer.byteLength(body)} bytes`);
    body = "";
  }
  const attachments = email.attachments.map((attachment) => {
    const bytes = typeof attachment.content === "string"
      ? Buffer.byteLength(attachment.content) : attachment.content.byteLength;
    if (bytes > MAX_PART_BYTES) {
      add(
        abstentions,
        "part_too_large",
        `${attachment.mimeType} part of ${bytes} bytes`,
      );
    }
    return {
      filename: attachment.filename || "(unnamed attachment)",
      contentType: attachment.mimeType || "application/octet-stream",
      bytes,
    };
  });
  if (!body && !attachments.length && !abstentions.some(({ reason }) =>
    reason === "encrypted" || reason === "part_too_large")) {
    add(abstentions, "no_text_part", "the message carried no decodable text part");
  }
  return { headers, body, attachments, abstentions };
}

export async function extractEmailText(bytes: Buffer): Promise<string> {
  const message = await parseEmail(bytes);
  const parts = [renderHeaderBlock(message.headers), message.body].filter(Boolean);
  if (message.attachments.length) {
    parts.push(
      `[Attachments not included in this file: ${message.attachments
        .map(({ filename, contentType, bytes }) =>
          `${filename} (${contentType}, ${bytes} bytes)`)
        .join("; ")}]`,
    );
  }
  if (message.abstentions.length) {
    parts.push(
      `[Not decoded: ${message.abstentions
        .map(({ reason, detail }) => `${reason} (${detail})`)
        .join("; ")}]`,
    );
  }
  return parts.join("\n\n");
}
