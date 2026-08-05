/**
 * mike_upstream_native_v1 — the pinned upstream DOCX write and read planes.
 *
 * Self-contained port of upstream Mike at UPSTREAM_MIKE_COMMIT (2266446b).
 * Nothing here is imported by any other arm; every entry point is called only
 * from a branch guarded by UPSTREAM_NATIVE_MIKE_SHAPE.
 *
 * Three planes live here because they are the three places where upstream's
 * behaviour is *in the code* rather than in a prompt or a schema:
 *
 *   1. renderUpstreamNativeDocx  — `generateDocx`, ported verbatim from
 *      2266446b:backend/src/lib/chat/tools/documentOps.ts:83-582. Upstream's
 *      legal numbering scheme, title-heading suppression, signature-block
 *      detection and manual-marker level inference all live here; rendering a
 *      deliverable through Beaver's sections[] -> Markdown -> DOCX bridge
 *      instead measures Beaver's renderer (spec deviation D6). The Supabase /
 *      storage / DB tail (:505-578) is replaced by "return the buffer and the
 *      filename"; upstream already strips download_url and storage_path before
 *      the model sees the result (toolDispatcher.ts:560), so the model-visible
 *      payload is unchanged (deviation D4).
 *
 *   2. extractUpstreamNativeDocxBodyText — `extractDocxBodyText`, ported
 *      verbatim from 2266446b:backend/src/lib/docxTrackedChanges.ts:719-750
 *      together with the pinned XML parser options. The working tree's copy has
 *      since been rewritten as a wrapper over extractDocxBodyStructure AND has
 *      fixed a real upstream defect: the pinned parser omits
 *      `parseTagValue: false`, so fast-xml-parser numerically coerces any w:t
 *      whose text looks like a number ("12.10" -> "12.1", "8.0" -> "8",
 *      "1." -> "1"). Measured on the LAB corpus that changes the served text of
 *      45 of 400 sampled .docx files. It is reproduced here deliberately: the
 *      arm exists to measure what an upstream user actually receives, and the
 *      read plane is also the plane edit_document anchors against
 *      (documentOps.ts:1502-1504), so read and edit must not diverge.
 *
 *   3. upstreamNativeCitationReminder — `citationReminder`, verbatim from
 *      2266446b:backend/src/lib/chat/tools/documentOps.ts:33-47.
 */

import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { isSpreadsheetDocumentType } from "../documentTypes";

/* ==========================================================================
 * 1. Write plane — generateDocx (documentOps.ts:83-582)
 * ========================================================================== */

export type UpstreamNativeSection = {
  heading?: string;
  content?: string;
  level?: number;
  pageBreak?: boolean;
  table?: { headers: string[]; rows: string[][] };
};

export type UpstreamNativeDocxResult =
  | { buffer: Buffer; filename: string; error?: undefined }
  | { error: string; buffer?: undefined; filename?: undefined };

/**
 * Ported from 2266446b:backend/src/lib/chat/tools/documentOps.ts:83-504 plus
 * the filename rule at :506-511. Everything from the storage upload at :512
 * onward is replaced by returning the packed buffer.
 */
