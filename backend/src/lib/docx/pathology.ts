import { isRedFamily } from "./core";
import { openDocxSession, type DocxSession } from "./session";
import { boundedErrorText as message, countLabel as plural } from "../text";

const MAX_FIELD_SAMPLES = 5;
const MAX_SAMPLE_CHARS = 120;
const MAX_TRAP_SAMPLES = 5;
const TRAP_CONTEXT_CHARS = 36;

/**
 * Characters in the text plane that do not read as they render: they are
 * invisible, they reorder what follows, or they wear another script's
 * shape. Counted per character, except confusables, counted per word.
 */
export interface UnicodeTraps {
  /** U+202A-202E, U+2066-2069 — reorder the rendered line. */
  bidi_controls: number;
  /** U+200B-200D, U+FEFF, U+2060 — split a word with no visible break. */
  zero_width: number;
  /** Latin words carrying a Cyrillic or Greek look-alike. */
  homoglyph_suspects: number;
  /** U+E000-F8FF — renders as whatever the reader's font decides. */
  private_use: number;
  /** C0 other than tab, newline and carriage return. */
  control_chars: number;
  /** U+2061-2064 — invisible operators. */
  invisible_math: number;
}
type TrapClass = keyof UnicodeTraps;

export interface UnicodeTrapFindings extends UnicodeTraps {
  /** One excerpt per class, the trap character named in place. */
  samples: string[];
}
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
  /** Text-plane traps in the same story parts. */
  unicode_traps: UnicodeTrapFindings;
  /** Routing warnings derived from the counters above. */
  notes_of_caution: string[];
}

function emptyTraps(): UnicodeTraps {
  return {
    bidi_controls: 0,
    zero_width: 0,
    homoglyph_suspects: 0,
    private_use: 0,
    control_chars: 0,
    invisible_math: 0,
  };
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
    unicode_traps: { ...emptyTraps(), samples: [] },
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
 * Text as the reader meets it: runs join, paragraphs break. Without the
 * break the last word of one paragraph would fuse with the first of the
 * next, and a Latin paragraph above a Cyrillic one would read as mixed.
 */
function storyText(xml: string) {
  let out = "";
  for (const match of xml.matchAll(
    /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<\/w:p>/gu,
  )) {
    out += match[1] === undefined ? "\n" : decodeXmlText(match[1]);
  }
  return out;
}

/**
 * Cyrillic and Greek letters that wear a Latin shape, by code point: a
 * table of look-alikes cannot be reviewed as literals. Only the
 * look-alikes are listed — a mixed word using a letter that reads as
 * itself is visible to the reader, and Greek read as a symbol (mu, beta,
 * lambda, sigma, pi) is not taken for Latin at all.
 */
const CONFUSABLES = new Set<number>([
  // Cyrillic a ve ie ka em en o er es te u ha, lower then upper.
  0x0430, 0x0432, 0x0435, 0x043a, 0x043c, 0x043d, 0x043e, 0x0440, 0x0441,
  0x0442, 0x0443, 0x0445, 0x0410, 0x0412, 0x0415, 0x041a, 0x041c, 0x041d,
  0x041e, 0x0420, 0x0421, 0x0422, 0x0423, 0x0425,
  // Cyrillic dze i je komi-de qa we, lower then upper.
  0x0455, 0x0456, 0x0458, 0x0501, 0x051b, 0x051d, 0x0405, 0x0406, 0x0408,
  0x051a, 0x051c,
  // Greek alpha epsilon iota kappa nu omicron rho tau upsilon gamma.
  0x03b1, 0x03b5, 0x03b9, 0x03ba, 0x03bd, 0x03bf, 0x03c1, 0x03c4, 0x03c5,
  0x03b3,
  // Greek capitals sharing a Latin capital shape: alpha beta epsilon zeta
  // eta iota kappa mu nu omicron rho tau upsilon chi.
  0x0391, 0x0392, 0x0395, 0x0396, 0x0397, 0x0399, 0x039a, 0x039c, 0x039d,
  0x039f, 0x03a1, 0x03a4, 0x03a5, 0x03a7,
]);

/** Letters and marks only, so a hyphen cannot fuse two single-script words. */
const WORD = /[\p{L}\p{M}]+/gu;
const HAS_LATIN = /\p{Script=Latin}/u;

/** Every trap class is BMP, so one UTF-16 unit is one candidate. */
function classify(code: number): TrapClass | null {
  if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) {
    return "bidi_controls";
  }
  if (
    code === 0x200b ||
    code === 0x200c ||
    code === 0x200d ||
    code === 0x2060 ||
    code === 0xfeff
  ) {
    return "zero_width";
  }
  if (code >= 0x2061 && code <= 0x2064) return "invisible_math";
  if (code >= 0xe000 && code <= 0xf8ff) return "private_use";
  if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
    return "control_chars";
  }
  return null;
}

/**
 * Characters first, then words: a Latin word holding one look-alike is
 * one suspect however many look-alikes it holds.
 */
function scanTraps(
  text: string,
  traps: UnicodeTraps,
  onTrap?: (trap: TrapClass, at: number) => void,
) {
  for (let index = 0; index < text.length; index += 1) {
    const trap = classify(text.charCodeAt(index));
    if (!trap) continue;
    traps[trap] += 1;
    onTrap?.(trap, index);
  }
  for (const match of text.matchAll(WORD)) {
    const word = match[0];
    if (!HAS_LATIN.test(word)) continue;
    let offset = -1;
    for (let index = 0; index < word.length; index += 1) {
      if (CONFUSABLES.has(word.charCodeAt(index))) {
        offset = index;
        break;
      }
    }
    if (offset < 0) continue;
    traps.homoglyph_suspects += 1;
    onTrap?.("homoglyph_suspects", (match.index ?? 0) + offset);
  }
}

