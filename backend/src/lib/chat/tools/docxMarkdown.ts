import type { ParagraphChild } from "docx";

export type DocxMarkdownInline =
  | { type: "text"; text: string }
  | { type: "strong"; text: string }
  | { type: "emphasis"; text: string }
  | { type: "footnote"; id: string }
  | { type: "citation"; id: string }
  | { type: "control"; tag: string; occurrence: number };

export type DocxMarkdownBlock =
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
const NOTE_ID = "[A-Za-z0-9][A-Za-z0-9_.-]{0,63}";
const CITATION_ID = "[a-z][a-z0-9_-]{0,63}";
const BOOKMARK_ID = /^[A-Za-z][A-Za-z0-9_]{0,39}$/u;
const CONTROL_ONLY_RE = new RegExp(
  `^\\s*\\{\\{(${CONTROL_TAG})\\}\\}\\s*$`,
  "u",
);
const CONTROL_OR_NOTE_RE = new RegExp(
  `(\\[\\^${NOTE_ID}\\]|\\[@${CITATION_ID}\\]|\\{\\{${CONTROL_TAG}\\}\\}|\\*\\*[^*\\n]+\\*\\*|\\*[^*\\n]+\\*)`,
  "gu",
);
const FOOTNOTE_DEFINITION_RE = new RegExp(
  `^\\[\\^(${NOTE_ID})\\]:\\s*(.*)$`,
  "u",
);
const FOOTNOTE_REFERENCE_RE = new RegExp(`^\\[\\^(${NOTE_ID})\\]$`, "u");
const CITATION_RE = new RegExp(`^\\[@(${CITATION_ID})\\]$`, "u");
const CONTROL_RE = new RegExp(`^\\{\\{(${CONTROL_TAG})\\}\\}$`, "u");

type ParseState = {
  controlCounts: Map<string, number>;
  referencedNotes: Set<string>;
};

function nextControl(state: ParseState, tag: string) {
  const occurrence = state.controlCounts.get(tag) ?? 0;
  state.controlCounts.set(tag, occurrence + 1);
  return { type: "control", tag, occurrence } as const;
}

function assertPlainText(text: string) {
  if (text.includes("{{") || text.includes("}}")) {
    throw new Error(`Invalid content-control marker in "${text}".`);
  }
  if (text.includes("[^")) {
    throw new Error(`Invalid footnote reference in "${text}".`);
  }
  if (text.includes("[@")) {
    throw new Error(`Invalid citation marker in "${text}".`);
  }
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
      assertPlainText(plain);
      children.push({ type: "text", text: plain });
    }

    const token = match[0];
    const footnote = token.match(FOOTNOTE_REFERENCE_RE);
    const citation = token.match(CITATION_RE);
    const control = token.match(CONTROL_RE);
    if (footnote) {
      if (!allowFootnoteReferences) {
        throw new Error("Footnotes cannot contain footnote references.");
      }
      state.referencedNotes.add(footnote[1]);
      children.push({ type: "footnote", id: footnote[1] });
    } else if (citation) {
      children.push({ type: "citation", id: citation[1] });
    } else if (control) {
      children.push(nextControl(state, control[1]));
    } else {
      const strong = token.startsWith("**");
      const value = token.slice(strong ? 2 : 1, strong ? -2 : -1);
      assertPlainText(value);
      children.push({
        type: strong ? "strong" : "emphasis",
        text: value,
      });
    }
    cursor = index + token.length;
  }

  if (cursor < text.length) {
    const plain = text.slice(cursor);
    assertPlainText(plain);
    children.push({ type: "text", text: plain });
  }
  return children;
}

