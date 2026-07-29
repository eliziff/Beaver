import type JSZip from "jszip";

import {
  MAX_DRAFTING_DOCX_BYTES,
  MAX_DRAFTING_XML_ENTRY_BYTES,
} from "../docxDraftingSource";
import { loadZip } from "../zip";

// Same package bounds the drafting reader enforces; a sniffer that runs
// before extraction must not be a cheaper way to blow the same limits.
const MAX_ZIP_ENTRIES = 2_048;
const MAX_EXPANDED_BYTES = 96 * 1024 * 1024;
const MAX_XML_BYTES = 32 * 1024 * 1024;
const MAX_FIELD_SAMPLES = 5;
const MAX_SAMPLE_CHARS = 120;

/**
 * What a DOCX contains, read from raw OOXML before any extraction path
 * runs. Counts are of markup actually present; nothing here is inferred
 * from rendered text.
 */
export interface DocxPathologyReport {
  auto_numbering: {
    referenced_paragraphs: number;
    has_numbering_part: boolean;
  };
  tracked_changes: { insertions: number; deletions: number };
  comments: { count: number };
  content_controls: { count: number };
  hyperlinks: { count: number; with_text: number };
  /** w:txbxContent — invisible to every current extractor. */
  text_boxes: { count: number; characters: number };
  /** Strike/red formatting standing in for tracked-change markup. */
  manual_redline: {
    colored_runs: number;
    struck_runs: number;
    colored_and_struck: number;
    likely: boolean;
  };
  tables: { count: number; merged_cells: number; nested: boolean };
  fields: { count: number; instr_samples: string[] };
  embeddings: { count: number };
  header_footer_literal_text: boolean;
  footnotes: { count: number };
  endnotes: { count: number };
  /** Routing warnings derived from the counters above. */
  notes_of_caution: string[];
}

function emptyReport(): DocxPathologyReport {
  return {
    auto_numbering: { referenced_paragraphs: 0, has_numbering_part: false },
    tracked_changes: { insertions: 0, deletions: 0 },
    comments: { count: 0 },
    content_controls: { count: 0 },
    hyperlinks: { count: 0, with_text: 0 },
    text_boxes: { count: 0, characters: 0 },
    manual_redline: {
      colored_runs: 0,
      struck_runs: 0,
      colored_and_struck: 0,
      likely: false,
    },
    tables: { count: 0, merged_cells: 0, nested: false },
    fields: { count: 0, instr_samples: [] },
    embeddings: { count: 0 },
    header_footer_literal_text: false,
    footnotes: { count: 0 },
    endnotes: { count: 0 },
    notes_of_caution: [],
  };
}

/** `<w:tbl` must not match `<w:tblPr`; every element probe uses this guard. */
function countElements(xml: string, name: string) {
  return (xml.match(new RegExp(`<${name}(?=[\\s/>])`, "gu")) ?? []).length;
}

/** Matches an open tag only — never a self-closing one, never a longer name. */
function elementBlocks(xml: string, name: string) {
  return xml.matchAll(
    new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "gu"),
  );
}

function decodeXmlText(value: string) {
  return value
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&#(\d+);/gu, (_match, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&amp;/gu, "&");
}

function literalText(xml: string) {
  let out = "";
  for (const match of elementBlocks(xml, "w:t")) out += decodeXmlText(match[1]);
  return out;
}

function sample(value: string) {
  return value.replace(/\s+/gu, " ").trim().slice(0, MAX_SAMPLE_CHARS);
}

/**
 * Red family: the red channel dominates and neither other channel is
 * near it. Excludes `auto`, theme colors, and every non-hex value.
 */
function isRedFamily(value: string) {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(
    value.trim(),
  );
  if (!match) return false;
  const [red, green, blue] = match.slice(1, 4).map((c) => parseInt(c, 16));
  return red >= 0xb0 && green <= 0x60 && blue <= 0x60;
}