export async function renderUpstreamNativeDocx(
  title: string,
  sections: unknown[],
  options?: { landscape?: boolean },
): Promise<UpstreamNativeDocxResult> {
  try {
    const {
      Document,
      Paragraph,
      HeadingLevel,
      Packer,
      Table,
      TableRow,
      TableCell,
      WidthType,
      BorderStyle,
      TextRun,
      AlignmentType,
      LevelFormat,
      LevelSuffix,
      PageOrientation,
      PageBreak,
    } = await import("docx");

    const FONT = "Times New Roman";
    const SIZE = 22; // 11pt in half-points

    type DocChild = InstanceType<typeof Paragraph> | InstanceType<typeof Table>;
    const children: DocChild[] = [];
    children.push(
      new Paragraph({
        heading: HeadingLevel.TITLE,
        spacing: { after: 200 },
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({
            text: title.toUpperCase(),
            color: "000000",
            font: FONT,
            size: SIZE,
            bold: true,
          }),
        ],
      }),
    );

    const cellBorder = {
      top: { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
      bottom: { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
      left: { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
      right: { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
    };

    const headingLevels = [
      HeadingLevel.HEADING_1,
      HeadingLevel.HEADING_2,
      HeadingLevel.HEADING_3,
      HeadingLevel.HEADING_4,
    ];
    const LEGAL_NUMBERING_REF = "legal-clause-numbering";
    const legalNumbering = (level: number) => ({
      reference: LEGAL_NUMBERING_REF,
      level: Math.max(0, Math.min(level, 4)),
    });
    const legalNumberingLevels = [
      {
        level: 0,
        format: LevelFormat.DECIMAL,
        text: "%1.",
        alignment: AlignmentType.START,
        suffix: LevelSuffix.TAB,
        isLegalNumberingStyle: true,
        style: {
          paragraph: { indent: { left: 720, hanging: 720 } },
          run: {
            bold: true,
            color: "000000",
            font: FONT,
            size: SIZE,
          },
        },
      },
      {
        level: 1,
        format: LevelFormat.DECIMAL,
        text: "%1.%2",
        alignment: AlignmentType.START,
        suffix: LevelSuffix.TAB,
        isLegalNumberingStyle: true,
        style: {
          paragraph: { indent: { left: 720, hanging: 720 } },
          run: { color: "000000", font: FONT, size: SIZE },
        },
      },
      {
        level: 2,
        format: LevelFormat.LOWER_LETTER,
        text: "(%3)",
        alignment: AlignmentType.START,
        suffix: LevelSuffix.TAB,
        style: {
          paragraph: { indent: { left: 1440, hanging: 720 } },
          run: { color: "000000", font: FONT, size: SIZE },
        },
      },
      {
        level: 3,
        format: LevelFormat.LOWER_ROMAN,
        text: "(%4)",
        alignment: AlignmentType.START,
        suffix: LevelSuffix.TAB,
        style: {
          paragraph: { indent: { left: 1440, hanging: 720 } },
          run: { color: "000000", font: FONT, size: SIZE },
        },
      },
      {
        level: 4,
        format: LevelFormat.UPPER_LETTER,
        text: "(%5)",
        alignment: AlignmentType.START,
        suffix: LevelSuffix.TAB,
        style: {
          paragraph: { indent: { left: 2520, hanging: 720 } },
          run: { color: "000000", font: FONT, size: SIZE },
        },
      },
    ];
    const normalizeTable = (
      table: unknown,
    ): { headers: string[]; rows: string[][] } | null => {
      if (!table || typeof table !== "object") return null;
      const raw = table as { headers?: unknown; rows?: unknown };
      const headers = Array.isArray(raw.headers)
        ? raw.headers
            .map((header) => (typeof header === "string" ? header.trim() : ""))
            .filter(Boolean)
        : [];
      if (headers.length === 0) return null;

      const rawRows = Array.isArray(raw.rows) ? raw.rows : [];
      const rows = rawRows
        .filter((row): row is unknown[] => Array.isArray(row))
        .map((row) =>
          headers.map((_, i) => (typeof row[i] === "string" ? row[i] : "")),
        );

      return { headers, rows };
    };
    const stripManualNumbering = (
      value: string,
    ): { text: string; levelFromPrefix: number | null } => {
      const match = value.trim().match(/^(\d+(?:\.\d+)*)(?:[.)])?\s+(.+)$/);
      if (!match) return { text: value.trim(), levelFromPrefix: null };
      return {
        text: match[2].trim(),
        levelFromPrefix: match[1].split(".").length - 1,
      };
    };
    const parseManualListMarker = (
      value: string,
    ): { text: string; levelOffset: number | null } => {
      const trimmed = value.trim();
      const match = trimmed.match(/^(\(([a-z]+)\)|([a-z]+)[.)])\s+(.+)$/i);
      if (!match) return { text: trimmed, levelOffset: null };
      const marker = (match[2] ?? match[3] ?? "").toLowerCase();
      const isRoman =
        marker === "i" ||
        (marker.length > 1 &&
          /^(?:m{0,4}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3}))$/i.test(
            marker,
          ));
      return { text: match[4].trim(), levelOffset: isRoman ? 3 : 2 };
    };
    const normalizeHeadingText = (value: string) =>
      value
        .trim()
        .replace(/[^a-zA-Z0-9]+/g, " ")
        .trim()
        .toLowerCase();

    const isTitleLikeFirstHeading = (heading: string, sectionIndex: number) => {
      if (sectionIndex !== 0) return false;
      const normalized = normalizeHeadingText(heading);
      const titleNormalized = normalizeHeadingText(title);
      if (!normalized || !titleNormalized) return false;
      if (normalized === titleNormalized) return true;
      return (
        titleNormalized.includes(normalized) &&
        /\b(agreement|contract|deed|terms|policy|notice|nda|disclosure)\b/.test(
          normalized,
        )
      );
    };

    const isUnnumberedHeading = (heading: string, sectionIndex: number) => {
      const normalized = normalizeHeadingText(heading);
      if (!normalized) return true;
      if (normalized === "signatures" || normalized === "signature") {
        return true;
      }
      if (isTitleLikeFirstHeading(heading, sectionIndex)) {
        return true;
      }
      if (
        sectionIndex === 0 &&
        /^(agreement|contract|mutual non disclosure agreement|non disclosure agreement|employment agreement|service level agreement)$/.test(
          normalized,
        )
      ) {
        return true;
      }
      return false;
    };
    const isSignatureLine = (value: string) =>
      /^(?:by|name|title|date):\s*/i.test(value.trim());
    const looksLikeSignatureBlock = (value: string) => {
      const lines = value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.length === 0) return false;
      const signatureLineCount = lines.filter(isSignatureLine).length;
      return signatureLineCount >= 2;
    };
    let currentClauseLevel: number | null = null;

    for (const [sectionIndex, section] of (
      sections as UpstreamNativeSection[]
    ).entries()) {
      if (section.pageBreak) {
        children.push(new Paragraph({ children: [new PageBreak()] }));
      }
      if (section.heading) {
        const stripped = stripManualNumbering(section.heading);
        const isUnnumbered = isUnnumberedHeading(stripped.text, sectionIndex);
        const skipHeading = isTitleLikeFirstHeading(
          stripped.text,
          sectionIndex,
        );
        const idx = Math.min(
          stripped.levelFromPrefix ?? (section.level ?? 1) - 1,
          3,
        );
        currentClauseLevel = isUnnumbered || skipHeading ? null : idx;
        const headingText =
          idx === 0 && !isUnnumbered
            ? stripped.text.toUpperCase()
            : stripped.text;
        if (!skipHeading) {
          children.push(
            new Paragraph({
              heading: headingLevels[idx],
              numbering: isUnnumbered ? undefined : legalNumbering(idx),
              spacing: { after: 160 },
              children: [
                new TextRun({
                  text: headingText,
                  color: "000000",
                  font: FONT,
                  size: SIZE,
                  bold: true,
                }),
              ],
            }),
          );
        }
      }
      const normalizedTable = normalizeTable(section.table);
      if (normalizedTable) {
        const { headers, rows } = normalizedTable;
        const tableRows: InstanceType<typeof TableRow>[] = [];
        // Header row
        tableRows.push(
          new TableRow({
            tableHeader: true,
            children: headers.map(
              (h) =>
                new TableCell({
                  borders: cellBorder,
                  shading: { fill: "F2F2F2" },
                  children: [
                    new Paragraph({
                      children: [
                        new TextRun({
                          text: h,
                          bold: true,
                          font: FONT,
                          size: SIZE,
                        }),
                      ],
                      alignment: AlignmentType.LEFT,
                    }),
                  ],
                }),
            ),
          }),
        );
        // Data rows — normalize each row to exactly colCount cells.
        // LLMs occasionally emit malformed rows (extra fragments from
        // stray delimiters, or short rows); padding/truncating here
        // keeps the rendered table aligned to the headers.
        for (const normalized of rows) {
          tableRows.push(
            new TableRow({
              children: normalized.map(
                (cell) =>
                  new TableCell({
                    borders: cellBorder,
                    children: [
                      new Paragraph({
                        children: [
                          new TextRun({
                            text: cell,
                            font: FONT,
                            size: SIZE,
                          }),
                        ],
                      }),
                    ],
                  }),
              ),
            }),
          );
        }
        children.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: tableRows,
          }),
        );
        children.push(new Paragraph({ text: "" }));
      }
      if (section.content) {
        let numberedBodyParagraphs = 0;
        const contentIsSignatureBlock =
          section.heading &&
          normalizeHeadingText(section.heading).includes("signature")
            ? true
            : looksLikeSignatureBlock(section.content);
        for (const line of section.content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const bulletMatch = trimmed.match(/^[-•*]\s+(.+)/);
          const rawText = bulletMatch ? bulletMatch[1].trim() : trimmed;
          const manualList = parseManualListMarker(rawText);
          const numeric = stripManualNumbering(rawText);
          const text = bulletMatch
            ? rawText
            : manualList.levelOffset !== null
              ? manualList.text
              : numeric.text;
          const inferredLevel =
            currentClauseLevel === null || contentIsSignatureBlock
              ? undefined
              : bulletMatch
                ? currentClauseLevel + 2
                : manualList.levelOffset !== null
                  ? currentClauseLevel + manualList.levelOffset
                  : numeric.levelFromPrefix !== null
                    ? numeric.levelFromPrefix
                    : numberedBodyParagraphs === 0
                      ? currentClauseLevel + 1
                      : currentClauseLevel + 2;
          if (currentClauseLevel !== null) numberedBodyParagraphs++;
          children.push(
            new Paragraph({
              numbering:
                inferredLevel === undefined
                  ? undefined
                  : legalNumbering(inferredLevel),
              spacing: { after: 120 },
              children: [
                new TextRun({
                  text,
                  font: FONT,
                  size: SIZE,
                }),
              ],
            }),
          );
        }
      }
    }

    const pageSetup = options?.landscape
      ? { page: { size: { orientation: PageOrientation.LANDSCAPE } } }
      : {};

    const doc = new Document({
      numbering: {
        config: [
          {
            reference: LEGAL_NUMBERING_REF,
            levels: legalNumberingLevels,
          },
        ],
      },
      sections: [{ properties: pageSetup, children }],
    });
    const buf = await Packer.toBuffer(doc);
    const zip = await import("jszip");
    const packageZip = await zip.default.loadAsync(buf);
    for (const requiredPath of [
      "[Content_Types].xml",
      "word/document.xml",
      "word/_rels/document.xml.rels",
    ]) {
      if (!packageZip.file(requiredPath)) {
        return {
          error: `Generated DOCX is missing required package part: ${requiredPath}`,
        };
      }
    }
    const safeTitle =
      title
        .replace(/[^a-zA-Z0-9 -]/g, "")
        .trim()
        .slice(0, 64) || "document";
    return { buffer: Buffer.from(buf), filename: `${safeTitle}.docx` };
  } catch (e) {
    return { error: String(e) };
  }
}

