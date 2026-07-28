import type { ParagraphChild } from "docx";

type DocxMarkdownInline =
  | { type: "text"; text: string }
  | { type: "strong"; text: string }
  | { type: "emphasis"; text: string }
  | { type: "footnote"; id: string }
  | { type: "citation"; id: string }
  | { type: "control"; tag: string; occurrence: number };

type DocxMarkdownBlock =
  | {
      type: "heading";
      level: 1 | 2 | 3;
      numbered: boolean;
      bookmark?: string;
      children: DocxMarkdownInline[];
    }
  | { type: "paragraph"; children: DocxMarkdownInline[] }
  | {
      type: "list";
      items: {
        ordered: boolean;
        level: number;
        children: DocxMarkdownInline[];
      }[];
    }
  | {
      type: "table";
      headers: DocxMarkdownInline[][];
      rows: DocxMarkdownInline[][][];
    }
  | { type: "control"; tag: string; occurrence: number }
  | { type: "page-break" };

export type DocxMarkdownDocument = {
  blocks: DocxMarkdownBlock[];
  footnotes: {
    id: string;
    children: DocxMarkdownInline[];
  }[];
};

export type RenderDocxMarkdownOptions = {
  title?: string;
  landscape?: boolean;
  values?: Readonly<Record<string, string>>;
  citations?: Readonly<Record<string, { text: string; url: string }>>;
};

const CONTROL_TAG = "[a-z][a-z0-9_.-]{0,63}";
const CONTROL_MARKER = "[^{}\\r\\n]+";
const CONTROL_TAG_RE = new RegExp(`^${CONTROL_TAG}$`, "u");
const NOTE_ID = "[A-Za-z0-9][A-Za-z0-9_.-]{0,63}";
const CITATION_ID = "[a-z][a-z0-9_-]{0,63}";
const BOOKMARK_ID = /^[A-Za-z][A-Za-z0-9_]{0,39}$/u;
const CONTROL_ONLY_RE = new RegExp(
  `^\\s*\\{\\{(${CONTROL_MARKER})\\}\\}\\s*$`,
  "u",
);
const CONTROL_OR_NOTE_RE = new RegExp(
  `(\\[\\^${NOTE_ID}\\]|\\[@${CITATION_ID}\\]|\\{\\{${CONTROL_MARKER}\\}\\}|\\*\\*[^*\\n]+\\*\\*|\\*[^*\\n]+\\*)`,
  "gu",
);
const FOOTNOTE_DEFINITION_RE = new RegExp(
  `^\\[\\^(${NOTE_ID})\\]:\\s*(.*)$`,
  "u",
);
const FOOTNOTE_REFERENCE_RE = new RegExp(`^\\[\\^(${NOTE_ID})\\]$`, "u");
const CITATION_RE = new RegExp(`^\\[@(${CITATION_ID})\\]$`, "u");
const CONTROL_RE = new RegExp(`^\\{\\{(${CONTROL_MARKER})\\}\\}$`, "u");

type ParseState = {
  controlCounts: Map<string, number>;
  referencedNotes: Set<string>;
  warnings: string[];
};

function warn(warnings: string[], message: string) {
  if (!warnings.includes(message)) warnings.push(message);
}

function snippet(text: string) {
  const trimmed = text.trim();
  return trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed;
}

export function normalizeDocxControlTag(tag: string) {
  const normalized = tag.trim().toLowerCase().replace(/[ \t]+/gu, "_");
  return CONTROL_TAG_RE.test(normalized) ? normalized : null;
}

function nextControl(state: ParseState, tag: string) {
  const occurrence = state.controlCounts.get(tag) ?? 0;
  state.controlCounts.set(tag, occurrence + 1);
  return { type: "control", tag, occurrence } as const;
}

function warnLiteralMarkers(text: string, warnings: string[]) {
  if (text.includes("{{") || text.includes("}}")) {
    warn(
      warnings,
      `Kept malformed content-control marker in "${snippet(text)}" as literal text.`,
    );
  }
  if (text.includes("[^")) {
    warn(
      warnings,
      `Kept malformed footnote reference in "${snippet(text)}" as literal text.`,
    );
  }
  if (text.includes("[@")) {
    warn(
      warnings,
      `Kept malformed citation marker in "${snippet(text)}" as literal text.`,
    );
  }
}