function expandedSize(entry: unknown) {
  const size = (entry as { _data?: { uncompressedSize?: unknown } })?._data
    ?.uncompressedSize;
  if (!Number.isSafeInteger(size) || Number(size) < 0) {
    throw new Error("DOCX has invalid ZIP size metadata");
  }
  return Number(size);
}

function assertBoundedPackage(zip: JSZip) {
  const files = Object.values(zip.files).filter((entry) => !entry.dir);
  if (files.length > MAX_ZIP_ENTRIES) {
    throw new Error("DOCX contains too many package entries");
  }
  let expandedBytes = 0;
  let xmlBytes = 0;
  for (const entry of files) {
    const size = expandedSize(entry);
    expandedBytes += size;
    if (/\.xml(?:\.rels)?$/iu.test(entry.name)) {
      if (size > MAX_DRAFTING_XML_ENTRY_BYTES) {
        throw new Error("DOCX contains an oversized XML part");
      }
      xmlBytes += size;
    }
  }
  if (expandedBytes > MAX_EXPANDED_BYTES || xmlBytes > MAX_XML_BYTES) {
    throw new Error("DOCX expands beyond the read limit");
  }
}

function containsNestedTable(xml: string) {
  let depth = 0;
  for (const match of xml.matchAll(/<(\/?)w:tbl(?=[\s/>])([^>]*)>/gu)) {
    if (match[1]) depth -= 1;
    else if (!match[2].endsWith("/")) {
      depth += 1;
      if (depth > 1) return true;
    }
  }
  return false;
}

/** Counts markup that carries content; comments and numbering are separate parts. */
function scanStoryPart(xml: string, report: DocxPathologyReport) {
  report.auto_numbering.referenced_paragraphs += countElements(xml, "w:numPr");
  report.tracked_changes.insertions += countElements(xml, "w:ins");
  report.tracked_changes.deletions += countElements(xml, "w:del");
  report.content_controls.count += countElements(xml, "w:sdt");
  report.hyperlinks.count += countElements(xml, "w:hyperlink");
  for (const match of elementBlocks(xml, "w:hyperlink")) {
    if (literalText(match[1]).trim()) report.hyperlinks.with_text += 1;
  }

  // A Word drawing text box is written twice — an mc:Choice and an
  // identical mc:Fallback. Count the choice only.
  const chosen = xml.replace(
    /<mc:Fallback(?:\s[^>]*)?>[\s\S]*?<\/mc:Fallback>/gu,
    "",
  );
  for (const match of elementBlocks(chosen, "w:txbxContent")) {
    report.text_boxes.count += 1;
    report.text_boxes.characters += literalText(match[1]).length;
  }

  report.tables.count += countElements(xml, "w:tbl");
  for (const match of elementBlocks(xml, "w:tcPr")) {
    if (/<w:(?:gridSpan|vMerge)(?=[\s/>])/u.test(match[1])) {
      report.tables.merged_cells += 1;
    }
  }
  if (containsNestedTable(xml)) report.tables.nested = true;

  report.fields.count +=
    (xml.match(/<w:fldChar(?=[\s/>])[^>]*w:fldCharType="begin"/gu) ?? [])
      .length + countElements(xml, "w:fldSimple");
  const instructions: string[] = [];
  for (const match of elementBlocks(xml, "w:instrText")) {
    instructions.push(decodeXmlText(match[1]));
  }
  for (const match of xml.matchAll(
    /<w:fldSimple(?=[\s/>])[^>]*\sw:instr="([^"]*)"/gu,
  )) {
    instructions.push(decodeXmlText(match[1]));
  }
  for (const instruction of instructions) {
    const text = sample(instruction);
    if (!text || report.fields.instr_samples.includes(text)) continue;
    if (report.fields.instr_samples.length < MAX_FIELD_SAMPLES) {
      report.fields.instr_samples.push(text);
    }
  }

  // Tracked deletions are struck when rendered but carry no w:strike, so
  // strip them before the manual-redline pass rather than count them twice.
  const untracked = xml.replace(
    /<w:del(?:\s[^>]*)?>[\s\S]*?<\/w:del>/gu,
    "",
  );
  for (const run of elementBlocks(untracked, "w:r")) {
    const properties = /<w:rPr(?:\s[^>]*)?>([\s\S]*?)<\/w:rPr>/u.exec(run[1]);
    if (!properties) continue;
    const strike = /<w:strike(?=[\s/>])([^>]*)>/u.exec(properties[1]);
    const struck = strike ? !/w:val="(?:false|0)"/u.test(strike[1]) : false;
    const color = /<w:color(?=[\s/>])[^>]*\sw:val="([^"]*)"/u.exec(
      properties[1],
    );
    const colored = color ? isRedFamily(color[1]) : false;
    if (struck) report.manual_redline.struck_runs += 1;
    if (colored) report.manual_redline.colored_runs += 1;
    if (struck && colored) report.manual_redline.colored_and_struck += 1;
  }
}