function codePointName(code: number) {
  return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * One excerpt per class, naming every trap character in the window — an
 * excerpt that still carried an override would reorder wherever it is
 * printed.
 */
function addTrapSample(
  findings: UnicodeTrapFindings,
  trap: TrapClass,
  text: string,
  at: number,
  path: string,
) {
  const { samples } = findings;
  if (samples.length >= MAX_TRAP_SAMPLES) return;
  if (samples.some((entry) => entry.startsWith(`${trap} `))) return;
  const start = Math.max(0, at - TRAP_CONTEXT_CHARS);
  const end = Math.min(text.length, at + 1 + TRAP_CONTEXT_CHARS);
  let excerpt = start > 0 ? "..." : "";
  for (let index = start; index < end; index += 1) {
    const code = text.charCodeAt(index);
    excerpt +=
      index === at || classify(code) ? `<${codePointName(code)}>` : text[index];
  }
  if (end < text.length) excerpt += "...";
  samples.push(
    `${trap} ${codePointName(text.charCodeAt(at))} in ${path}: "${sample(excerpt)}"`,
  );
}

/**
 * The same text-plane scan without a package around it, for callers that
 * hold extracted text. Never throws; a non-string reads as no traps.
 */
export function scanTextTraps(text: string): UnicodeTraps {
  const traps = emptyTraps();
  if (typeof text !== "string" || !text) return traps;
  scanTraps(text, traps);
  return traps;
}

/**
 * Red family: the red channel dominates and neither other channel is
 * near it. Excludes `auto`, theme colors, and every non-hex value.
 */
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
function scanStoryPart(
  xml: string,
  path: string,
  report: DocxPathologyReport,
) {
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

  // Text plane, over the same fallback-free markup so a text box does not
  // count its characters twice. Field codes and deleted runs are not w:t.
  const text = storyText(chosen);
  scanTraps(text, report.unicode_traps, (trap, at) => {
    addTrapSample(report.unicode_traps, trap, text, at, path);
  });

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
  const traps = report.unicode_traps;
  const carried: string[] = [];
  if (traps.bidi_controls) {
    carried.push(plural(traps.bidi_controls, "bidi control", "bidi controls"));
  }
  if (traps.zero_width) {
    carried.push(
      plural(traps.zero_width, "zero-width character", "zero-width characters"),
    );
  }
  if (traps.homoglyph_suspects) {
    carried.push(
      plural(traps.homoglyph_suspects, "confusable word", "confusable words"),
    );
  }
  if (traps.private_use) {
    carried.push(
      plural(traps.private_use, "private-use character", "private-use characters"),
    );
  }
  if (traps.control_chars) {
    carried.push(
      plural(traps.control_chars, "control character", "control characters"),
    );
  }
  if (traps.invisible_math) {
    carried.push(
      plural(traps.invisible_math, "invisible operator", "invisible operators"),
    );
  }
  if (carried.length) {
    // Routing, not accusation: the text may not read as it renders.
    notes.push(
      `Document text carries invisible or confusable Unicode (${carried.join(", ")}); treat quoted matches cautiously and prefer verbatim offsets.`,
    );
  }
  return notes;
}

/**
 * Reports what a DOCX contains before any extraction path runs. Never
 * throws: an unreadable package degrades to zeros plus a note.
 */
export async function scanDocxPathology(
  source: Buffer | DocxSession,
): Promise<DocxPathologyReport> {
  const report = emptyReport();
  const failures: string[] = [];
  try {
    const session = Buffer.isBuffer(source)
      ? await openDocxSession(source)
      : source;
    if (!session.has("word/document.xml")) {
      throw new Error("Package has no word/document.xml");
    }

    const paths = session.paths;
    report.auto_numbering.has_numbering_part = paths.some((path) =>
      /^word\/numbering\.xml$/iu.test(path),
    );
    report.embeddings.count = paths.filter((path) =>
      /^word\/embeddings\//iu.test(path)
    ).length;

    const read = async (path: string) => {
      try {
        return (await session.readText(path)) ?? "";
      } catch (error) {
        failures.push(`${path} could not be read (${message(error)}).`);
        return "";
      }
    };

    const headerFooterPaths = paths.filter((path) =>
      /^word\/(?:header|footer)\d*\.xml$/iu.test(path),
    );
    scanStoryPart(await read("word/document.xml"), "word/document.xml", report);
    for (const path of headerFooterPaths) {
      const xml = await read(path);
      scanStoryPart(xml, path, report);
      // A page-number-only footer is field codes, not dropped text.
      if (literalText(xml).trim()) report.header_footer_literal_text = true;
    }

    for (const [path, tag] of [
      ["word/footnotes.xml", "footnote"],
      ["word/endnotes.xml", "endnote"],
    ] as const) {
      if (!session.has(path)) continue;
      const xml = await read(path);
      report[`${tag}s`].count = countNotes(xml, tag);
      scanStoryPart(xml, path, report);
    }

    if (session.has("word/comments.xml")) {
      report.comments.count = countElements(
        await read("word/comments.xml"),
        "w:comment",
      );
    }

    // w:trackChanges is the schema element; w:trackRevisions is what some
    // writers emit for the same switch.
    const recordingChanges = session.has("word/settings.xml")
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