/* ==========================================================================
 * 2. Read plane — extractDocxBodyText (docxTrackedChanges.ts:719-750)
 * ========================================================================== */

type XNode = Record<string, unknown>;
const ATTR_KEY = ":@";
const TEXT_KEY = "#text";

function elName(n: unknown): string | null {
  if (!n || typeof n !== "object") return null;
  for (const k of Object.keys(n as XNode)) {
    if (k === ATTR_KEY || k === TEXT_KEY) continue;
    return k;
  }
  return null;
}

function isTextNode(n: unknown): n is { [TEXT_KEY]: string } {
  if (!n || typeof n !== "object") return false;
  const obj = n as XNode;
  return TEXT_KEY in obj && elName(n) === null;
}

function elChildren(n: unknown): XNode[] {
  const name = elName(n);
  if (!name) return [];
  const v = (n as XNode)[name];
  return Array.isArray(v) ? (v as XNode[]) : [];
}

function getZipEntry(zip: JSZip, pathSlash: string) {
  const direct = zip.file(pathSlash);
  if (direct) return direct;
  return zip.file(pathSlash.replace(/\//g, "\\"));
}

/**
 * Pinned parser options, 2266446b:backend/src/lib/docxTrackedChanges.ts:647-656.
 * NOTE the absence of `parseTagValue: false` — this is the upstream defect
 * described in the module header, and it is reproduced on purpose.
 */
function createPinnedParser() {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    preserveOrder: true,
    trimValues: false,
    parseAttributeValue: false,
    processEntities: true,
  });
}