function unescapeMarkdown(text: string) {
  return text.replace(/\\([\\`*_{}\[\]()#+.!|>-])/gu, "$1");
}

function parseInline(
  text: string,
  state: ParseState,
  allowFootnoteReferences = true,
): DocxMarkdownInline[] {
  const children: DocxMarkdownInline[] = [];
  let cursor = 0;

  for (const match of text.matchAll(CONTROL_OR_NOTE_RE)) {
    const index = match.index;
    if (index > cursor) {
      const plain = text.slice(cursor, index);
      warnLiteralMarkers(plain, state.warnings);
      children.push({ type: "text", text: unescapeMarkdown(plain) });
    }

    const token = match[0];
    const footnote = token.match(FOOTNOTE_REFERENCE_RE);
    const citation = token.match(CITATION_RE);
    const control = token.match(CONTROL_RE);
    if (footnote) {
      if (!allowFootnoteReferences) {
        warn(
          state.warnings,
          `Removed footnote reference "[^${footnote[1]}]" inside a footnote; footnotes cannot reference footnotes.`,
        );
      } else {
        state.referencedNotes.add(footnote[1]);
        children.push({ type: "footnote", id: footnote[1] });
      }
    } else if (citation) {
      children.push({ type: "citation", id: citation[1] });
    } else if (control) {
      const tag = normalizeDocxControlTag(control[1]);
      if (!tag) {
        warn(
          state.warnings,
          `Kept malformed content-control marker "${snippet(token)}" as literal text.`,
        );
        children.push({ type: "text", text: token });
      } else {
        children.push(nextControl(state, tag));
      }
    } else {
      const strong = token.startsWith("**");
      const value = token.slice(strong ? 2 : 1, strong ? -2 : -1);
      for (const child of parseInline(value, state, allowFootnoteReferences)) {
        if (child.type === "text" || child.type === "emphasis") {
          children.push({
            type: strong ? "strong" : "emphasis",
            text: child.text,
          });
        } else {
          children.push(child);
        }
      }
    }
    cursor = index + token.length;
  }

  if (cursor < text.length) {
    const plain = text.slice(cursor);
    warnLiteralMarkers(plain, state.warnings);
    children.push({ type: "text", text: unescapeMarkdown(plain) });
  }
  return children;
}

function listItem(line: string) {
  const match = line.match(
    /^([ \t]*)([-+*]|\d+[.)]|\([a-zA-Z0-9ivxlcIVXLC]+\)|[a-zA-Z][.)])\s+(.+)$/u,
  );
  if (!match) return null;
  const spaces = match[1].replaceAll("\t", "    ").length;
  const marker = match[2];
  const inferredLevel =
    /^\([a-zA-Z]\)$/u.test(marker) || /^[a-zA-Z][.)]$/u.test(marker)
      ? 1
      : /^\((?:[ivxlcIVXLC]{2,}|\d+)\)$/u.test(marker)
        ? 2
        : 0;
  return {
    ordered: !/^[-+*]$/u.test(marker),
    level: Math.min(5, Math.max(Math.floor(spaces / 2), inferredLevel)),
    text: match[3].trim(),
  };
}

function splitInlineLegalList(line: string) {
  const matches = [
    ...line.matchAll(/(?:^|;\s+)(\(([a-z])\))\s+/gu),
  ];
  if (matches.length < 2 || matches[0].index !== 0) return [line];
  for (let index = 1; index < matches.length; index += 1) {
    if (
      matches[index][2].charCodeAt(0) !==
      matches[index - 1][2].charCodeAt(0) + 1
    ) {
      return [line];
    }
  }
  return matches.map((match, index) => {
    const start = match.index! + (match[0].startsWith(";") ? 2 : 0);
    const end = matches[index + 1]?.index ?? line.length;
    return line.slice(start, end).replace(/;\s*$/u, "").trim();
  });
}

function normalizeMarkdownLines(lines: string[]) {
  const normalized = lines.flatMap(splitInlineLegalList);
  for (let index = 0; index < normalized.length; index += 1) {
    if (
      normalized[index].trim() !== "{-}" &&
      !/^#{1,3}\s+\{-\}\s*$/u.test(normalized[index])
    ) {
      continue;
    }
    let previous = index - 1;
    while (previous >= 0 && !normalized[previous].trim()) previous -= 1;
    if (
      previous >= 0 &&
      /^#{1,3}\s+\S/u.test(normalized[previous]) &&
      !/\s+\{[-#][^}]*\}\s*$/u.test(normalized[previous])
    ) {
      normalized[previous] = `${normalized[previous].trimEnd()} {-}`;
    } else {
      let next = index + 1;
      while (next < normalized.length && !normalized[next].trim()) next += 1;
      if (
        next >= 0 &&
        /^#{1,3}\s+\S/u.test(normalized[next]) &&
        !/\s+\{[-#][^}]*\}\s*$/u.test(normalized[next])
      ) {
        normalized[next] = `${normalized[next].trimEnd()} {-}`;
      }
    }
    normalized[index] = "";
  }
  return normalized;
}

function hasExplicitLegalNumbering(text: string) {
  return /^(?:(?:part|article|section|schedule)\s+(?:\d+|[ivxlc]+)\b|\d+(?:\.\d+)*[.)]?\s+|\([a-z0-9ivxlc]+\)\s+)/iu.test(
    text,
  );
}

function splitTableRow(line: string): string[] {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|") && !value.endsWith("\\|")) value = value.slice(0, -1);

  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\\" && value[index + 1] === "|") {
      cell += "|";
      index += 1;
    } else if (value[index] === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += value[index];
    }
  }
  cells.push(cell.trim());
  return cells;
}

function isTable(lines: string[], index: number) {
  if (!lines[index]?.includes("|") || !lines[index + 1]?.includes("|")) {
    return false;
  }
  const headers = splitTableRow(lines[index]);
  const delimiters = splitTableRow(lines[index + 1]);
  return (
    headers.length === delimiters.length &&
    delimiters.every((cell) => /^:?-{3,}:?$/u.test(cell))
  );
}

function parseHeading(
  line: string,
  bookmarks: Set<string>,
  state: ParseState,
): Extract<DocxMarkdownBlock, { type: "heading" }> | "skip" | null {
  const match = line.match(/^(#{1,3})\s+(.+)$/u);
  if (!match) return null;

  let text = match[2].trim();
  let numbered = true;
  let bookmark: string | undefined;
  const attributes: string[] = [];
  while (true) {
    const attribute = text.match(/(?:^|\s+)\{(-|#[^{}]*)\}$/u);
    if (!attribute) break;
    text = text.slice(0, attribute.index).trimEnd();
    attributes.unshift(attribute[1]);
  }
  for (const attribute of attributes) {
    if (attribute === "-") {
      if (!numbered) {
        warn(
          state.warnings,
          `Ignored a repeated {-} attribute on heading "${snippet(line)}".`,
        );
      }
      numbered = false;
      continue;
    }
    const candidate = attribute.slice(1);
    if (bookmark) {
      warn(
        state.warnings,
        `Ignored extra bookmark "${candidate}" on heading "${snippet(line)}"; kept "${bookmark}".`,
      );
      continue;
    }
    if (!BOOKMARK_ID.test(candidate)) {
      warn(
        state.warnings,
        `Dropped invalid bookmark "${candidate}"; use 1-40 letters, numbers, or underscores, beginning with a letter.`,
      );
      continue;
    }
    if (bookmarks.has(candidate)) {
      warn(state.warnings, `Dropped duplicate bookmark "${candidate}".`);
      continue;
    }
    bookmark = candidate;
    bookmarks.add(bookmark);
  }
  if (/\s+\{[#-][^}]*\}$/u.test(text)) {
    warn(
      state.warnings,
      `Kept unrecognized heading attribute in "${snippet(line)}" as literal text.`,
    );
  }
  if (!text) {
    warn(
      state.warnings,
      `Skipped heading "${snippet(line)}" because it has no text.`,
    );
    return "skip";
  }

  return {
    type: "heading",
    level: match[1].length as 1 | 2 | 3,
    numbered: numbered && !hasExplicitLegalNumbering(text),
    bookmark,
    children: parseInline(text, state),
  };
}

function extractFootnotes(lines: string[], warnings: string[]) {
  const definitions: { id: string; text: string }[] = [];
  const body: string[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(FOOTNOTE_DEFINITION_RE);
    if (!match) {
      if (/^\[\^[^\]]*\]:/u.test(lines[index])) {
        warn(
          warnings,
          `Treated invalid footnote definition "${snippet(lines[index])}" as body text.`,
        );
      }
      body.push(lines[index]);
      continue;
    }
    const parts = [match[2].trim()];
    while (
      index + 1 < lines.length &&
      /^(?: {2,}|\t)\S/u.test(lines[index + 1])
    ) {
      index += 1;
      parts.push(lines[index].trim());
    }
    body.push("");
    if (ids.has(match[1])) {
      warn(
        warnings,
        `Ignored duplicate footnote definition "${match[1]}"; the first definition wins.`,
      );
      continue;
    }
    const text = parts.filter(Boolean).join(" ");
    if (!text) {
      warn(warnings, `Dropped empty footnote "${match[1]}".`);
      continue;
    }
    ids.add(match[1]);
    definitions.push({ id: match[1], text });
  }
  return { definitions, body };
}

function beginsBlock(lines: string[], index: number) {
  const trimmed = lines[index]?.trim() ?? "";
  return (
    !trimmed ||
    trimmed === "<!-- pagebreak -->" ||
    /^#{1,3}\s+/u.test(lines[index]) ||
    CONTROL_ONLY_RE.test(lines[index]) ||
    listItem(lines[index]) !== null ||
    isTable(lines, index)
  );
}

function mapInlineArrays(
  blocks: DocxMarkdownBlock[],
  transform: (children: DocxMarkdownInline[]) => DocxMarkdownInline[],
) {
  for (const block of blocks) {
    if (block.type === "heading" || block.type === "paragraph") {
      block.children = transform(block.children);
    } else if (block.type === "list") {
      for (const item of block.items) item.children = transform(item.children);
    } else if (block.type === "table") {
      block.headers = block.headers.map(transform);
      block.rows = block.rows.map((row) => row.map(transform));
    }
  }
}

export function parseDocxMarkdown(
  markdown: string,
  warnings: string[] = [],
): DocxMarkdownDocument {
  if (typeof markdown !== "string" || !markdown.trim()) {
    throw new Error("Markdown must not be empty.");
  }
  if (markdown.length > 1_000_000) {
    throw new Error("Markdown exceeds the 1 MB document limit.");
  }

  const state: ParseState = {
    controlCounts: new Map(),
    referencedNotes: new Set(),
    warnings,
  };
  const bookmarks = new Set<string>();
  const { definitions, body } = extractFootnotes(
    normalizeMarkdownLines(
      markdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n"),
    ),
    warnings,
  );
  const blocks: DocxMarkdownBlock[] = [];

  for (let index = 0; index < body.length; ) {
    const line = body[index];
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }
    if (trimmed === "<!-- pagebreak -->") {
      blocks.push({ type: "page-break" });
      index += 1;
      continue;
    }

    const heading = parseHeading(line, bookmarks, state);
    if (heading === "skip") {
      index += 1;
      continue;
    }
    if (heading) {
      blocks.push(heading);
      index += 1;
      continue;
    }

    const control = line.match(CONTROL_ONLY_RE);
    if (control) {
      const tag = normalizeDocxControlTag(control[1]);
      if (!tag) {
        warn(
          warnings,
          `Kept malformed content-control marker "${snippet(trimmed)}" as literal text.`,
        );
        blocks.push({
          type: "paragraph",
          children: [{ type: "text", text: trimmed }],
        });
      } else {
        blocks.push(nextControl(state, tag));
      }
      index += 1;
      continue;
    }

    const firstItem = listItem(line);
    if (firstItem) {
      const items: Extract<DocxMarkdownBlock, { type: "list" }>["items"] = [];
      while (index < body.length) {
        const item = listItem(body[index]);
        if (!item) break;
        items.push({
          ordered: item.ordered,
          level: item.level,
          children: parseInline(item.text, state),
        });
        index += 1;
      }
      blocks.push({ type: "list", items });
      continue;
    }

    if (isTable(body, index)) {
      const headers = splitTableRow(body[index]);
      index += 2;
      const rows: string[][] = [];
      while (index < body.length && body[index].includes("|")) {
        const row = splitTableRow(body[index]);
        if (row.length !== headers.length) {
          warn(
            warnings,
            `Adjusted a table row from ${row.length} to ${headers.length} cells to match the header.`,
          );
          if (row.length > headers.length) {
            row.splice(
              headers.length - 1,
              row.length,
              row.slice(headers.length - 1).join(" "),
            );
          } else {
            while (row.length < headers.length) row.push("");
          }
        }
        rows.push(row);
        index += 1;
      }
      blocks.push({
        type: "table",
        headers: headers.map((cell) => parseInline(cell, state)),
        rows: rows.map((row) => row.map((cell) => parseInline(cell, state))),
      });
      continue;
    }

    const paragraph = [trimmed];
    index += 1;
    while (index < body.length && !beginsBlock(body, index)) {
      paragraph.push(body[index].trim());
      index += 1;
    }
    blocks.push({
      type: "paragraph",
      children: parseInline(paragraph.join(" "), state),
    });
  }

  const definitionIds = new Set(definitions.map(({ id }) => id));
  for (const id of state.referencedNotes) {
    if (!definitionIds.has(id)) {
      warn(
        warnings,
        `Removed footnote marker "[^${id}]" because it has no definition.`,
      );
    }
  }
  mapInlineArrays(blocks, (children) =>
    children.filter(
      (child) => child.type !== "footnote" || definitionIds.has(child.id),
    ),
  );
  const footnotes = definitions
    .filter(({ id }) => {
      if (state.referencedNotes.has(id)) return true;
      warn(
        warnings,
        `Dropped footnote definition "${id}" because it is never referenced.`,
      );
      return false;
    })
    .map(({ id, text }) => ({
      id,
      children: parseInline(text, state, false),
    }));
  return { blocks, footnotes };
}

function contentControlId(seed: string) {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash = Math.imul(hash ^ seed.charCodeAt(index), 16777619);
  }
  return hash >>> 1 || 1;
}

function controlLabel(tag: string) {
  const label = tag.replace(/[._-]+/gu, " ");
  return label[0].toUpperCase() + label.slice(1);
}

function collectControlTags(document: DocxMarkdownDocument) {
  const tags = new Set<string>();
  const visit = (children: DocxMarkdownInline[]) => {
    for (const child of children) {
      if (child.type === "control") tags.add(child.tag);
    }
  };
  for (const block of document.blocks) {
    if (block.type === "control") tags.add(block.tag);
    else if ("children" in block) visit(block.children);
    else if (block.type === "list")
      block.items.forEach((item) => visit(item.children));
    else if (block.type === "table") {
      block.headers.forEach(visit);
      block.rows.forEach((row) => row.forEach(visit));
    }
  }
  document.footnotes.forEach((footnote) => visit(footnote.children));
  return tags;
}

function collectCitationIds(document: DocxMarkdownDocument) {
  const ids = new Set<string>();
  const visit = (children: DocxMarkdownInline[]) => {
    for (const child of children) {
      if (child.type === "citation") ids.add(child.id);
    }
  };
  for (const block of document.blocks) {
    if ("children" in block) visit(block.children);
    else if (block.type === "list")
      block.items.forEach((item) => visit(item.children));
    else if (block.type === "table") {
      block.headers.forEach(visit);
      block.rows.forEach((row) => row.forEach(visit));
    }
  }
  document.footnotes.forEach((footnote) => visit(footnote.children));
  return ids;
}

function inlineText(children: DocxMarkdownInline[]) {
  return children
    .map((child) =>
      child.type === "text" ||
      child.type === "strong" ||
      child.type === "emphasis"
        ? child.text
        : "",
    )
    .join("");
}

function titleKey(value: string) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export async function renderDocxMarkdown(
  markdown: string,
  options: RenderDocxMarkdownOptions = {},
  warnings: string[] = [],
): Promise<Buffer> {
  return renderDocxMarkdownDocument(
    parseDocxMarkdown(markdown, warnings),
    options,
    warnings,
  );
}

export async function renderDocxMarkdownDocument(
  document: DocxMarkdownDocument,
  options: RenderDocxMarkdownOptions = {},
  warnings: string[] = [],
): Promise<Buffer> {
  const controls = collectControlTags(document);
  const citationIds = collectCitationIds(document);
  const citations = options.citations ?? {};
  const unverifiedCitations = new Set<string>();
  for (const id of citationIds) {
    if (!Object.hasOwn(citations, id)) {
      warn(
        warnings,
        `Removed citation marker "[@${id}]" because it has no verified source.`,
      );
      unverifiedCitations.add(id);
    }
  }
  for (const [id, citation] of Object.entries(citations)) {
    if (!citationIds.has(id)) {
      warn(
        warnings,
        `Omitted verified citation "${id}" because the text has no [@${id}] marker.`,
      );
      continue;
    }
    if (
      !citation ||
      typeof citation.text !== "string" ||
      !citation.text.trim() ||
      citation.text.length > 1_000 ||
      typeof citation.url !== "string"
    ) {
      throw new Error(`Verified citation "${id}" is invalid.`);
    }
    let parsed: URL;
    try {
      parsed = new URL(citation.url);
    } catch {
      throw new Error(`Verified citation "${id}" has an invalid URL.`);
    }
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error(`Verified citation "${id}" has an unsafe URL.`);
    }
  }
  let valuesLength = 0;
  const values: Record<string, string> = {};
  for (const [rawTag, value] of Object.entries(options.values ?? {})) {
    const tag = normalizeDocxControlTag(rawTag);
    if (!tag) {
      warn(
        warnings,
        `Ignored content-control value with invalid key "${snippet(rawTag)}".`,
      );
      continue;
    }
    if (Object.hasOwn(values, tag)) {
      warn(
        warnings,
        `Ignored duplicate content-control value "${tag}"; the first value wins.`,
      );
      continue;
    }
    if (typeof value !== "string") {
      warn(warnings, `Ignored non-text content-control value "${tag}".`);
      continue;
    }
    if (!controls.has(tag)) {
      warn(
        warnings,
        `Ignored content-control value "${tag}" because the text has no {{${tag}}} marker.`,
      );
      continue;
    }
    if (value.length > 20_000) {
      throw new Error(
        `Content-control value "${tag}" exceeds 20,000 characters.`,
      );
    }
    valuesLength += value.length;
    if (valuesLength > 200_000) {
      throw new Error(
        "Content-control values exceed 200,000 characters in total.",
      );
    }
    values[tag] = value;
  }

  const {
    AlignmentType,
    Bookmark,
    BorderStyle,
    Document,
    ExternalHyperlink,
    Footer,
    FootnoteReferenceRun,
    HeadingLevel,
    ImportedXmlComponent,
    LevelFormat,
    LevelSuffix,
    Packer,
    PageBreak,
    PageNumber,
    PageOrientation,
    Paragraph,
    Table,
    TableCell,
    TableLayoutType,
    TableRow,
    TextRun,
    WidthType,
  } = await import("docx");

  const font = "Times New Roman";
  const size = 22;
  const tableWidth = options.landscape ? 12_960 : 9_360;
  const usedControlIds = new Set<number>();
  const nextId = (tag: string, occurrence: number) => {
    let id = contentControlId(`${tag}:${occurrence}`);
    while (usedControlIds.has(id)) id = id === 0x7fffffff ? 1 : id + 1;
    usedControlIds.add(id);
    return id;
  };
  const imported = (
    name: string,
    attributes?: Record<string, string>,
    nested: (
      | InstanceType<typeof ImportedXmlComponent>
      | InstanceType<typeof Paragraph>
      | string
    )[] = [],
  ) => {
    const element = new ImportedXmlComponent(name, attributes);
    nested.forEach((child) => element.push(child));
    return element;
  };
  const run = (
    text: string,
    format: { bold?: boolean; italics?: boolean } = {},
  ) => new TextRun({ text, ...format });
  const controlProperties = (
    tag: string,
    occurrence: number,
    inline: boolean,
  ) =>
    imported("w:sdtPr", undefined, [
      imported("w:alias", { "w:val": controlLabel(tag) }),
      imported("w:tag", { "w:val": tag }),
      imported("w:id", { "w:val": String(nextId(tag, occurrence)) }),
      ...(inline ? [imported("w:text")] : []),
    ]);
  const controlValue = (tag: string) =>
    values[tag] ?? `[${controlLabel(tag)}]`;
  const inlineControl = (tag: string, occurrence: number) => {
    let value = controlValue(tag);
    if (/[\r\n]/u.test(value)) {
      warn(
        warnings,
        `Joined the multi-line value for inline control "${tag}" onto one line.`,
      );
      value = value.replace(/\s*\r?\n\s*/gu, " ").trim();
    }
    return imported("w:sdt", undefined, [
      controlProperties(tag, occurrence, true),
      imported("w:sdtContent", undefined, [
        imported("w:r", undefined, [
          imported("w:t", { "xml:space": "preserve" }, [value]),
        ]),
      ]),
    ]) as unknown as ParagraphChild;
  };

  const noteNumbers = new Map(
    document.footnotes.map((footnote, index) => [footnote.id, index + 1]),
  );
  const inlines = (
    children: DocxMarkdownInline[],
    forceBold = false,
  ): ParagraphChild[] =>
    children.flatMap((child): ParagraphChild[] => {
      switch (child.type) {
        case "text":
          return [run(child.text, { bold: forceBold })];
        case "strong":
          return [run(child.text, { bold: true })];
        case "emphasis":
          return [run(child.text, { bold: forceBold, italics: true })];
        case "footnote":
          return [new FootnoteReferenceRun(noteNumbers.get(child.id)!)];
        case "citation": {
          if (unverifiedCitations.has(child.id)) return [];
          const citation = citations[child.id];
          return [
            new ExternalHyperlink({
              link: citation.url,
              children: [
                new TextRun({
                  text: citation.text,
                  style: "Hyperlink",
                }),
              ],
            }),
          ];
        }
        case "control":
          return [inlineControl(child.tag, child.occurrence)];
      }
    });

  const headingLevels = [
    HeadingLevel.HEADING_1,
    HeadingLevel.HEADING_2,
    HeadingLevel.HEADING_3,
  ];
  const headingNumbering = "markdown-headings";
  const blocks: (
    | InstanceType<typeof Paragraph>
    | InstanceType<typeof Table>
  )[] = [];
  const title = options.title?.trim();
  if (title) {
    blocks.push(
      new Paragraph({
        heading: HeadingLevel.TITLE,
        alignment: AlignmentType.CENTER,
        children: [run(title, { bold: true })],
      }),
    );
  }
  const listReferences = new Map<string, boolean>();

  for (const [blockIndex, block] of document.blocks.entries()) {
    if (blockIndex === 0 && title && block.type === "heading") {
      const headingKey = titleKey(inlineText(block.children));
      const documentTitleKey = titleKey(title);
      if (
        headingKey.length >= 12 &&
        (headingKey === documentTitleKey ||
          documentTitleKey.includes(headingKey))
      ) {
        continue;
      }
    }
    if (block.type === "page-break") {
      blocks.push(new Paragraph({ children: [new PageBreak()] }));
    } else if (block.type === "heading") {
      const children = inlines(block.children, true);
      blocks.push(
        new Paragraph({
          heading: headingLevels[block.level - 1],
          numbering: block.numbered
            ? { reference: headingNumbering, level: block.level - 1 }
            : undefined,
          children: block.bookmark
            ? [new Bookmark({ id: block.bookmark, children })]
            : children,
        }),
      );
    } else if (block.type === "paragraph") {
      blocks.push(
        new Paragraph({
          children: inlines(block.children),
        }),
      );
    } else if (block.type === "control") {
      const value = controlValue(block.tag);
      const paragraphs = (
        value.split(/\r?\n/u).length ? value.split(/\r?\n/u) : [""]
      ).map((line) => new Paragraph({ children: [run(line)] }));
      blocks.push(
        imported("w:sdt", undefined, [
          controlProperties(block.tag, block.occurrence, false),
          imported("w:sdtContent", undefined, paragraphs),
        ]) as unknown as InstanceType<typeof Paragraph>,
      );
    } else if (block.type === "list") {
      for (const item of block.items) {
        const reference = `markdown-list-${blockIndex}-${item.ordered ? "ordered" : "bullet"}`;
        listReferences.set(reference, item.ordered);
        blocks.push(
          new Paragraph({
            numbering: { reference, level: item.level },
            children: inlines(item.children),
          }),
        );
      }
    } else {
      const border = {
        style: BorderStyle.SINGLE,
        size: 2,
        color: "B8B8B8",
      };
      const columnWidth = Math.floor(tableWidth / block.headers.length);
      const columnWidths = block.headers.map((_, index) =>
        index === block.headers.length - 1
          ? tableWidth - columnWidth * index
          : columnWidth,
      );
      const tableRows = [
        new TableRow({
          tableHeader: true,
          children: block.headers.map(
            (cell, index) =>
              new TableCell({
                width: {
                  size: columnWidths[index],
                  type: WidthType.DXA,
                },
                borders: {
                  top: border,
                  bottom: border,
                  left: border,
                  right: border,
                },
                shading: { fill: "EDEDED" },
                children: [
                  new Paragraph({
                    style: "LegalTableText",
                    children: inlines(cell, true),
                  }),
                ],
              }),
          ),
        }),
        ...block.rows.map(
          (row) =>
            new TableRow({
              children: row.map(
                (cell, index) =>
                  new TableCell({
                    width: {
                      size: columnWidths[index],
                      type: WidthType.DXA,
                    },
                    borders: {
                      top: border,
                      bottom: border,
                      left: border,
                      right: border,
                    },
                    children: [
                      new Paragraph({
                        style: "LegalTableText",
                        children: inlines(cell),
                      }),
                    ],
                  }),
              ),
            }),
        ),
      ];
      blocks.push(
        new Table({
          width: { size: tableWidth, type: WidthType.DXA },
          columnWidths,
          layout: TableLayoutType.FIXED,
          margins: {
            marginUnitType: WidthType.DXA,
            top: 80,
            bottom: 80,
            left: 120,
            right: 120,
          },
          rows: tableRows,
        }),
      );
    }
  }

  const numberingLevel = (
    level: number,
    format: (typeof LevelFormat)[keyof typeof LevelFormat],
    text: string,
    bold = false,
    legal = false,
  ) => ({
    level,
    format,
    text,
    alignment: AlignmentType.START,
    suffix: LevelSuffix.TAB,
    isLegalNumberingStyle: legal,
    style: {
      paragraph: {
        indent: { left: 360 + level * 360, hanging: 360 },
        spacing: { after: 80 },
      },
      run: { bold, font, size },
    },
  });
  const headingLevelsConfig = [
    numberingLevel(0, LevelFormat.DECIMAL, "%1.", true, true),
    numberingLevel(1, LevelFormat.DECIMAL, "%1.%2", true, true),
    numberingLevel(2, LevelFormat.DECIMAL, "%1.%2.%3", true, true),
  ];
  const listFormats = [
    LevelFormat.DECIMAL,
    LevelFormat.LOWER_LETTER,
    LevelFormat.LOWER_ROMAN,
    LevelFormat.UPPER_LETTER,
    LevelFormat.UPPER_ROMAN,
    LevelFormat.DECIMAL,
  ];
  const listText = ["%1.", "(%2)", "(%3)", "(%4)", "(%5)", "%6."];
  const orderedListLevels = listFormats.map((format, level) =>
    numberingLevel(level, format, listText[level]),
  );
  const bulletText = ["•", "–", "▪", "•", "–", "▪"];
  const bulletListLevels = bulletText.map((text, level) =>
    numberingLevel(level, LevelFormat.BULLET, text),
  );
  const footnotes = Object.fromEntries(
    document.footnotes.map((footnote, index) => [
      String(index + 1),
      {
        children: [
          new Paragraph({
            style: "FootnoteText",
            children: inlines(footnote.children),
          }),
        ],
      },
    ]),
  );
  const docx = new Document({
    title,
    creator: "Beaver",
    description: "Generated from Beaver semantic Markdown.",
    styles: {
      default: {
        document: {
          run: { font, size, color: "000000" },
          paragraph: {
            spacing: { line: 264, after: 80 },
          },
        },
        title: {
          run: { font, size: 28, bold: true, color: "000000" },
          paragraph: {
            alignment: AlignmentType.CENTER,
            spacing: { before: 0, after: 240 },
            keepNext: true,
            keepLines: true,
          },
        },
        heading1: {
          run: { font, size: 26, bold: true, color: "000000" },
          paragraph: {
            spacing: { before: 240, after: 80 },
            keepNext: true,
            keepLines: true,
          },
        },
        heading2: {
          run: { font, size: 24, bold: true, color: "000000" },
          paragraph: {
            spacing: { before: 180, after: 60 },
            keepNext: true,
            keepLines: true,
          },
        },
        heading3: {
          run: { font, size: 22, bold: true, color: "000000" },
          paragraph: {
            spacing: { before: 140, after: 40 },
            keepNext: true,
            keepLines: true,
          },
        },
        heading4: {
          run: { font, size: 22, bold: true, color: "000000" },
          paragraph: {
            spacing: { before: 120, after: 40 },
            keepNext: true,
            keepLines: true,
          },
        },
        heading5: {
          run: { font, size: 22, bold: true, color: "000000" },
          paragraph: {
            spacing: { before: 100, after: 40 },
            keepNext: true,
            keepLines: true,
          },
        },
        heading6: {
          run: { font, size: 22, bold: true, color: "000000" },
          paragraph: {
            spacing: { before: 80, after: 40 },
            keepNext: true,
            keepLines: true,
          },
        },
        listParagraph: {
          run: { font, size, color: "000000" },
          paragraph: {
            spacing: { line: 264, after: 40 },
          },
        },
        footnoteText: {
          run: { font, size: 18, color: "000000" },
          paragraph: {
            spacing: { line: 240, after: 40 },
          },
        },
        hyperlink: {
          run: { color: "0563C1", underline: {} },
        },
      },
      paragraphStyles: [
        {
          id: "LegalTableText",
          name: "Legal Table Text",
          basedOn: "Normal",
          next: "LegalTableText",
          run: { font, size: 20, color: "000000" },
          paragraph: {
            spacing: { line: 240, after: 20 },
          },
        },
      ],
    },
    numbering: {
      config: [
        { reference: headingNumbering, levels: headingLevelsConfig },
        ...[...listReferences].map(([reference, ordered]) => ({
          reference,
          levels: ordered ? orderedListLevels : bulletListLevels,
        })),
      ],
    },
    footnotes,
    sections: [
      {
        properties: {
          page: {
            size: options.landscape
              ? { orientation: PageOrientation.LANDSCAPE }
              : undefined,
            margin: {
              top: 1_440,
              right: 1_440,
              bottom: 1_440,
              left: 1_440,
              header: 720,
              footer: 720,
            },
          },
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({
                    children: [PageNumber.CURRENT],
                    font,
                    size: 18,
                    color: "666666",
                  }),
                ],
              }),
            ],
          }),
        },
        children: blocks,
      },
    ],
  });
  return Packer.toBuffer(docx);
}
