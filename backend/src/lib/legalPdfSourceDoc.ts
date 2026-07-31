import os from "node:os";
import path from "node:path";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";

import {
  LEGAL_PDF_DOCUMENT_SCHEMA,
  runLegalPdf,
} from "./legalPdfProcess";
import {
  createSourceDoc,
  normalizeSourceDocLocator,
  type SourceDoc,
  type SourceDocBlock,
} from "./sourceDoc";

type JsonObject = Record<string, unknown>;

export { LEGAL_PDF_DOCUMENT_SCHEMA } from "./legalPdfProcess";
export const LOCAL_PDF_SOURCE_SCHEMA = "mike.pdf_source.v1";

function string(value: unknown) {
  return typeof value === "string" ? value : "";
}

function integer(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function strings(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function cleanText(value: unknown) {
  return string(value).replace(/\u27e6FN:[^\u27e7]+\u27e7/gu, "").trim();
}

function jsonLines(value: string) {
  return value
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonObject);
}

export type LegalPdfArtifactRows = {
  manifest: JsonObject;
  pages: JsonObject[];
  paragraphs: JsonObject[];
  sections: JsonObject[];
  footnotes: JsonObject[];
};

/**
 * Compile the universal engine's durable artifact into the shared query
 * contract. The PDF engine owns detection; this adapter only lays its already
 * ordered records onto one text/offset plane.
 */
export function compileLegalPdfSourceDoc(
  rows: LegalPdfArtifactRows,
  options?: { id?: string; url?: string | null },
): SourceDoc {
  const schema = String(rows.manifest.schema_version);
  if (
    schema !== LEGAL_PDF_DOCUMENT_SCHEMA &&
    !(
      schema === LOCAL_PDF_SOURCE_SCHEMA &&
      rows.manifest.engine_schema_version === LEGAL_PDF_DOCUMENT_SCHEMA &&
      rows.manifest.artifact_profile === "compact-source"
    )
  ) {
    throw new Error("Unsupported legal PDF artifact schema");
  }

  const pieces: string[] = [];
  const blocks: SourceDocBlock[] = [];
  const paragraphOffsets = new Map<string, { start: number; end: number }>();
  let position = 0;
  let paragraphNumber = 0;
  const append = (value: string) => {
    pieces.push(value);
    position += value.length;
  };

  const paragraphsByPage = new Map<number, JsonObject[]>();
  for (const paragraph of rows.paragraphs) {
    const pageIndex = integer(paragraph.page_index);
    if (pageIndex === null) continue;
    const found = paragraphsByPage.get(pageIndex);
    if (found) found.push(paragraph);
    else paragraphsByPage.set(pageIndex, [paragraph]);
  }

  const orderedPages = [...rows.pages].sort(
    (left, right) =>
      (integer(left.index) ?? Number.MAX_SAFE_INTEGER) -
      (integer(right.index) ?? Number.MAX_SAFE_INTEGER),
  );
  for (const [pageOrder, page] of orderedPages.entries()) {
    if (pieces.length) append("\n\n");
    const pageIndex = integer(page.index) ?? pageOrder;
    const physicalNumber = integer(page.number) ?? pageIndex + 1;
    const printed = string(page.printed_label).trim();
    const display = printed || String(physicalNumber);
    const pageStart = position;
    append(`[page ${display}]\n`);
    const pageParagraphs = paragraphsByPage.get(pageIndex) ?? [];
    for (const [paragraphOrder, paragraph] of pageParagraphs.entries()) {
      const text = cleanText(paragraph.text);
      if (!text) continue;
      if (paragraphOrder) append("\n\n");
      const start = position;
      append(text);
      const end = position;
      const id =
        string(paragraph.id).trim() ||
        `page-${physicalNumber}-paragraph-${paragraphOrder + 1}`;
      paragraphOffsets.set(id, { start, end });
      paragraphNumber += 1;
      blocks.push({
        kind: "paragraph",
        label: `par${paragraphNumber}`,
        start,
        end,
        origin: "heuristic",
        anchor: id,
      });
    }
    blocks.push({
      kind: "page",
      label:
        normalizeSourceDocLocator("page", display) || `page${physicalNumber}`,
      start: pageStart,
      end: position,
      origin: printed ? "heuristic" : "native",
      anchor: `page=${physicalNumber}`,
      aliases: [
        String(physicalNumber),
        ...(printed && printed !== String(physicalNumber) ? [printed] : []),
      ],
    });
  }

  for (const [sectionOrder, section] of rows.sections.entries()) {
    const paragraphIds = strings(section.paragraph_ids);
    const first = paragraphOffsets.get(paragraphIds[0] ?? "");
    const last = paragraphOffsets.get(paragraphIds.at(-1) ?? "");
    if (!first || !last || first.start >= last.end) continue;
    const locator = string(section.locator).trim();
    const id = string(section.id).trim() || `section-${sectionOrder + 1}`;
    blocks.push({
      kind: "section",
      label:
        normalizeSourceDocLocator("section", locator) || `section:${id}`,
      start: first.start,
      end: last.end,
      origin:
        string(section.provenance).toLocaleLowerCase() === "native"
          ? "native"
          : "heuristic",
      anchor: id,
      aliases: [...new Set([locator, ...strings(section.aliases)].filter(Boolean))],
    });
  }

  for (const [noteOrder, note] of rows.footnotes.entries()) {
    const body = cleanText(note.body);
    if (!body) continue;
    append(`\n\n[footnote ${string(note.label).trim() || noteOrder + 1}]\n`);
    const start = position;
    append(body);
    const end = position;
    const label = string(note.label).trim();
    const pairId = string(note.pair_id).trim();
    blocks.push({
      kind: "footnote",
      label:
        normalizeSourceDocLocator("footnote", label) || `fn${noteOrder + 1}`,
      start,
      end,
      origin: "heuristic",
      anchor: pairId || undefined,
      aliases: [label, pairId].filter(Boolean),
    });
  }

  blocks.sort(
    (left, right) =>
      left.start - right.start ||
      left.end - right.end ||
      left.label.localeCompare(right.label),
  );
  return createSourceDoc({
    provider: "local-pdf",
    id:
      options?.id ||
      string(rows.manifest.document_id) ||
      string(rows.manifest.source_sha256),
    url: options?.url ?? null,
    text: pieces.join(""),
    blocks,
  });
}

async function artifactRows(root: string): Promise<LegalPdfArtifactRows> {
  const artifactRoot = path.resolve(root);
  const manifest = JSON.parse(
    await readFile(path.join(artifactRoot, "document.json"), "utf8"),
  ) as JsonObject;
  const artifacts =
    manifest.artifacts && typeof manifest.artifacts === "object"
      ? (manifest.artifacts as JsonObject)
      : {};
  const read = async (key: string) => {
    const filename = string(artifacts[key]);
    if (!filename) throw new Error(`Legal PDF artifact is missing ${key}`);
    const target = path.resolve(artifactRoot, filename);
    const relative = path.relative(artifactRoot, target);
    if (
      !relative ||
      relative.startsWith("..") ||
      path.isAbsolute(relative)
    ) {
      throw new Error(`Legal PDF artifact has an invalid ${key} path`);
    }
    return jsonLines(await readFile(target, "utf8"));
  };
  const [pages, paragraphs, sections, footnotes] = await Promise.all([
    read("pages"),
    read("paragraphs"),
    read("sections"),
    read("footnotes"),
  ]);
  return { manifest, pages, paragraphs, sections, footnotes };
}

export async function readLegalPdfSourceDoc(
  artifactRoot: string,
  options?: { id?: string; url?: string | null },
) {
  return compileLegalPdfSourceDoc(await artifactRows(artifactRoot), options);
}

export async function countLegalPdfPages(bytes: Buffer) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "mike-legalpdf-"));
  const source = path.join(temporary, "source.pdf");
  try {
    await writeFile(source, bytes);
    const { stdout } = await runLegalPdf(["page-count", source], {
      timeoutMs: 60_000,
    });
    const pages = integer((JSON.parse(stdout) as JsonObject).pages);
    if (pages === null || pages < 0) {
      throw new Error("Legal PDF engine returned an invalid page count");
    }
    return pages;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function parseLegalPdfSourceDoc(bytes: Buffer) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "mike-legalpdf-"));
  const source = path.join(temporary, "source.pdf");
  const output = path.join(temporary, "artifacts");
  try {
    await writeFile(source, bytes);
    await runLegalPdf([
      "parse",
      source,
      "--output",
      output,
      "--no-cache",
    ]);
    return await readLegalPdfSourceDoc(output);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function extractLegalPdfText(bytes: Buffer) {
  return (await parseLegalPdfSourceDoc(bytes)).text;
}