function getTextContent(wtEl: XNode): string {
  const kids = elChildren(wtEl);
  let out = "";
  for (const k of kids) {
    if (isTextNode(k)) out += String(k[TEXT_KEY] ?? "");
  }
  return out;
}

/** Accepted view: w:ins runs count as normal text, w:del is invisible.
 * Ported from the paraText half of flattenParagraph (:208-278). */
function flattenParagraphText(paraChildren: XNode[]): string {
  let paraText = "";
  const processRun = (rEl: XNode) => {
    for (const rk of elChildren(rEl)) {
      if (elName(rk) === "w:t") paraText += getTextContent(rk);
    }
  };
  for (const child of paraChildren) {
    const name = elName(child);
    if (name === "w:r") {
      processRun(child);
    } else if (name === "w:ins") {
      for (const inner of elChildren(child)) {
        if (elName(inner) === "w:r") processRun(inner);
      }
    }
    // w:del: skipped entirely — accepted view excludes deleted text.
  }
  return paraText;
}

function findBody(doc: XNode[]): XNode[] | null {
  for (const top of doc) {
    if (elName(top) === "w:document") {
      for (const c of elChildren(top)) {
        if (elName(c) === "w:body") return elChildren(c);
      }
    }
  }
  return null;
}

/** Verbatim port of 2266446b:backend/src/lib/docxTrackedChanges.ts:719-750. */
export async function extractUpstreamNativeDocxBodyText(
  bytes: Buffer,
): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const docXmlFile = getZipEntry(zip, "word/document.xml");
  if (!docXmlFile) return "";
  const docXmlRaw = await docXmlFile.async("string");
  const parser = createPinnedParser();
  const tree = parser.parse(docXmlRaw) as XNode[];
  const bodyChildren = findBody(tree);
  if (!bodyChildren) return "";

  const lines: string[] = [];
  const collect = (nodes: XNode[]) => {
    for (const n of nodes) {
      const name = elName(n);
      if (!name) continue;
      if (name === "w:p") {
        lines.push(flattenParagraphText(elChildren(n)));
      } else if (
        name === "w:tbl" ||
        name === "w:tr" ||
        name === "w:tc" ||
        name === "w:sdt" ||
        name === "w:sdtContent"
      ) {
        collect(elChildren(n));
      }
    }
  };
  collect(bodyChildren);
  return lines.join("\n");
}