function countNotes(xml: string, tag: "footnote" | "endnote") {
  // Every package ships separator and continuation notes; they are not content.
  const pattern = new RegExp(
    `<w:${tag}\\b(?![^>]*\\bw:type="(?:separator|continuationSeparator|continuationNotice)")`,
    "giu",
  );
  return (xml.match(pattern) ?? []).length;
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

function deriveNotes(
  report: DocxPathologyReport,
  recordingChanges: boolean,
): string[] {
  const notes: string[] = [];
  const { referenced_paragraphs, has_numbering_part } = report.auto_numbering;
  if (referenced_paragraphs > 0) {
    notes.push(
      has_numbering_part
        ? `${plural(referenced_paragraphs, "paragraph takes", "paragraphs take")} the visible number from the numbering part; extracted text carries no such number.`
        : `${plural(referenced_paragraphs, "paragraph references", "paragraphs reference")} numbering that this package does not define; the visible numbers cannot be reconstructed.`,
    );
  }
  const { insertions, deletions } = report.tracked_changes;
  if (insertions || deletions) {
    notes.push(
      `${plural(insertions, "insertion", "insertions")} and ${plural(deletions, "deletion", "deletions")} are unresolved; the text differs depending on whether they are accepted or rejected.`,
    );
  }
  if (recordingChanges) {
    notes.push("Change recording is on; further edits will be tracked.");
  }
  if (report.manual_redline.likely) {
    notes.push(
      `${plural(report.manual_redline.struck_runs, "run is", "runs are")} struck and ${plural(report.manual_redline.colored_runs, "run carries", "runs carry")} a red colour without tracked-change markup; the edit intent is formatting only.`,
    );
  }
  if (report.text_boxes.count > 0) {
    notes.push(
      `${plural(report.text_boxes.count, "text box holds", "text boxes hold")} ${plural(report.text_boxes.characters, "character", "characters")} that body-text extraction does not reach.`,
    );
  }
  if (report.content_controls.count > 0) {
    notes.push(
      `${plural(report.content_controls.count, "content control wraps", "content controls wrap")} body text; edits addressed to the plain text may land outside the control.`,
    );
  }
  if (report.comments.count > 0) {
    notes.push(
      `${plural(report.comments.count, "comment sits", "comments sit")} outside the body text.`,
    );
  }
  if (report.tables.count > 0 && (report.tables.merged_cells || report.tables.nested)) {
    notes.push(
      `${plural(report.tables.count, "table", "tables")} with ${plural(report.tables.merged_cells, "merged cell", "merged cells")}${report.tables.nested ? " and nesting" : ""}; linear text loses the cell layout.`,
    );
  }
  const untitled = report.hyperlinks.count - report.hyperlinks.with_text;
  if (untitled > 0) {
    notes.push(
      `${plural(untitled, "hyperlink carries", "hyperlinks carry")} no visible text.`,
    );
  }
  if (report.fields.count > 0) {
    notes.push(
      `${plural(report.fields.count, "field renders", "fields render")} a value that is not in the stored text${report.fields.instr_samples.length ? ` (${report.fields.instr_samples.join("; ")})` : ""}.`,
    );
  }
  if (report.embeddings.count > 0) {
    notes.push(
      `${plural(report.embeddings.count, "embedded object is", "embedded objects are")} not readable as text.`,
    );
  }
  if (report.header_footer_literal_text) {
    notes.push(
      "Headers or footers carry literal text that body extraction drops.",
    );
  }
  if (report.footnotes.count || report.endnotes.count) {
    notes.push(
      `${plural(report.footnotes.count, "footnote", "footnotes")} and ${plural(report.endnotes.count, "endnote", "endnotes")} sit outside the body flow.`,
    );
  }
  return notes;
}

/**
 * Reports what a DOCX contains before any extraction path runs. Never
 * throws: an unreadable package degrades to zeros plus a note.
 */
export async function scanDocxPathology(
  bytes: Buffer,
): Promise<DocxPathologyReport> {
  const report = emptyReport();
  const failures: string[] = [];
  try {
    if (!bytes.length || bytes.length > MAX_DRAFTING_DOCX_BYTES) {
      throw new Error("DOCX is empty or exceeds the read limit");
    }
    const zip = await loadZip(bytes);
    assertBoundedPackage(zip);
    if (!zip.file("word/document.xml")) {
      throw new Error("Package has no word/document.xml");
    }

    const paths = Object.keys(zip.files);
    report.auto_numbering.has_numbering_part = paths.some((path) =>
      /^word\/numbering\.xml$/iu.test(path),
    );
    report.embeddings.count = Object.values(zip.files).filter(
      (entry) => !entry.dir && /^word\/embeddings\//iu.test(entry.name),
    ).length;

    const read = async (path: string) => {
      try {
        return (await zip.file(path)?.async("text")) ?? "";
      } catch (error) {
        failures.push(`${path} could not be read (${message(error)}).`);
        return "";
      }
    };

    const headerFooterPaths = paths.filter((path) =>
      /^word\/(?:header|footer)\d*\.xml$/iu.test(path),
    );
    scanStoryPart(await read("word/document.xml"), report);
    for (const path of headerFooterPaths) {
      const xml = await read(path);
      scanStoryPart(xml, report);
      // A page-number-only footer is field codes, not dropped text.
      if (literalText(xml).trim()) report.header_footer_literal_text = true;
    }

    for (const [path, tag] of [
      ["word/footnotes.xml", "footnote"],
      ["word/endnotes.xml", "endnote"],
    ] as const) {
      if (!zip.file(path)) continue;
      const xml = await read(path);
      report[`${tag}s`].count = countNotes(xml, tag);
      scanStoryPart(xml, report);
    }

    if (zip.file("word/comments.xml")) {
      report.comments.count = countElements(
        await read("word/comments.xml"),
        "w:comment",
      );
    }

    // w:trackChanges is the schema element; w:trackRevisions is what some
    // writers emit for the same switch.
    const recordingChanges = zip.file("word/settings.xml")
      ? /<w:track(?:Changes|Revisions)(?=[\s/>])(?![^>]*w:val="(?:false|0)")/u.test(
          await read("word/settings.xml"),
        )
      : false;

    const { colored_runs, struck_runs, colored_and_struck } =
      report.manual_redline;
    report.manual_redline.likely =
      struck_runs >= 2 || colored_and_struck >= 1 || colored_runs >= 3;

    report.notes_of_caution = [
      ...deriveNotes(report, recordingChanges),
      ...failures,
    ];
    return report;
  } catch (error) {
    const degraded = emptyReport();
    degraded.notes_of_caution = [
      `Package could not be inspected: ${message(error)}.`,
      ...failures,
    ];
    return degraded;
  }
}

function message(error: unknown) {
  return String((error as { message?: unknown })?.message ?? error)
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 200);
}