function listItem(line: string) {
  const match = line.match(/^([ \t]*)([-+*]|\d+[.)])\s+(.+)$/u);
  if (!match) return null;
  const spaces = match[1].replaceAll("\t", "    ").length;
  return {
    ordered: /^\d/u.test(match[2]),
    level: Math.min(5, Math.floor(spaces / 2)),
    text: match[3].trim(),
  };
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
): Extract<DocxMarkdownBlock, { type: "heading" }> | null {
  const match = line.match(/^(#{1,3})\s+(.+)$/u);
  if (!match) return null;

  let text = match[2].trim();
  let numbered = true;
  let bookmark: string | undefined;
  while (true) {
    const attribute = text.match(/\s+\{(-|#[^{}]+)\}$/u);
    if (!attribute) break;
    text = text.slice(0, attribute.index).trimEnd();
    if (attribute[1] === "-") {
      if (!numbered) throw new Error("Heading repeats the {-} attribute.");
      numbered = false;
      continue;
    }
    if (bookmark) throw new Error("Heading defines more than one bookmark.");
    bookmark = attribute[1].slice(1);
    if (!BOOKMARK_ID.test(bookmark)) {
      throw new Error(
        `Invalid bookmark "${bookmark}"; use 1-40 letters, numbers, or underscores, beginning with a letter.`,
      );
    }
    if (bookmarks.has(bookmark)) {
      throw new Error(`Duplicate bookmark "${bookmark}".`);
    }
    bookmarks.add(bookmark);
  }
  if (/\s+\{[#-][^}]*\}$/u.test(text)) {
    throw new Error(`Invalid heading attribute in "${line}".`);
  }
  if (!text) throw new Error("Heading text cannot be empty.");

  return {
    type: "heading",
    level: match[1].length as 1 | 2 | 3,
    numbered,
    bookmark,
    children: parseInline(text, state),
  };
}

function extractFootnotes(lines: string[]) {
  const definitions: { id: string; text: string }[] = [];
  const body: string[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(FOOTNOTE_DEFINITION_RE);
    if (!match) {
      if (/^\[\^[^\]]*\]:/u.test(lines[index])) {
        throw new Error(`Invalid footnote definition "${lines[index]}".`);
      }
      body.push(lines[index]);
      continue;
    }
    if (ids.has(match[1])) {
      throw new Error(`Duplicate footnote definition "${match[1]}".`);
    }
    ids.add(match[1]);
    const parts = [match[2].trim()];
    while (
      index + 1 < lines.length &&
      /^(?: {2,}|\t)\S/u.test(lines[index + 1])
    ) {
      index += 1;
      parts.push(lines[index].trim());
    }
    const text = parts.filter(Boolean).join(" ");
    if (!text) throw new Error(`Footnote "${match[1]}" is empty.`);
    definitions.push({ id: match[1], text });
    body.push("");
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

export function parseDocxMarkdown(markdown: string): DocxMarkdownDocument {
  if (typeof markdown !== "string" || !markdown.trim()) {
    throw new Error("Markdown must not be empty.");
  }
  if (markdown.length > 1_000_000) {
    throw new Error("Markdown exceeds the 1 MB document limit.");
  }

  const state: ParseState = {
    controlCounts: new Map(),
    referencedNotes: new Set(),
  };
  const bookmarks = new Set<string>();
  const { definitions, body } = extractFootnotes(
    markdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n"),
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
    if (heading) {
      blocks.push(heading);
      index += 1;
      continue;
    }

    const control = line.match(CONTROL_ONLY_RE);
    if (control) {
      blocks.push(nextControl(state, control[1]));
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
          throw new Error(
            `Table row has ${row.length} cells; expected ${headers.length}.`,
          );
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

  const footnotes = definitions.map(({ id, text }) => ({
    id,
    children: parseInline(text, state, false),
  }));
  const definitionIds = new Set(definitions.map(({ id }) => id));
  for (const id of state.referencedNotes) {
    if (!definitionIds.has(id)) {
      throw new Error(`Footnote reference "${id}" has no definition.`);
    }
  }
  for (const id of definitionIds) {
    if (!state.referencedNotes.has(id)) {
      throw new Error(`Footnote definition "${id}" is not referenced.`);
    }
  }
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

export async function renderDocxMarkdown(
  markdown: string,
  options: RenderDocxMarkdownOptions = {},
): Promise<Buffer> {
  return renderDocxMarkdownDocument(parseDocxMarkdown(markdown), options);
}

export async function renderDocxMarkdownDocument(
  document: DocxMarkdownDocument,
  options: RenderDocxMarkdownOptions = {},
): Promise<Buffer> {
  const controls = collectControlTags(document);
  const citationIds = collectCitationIds(document);
  const citations = options.citations ?? {};
  for (const id of citationIds) {
    if (!Object.hasOwn(citations, id)) {
      throw new Error(`Citation marker "${id}" has no verified source.`);
    }
  }
  for (const [id, citation] of Object.entries(citations)) {
    if (!citationIds.has(id)) {
      throw new Error(`Verified citation "${id}" has no marker.`);
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
  for (const [tag, value] of Object.entries(options.values ?? {})) {
    if (!new RegExp(`^${CONTROL_TAG}$`, "u").test(tag)) {
      throw new Error(`Invalid content-control value key "${tag}".`);
    }
    if (typeof value !== "string") {
      throw new Error(`Content-control value "${tag}" must be text.`);
    }
    if (!controls.has(tag)) {
      throw new Error(`Content-control value "${tag}" has no marker.`);
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
  }

  const {
    AlignmentType,
    Bookmark,
    BorderStyle,
    Document,
    ExternalHyperlink,
    FootnoteReferenceRun,
    HeadingLevel,
    ImportedXmlComponent,
    LevelFormat,
    LevelSuffix,
    Packer,
    PageBreak,
    PageOrientation,
    Paragraph,
    Table,
    TableCell,
    TableRow,
    TextRun,
    WidthType,
  } = await import("docx");

  const font = "Times New Roman";
  const size = 22;
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
  ) => new TextRun({ text, font, size, ...format });
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
    options.values?.[tag] ?? `[${controlLabel(tag)}]`;
  const inlineControl = (tag: string, occurrence: number) => {
    const value = controlValue(tag);
    if (/[\r\n]/u.test(value)) {
      throw new Error(
        `Inline content-control value "${tag}" cannot span lines.`,
      );
    }
    return imported("w:sdt", undefined, [
      controlProperties(tag, occurrence, true),
      imported("w:sdtContent", undefined, [
        imported("w:r", undefined, [
          imported("w:rPr", undefined, [
            imported("w:rFonts", {
              "w:ascii": font,
              "w:hAnsi": font,
              "w:cs": font,
            }),
            imported("w:sz", { "w:val": String(size) }),
            imported("w:szCs", { "w:val": String(size) }),
          ]),
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
    children.map((child) => {
      switch (child.type) {
        case "text":
          return run(child.text, { bold: forceBold });
        case "strong":
          return run(child.text, { bold: true });
        case "emphasis":
          return run(child.text, { bold: forceBold, italics: true });
        case "footnote":
          return new FootnoteReferenceRun(noteNumbers.get(child.id)!);
        case "citation": {
          const citation = citations[child.id];
          return new ExternalHyperlink({
            link: citation.url,
            children: [
              new TextRun({
                text: citation.text,
                style: "Hyperlink",
                font,
                size,
              }),
            ],
          });
        }
        case "control":
          return inlineControl(child.tag, child.occurrence);
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
        spacing: { after: 200 },
        children: [run(title, { bold: true })],
      }),
    );
  }
  const listReferences: string[] = [];

  for (const [blockIndex, block] of document.blocks.entries()) {
    if (block.type === "page-break") {
      blocks.push(new Paragraph({ children: [new PageBreak()] }));
    } else if (block.type === "heading") {
      const children = inlines(block.children);
      blocks.push(
        new Paragraph({
          heading: headingLevels[block.level - 1],
          numbering: block.numbered
            ? { reference: headingNumbering, level: block.level - 1 }
            : undefined,
          spacing: { before: 160, after: 100 },
          children: block.bookmark
            ? [new Bookmark({ id: block.bookmark, children })]
            : children,
        }),
      );
    } else if (block.type === "paragraph") {
      blocks.push(
        new Paragraph({
          spacing: { after: 120 },
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
      const reference = `markdown-list-${blockIndex}`;
      if (block.items.some((item) => item.ordered)) {
        listReferences.push(reference);
      }
      for (const item of block.items) {
        blocks.push(
          new Paragraph({
            bullet: item.ordered ? undefined : { level: item.level },
            numbering: item.ordered
              ? { reference, level: item.level }
              : undefined,
            spacing: { after: 60 },
            children: inlines(item.children),
          }),
        );
      }
    } else {
      const border = {
        style: BorderStyle.SINGLE,
        size: 1,
        color: "B7B7B7",
      };
      const tableRows = [
        new TableRow({
          tableHeader: true,
          children: block.headers.map(
            (cell) =>
              new TableCell({
                borders: {
                  top: border,
                  bottom: border,
                  left: border,
                  right: border,
                },
                shading: { fill: "F2F2F2" },
                children: [
                  new Paragraph({
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
                (cell) =>
                  new TableCell({
                    borders: {
                      top: border,
                      bottom: border,
                      left: border,
                      right: border,
                    },
                    children: [new Paragraph({ children: inlines(cell) })],
                  }),
              ),
            }),
        ),
      ];
      blocks.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
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
  ) => ({
    level,
    format,
    text,
    alignment: AlignmentType.START,
    suffix: LevelSuffix.TAB,
    isLegalNumberingStyle: true,
    style: {
      paragraph: { indent: { left: 720 + level * 360, hanging: 360 } },
      run: { bold, font, size },
    },
  });
  const headingLevelsConfig = [
    numberingLevel(0, LevelFormat.DECIMAL, "%1.", true),
    numberingLevel(1, LevelFormat.DECIMAL, "%1.%2", true),
    numberingLevel(2, LevelFormat.DECIMAL, "%1.%2.%3", true),
  ];
  const listFormats = [
    LevelFormat.DECIMAL,
    LevelFormat.LOWER_LETTER,
    LevelFormat.LOWER_ROMAN,
    LevelFormat.UPPER_LETTER,
    LevelFormat.UPPER_ROMAN,
    LevelFormat.DECIMAL,
  ];
  const listLevels = listFormats.map((format, level) =>
    numberingLevel(level, format, `%${level + 1}.`),
  );
  const footnotes = Object.fromEntries(
    document.footnotes.map((footnote, index) => [
      String(index + 1),
      {
        children: [
          new Paragraph({
            children: inlines(footnote.children),
          }),
        ],
      },
    ]),
  );
  const docx = new Document({
    numbering: {
      config: [
        { reference: headingNumbering, levels: headingLevelsConfig },
        ...listReferences.map((reference) => ({
          reference,
          levels: listLevels,
        })),
      ],
    },
    footnotes,
    sections: [
      {
        properties: options.landscape
          ? { page: { size: { orientation: PageOrientation.LANDSCAPE } } }
          : {},
        children: blocks,
      },
    ],
  });
  return Packer.toBuffer(docx);
}