/* ==========================================================================
 * 3. citationReminder (documentOps.ts:33-47)
 * ========================================================================== */

/** Verbatim port of 2266446b:backend/src/lib/chat/tools/documentOps.ts:33-47. */
export function upstreamNativeCitationReminder(
  docLabel: string,
  filename: string,
): string {
  const isSpreadsheet = isSpreadsheetDocumentType(
    filename.split(".").pop() ?? "",
  );
  const shapeLine = isSpreadsheet
    ? `Use this citation object shape for this spreadsheet: {"ref": 1, "doc_id": "${docLabel}", "quotes": [{"sheet": "Sheet name", "cell": "B7", "quote": "plain cell value"}]}. Cite by "sheet" + "cell" (A1 address or range), not by page.`
    : `Use this citation object shape: {"ref": 1, "doc_id": "${docLabel}", "quotes": [{"page": 1, "quote": "exact verbatim text from the document"}]}. Include top-level "page" and "quote" too only if they match the first quote.`;
  return [
    `[Citation requirement for ${docLabel} ("${filename}")]:`,
    `If your final answer makes any factual claim from this document, include inline [N] markers and append a final <CITATIONS> JSON block.`,
    `Every citation entry for this document MUST use "doc_id": "${docLabel}".`,
    shapeLine,
    `Do not use "marker" or "text" keys in the citation block; use "ref" and "quotes".`,
  ].join("\n");
}

/**
 * The four sentences of `next_required_action` for a generated document,
 * verbatim from 2266446b:backend/src/lib/chat/tools/toolDispatcher.ts:565-570,
 * joined by " " exactly as upstream joins them.
 */
export function upstreamNativeGeneratedNextAction(docLabel: string): string {
  return [
    `Before writing your final response, call read_document with doc_id "${docLabel}".`,
    `Base your description on the generated document's actual returned text, not on memory of what you intended to generate.`,
    `Do not include download links, URLs, or markdown links to the document in your prose response; the document card is shown automatically by the UI.`,
    `Give a concise description of the generated document and, if you make factual claims about its contents, cite it with [N] markers and a final <CITATIONS> block using doc_id "${docLabel}", not any source/template document.`,
  ].join(" ");
}

/**
 * `next_required_action` for edit_document, verbatim from
 * 2266446b:backend/src/lib/chat/tools/toolDispatcher.ts:1509-1515.
 */
export function upstreamNativeEditedNextAction(docLabel: string): string {
  return [
    `The edited document remains available as doc_id "${docLabel}".`,
    `Before making factual claims about the edited document's final contents, call read_document with doc_id "${docLabel}" and base the response on that returned text.`,
    `Do not include download links or URLs in your prose response; the edited document card is shown automatically by the UI.`,
    `If you describe specific content from the edited document, cite it with [N] markers and a final <CITATIONS> block using doc_id "${docLabel}".`,
  ].join(" ");
}

/** The duplicate-read suppression payload, verbatim from
 * 2266446b:backend/src/lib/chat/tools/documentOps.ts:1374-1392. */
export const UPSTREAM_NATIVE_ALREADY_READ_CONTENT =
  "This document/version was already read earlier in this response. The full text is not repeated to avoid unnecessary token use.";
export const UPSTREAM_NATIVE_ALREADY_READ_NEXT_ACTION =
  "Use the prior read_document/fetch_documents result, call find_in_document for targeted checks, or proceed to edit_document.";
