import type { PDFDocument, PDFFont, PDFPage, PDFPageDrawTextOptions } from "pdf-lib";
import { fetchBytes } from "@/app/lib/apiTransport";

type CourtTextOptions = PDFPageDrawTextOptions & {
  font: PDFFont;
  size: number;
  x: number;
  y: number;
};

type FontSource = {
  file: string;
  matches: (character: string) => boolean;
};

const FONT_ROOT = new URL(
  "/court-fonts/",
  globalThis.location?.origin ?? "http://localhost",
);
const FONT_SOURCES: FontSource[] = [
  { file: "NotoSansCanadianAboriginal-Regular.ttf",
    matches: (character) => /[\u1400-\u167f\u18b0-\u18ff]/u.test(character) },
  { file: "NotoNaskhArabic-Regular.ttf",
    matches: (character) => /\p{Script_Extensions=Arabic}/u.test(character) },
  { file: "NotoSerifSC-Regular.ttf",
    matches: (character) => /\p{Script_Extensions=Han}/u.test(character) },
];
const GENERAL_FONT = { file: "NotoSerif-Regular.ttf", matches: () => true };
const fallbacks = new WeakMap<PDFFont, readonly PDFFont[]>();
const characterSets = new WeakMap<PDFFont, Set<number>>();
const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });

export function courtPdfText(value: string) {
  return value.normalize("NFC").replace(/\t/gu, " ");
}

export async function registerCourtPdfFonts(
  document: PDFDocument,
  primaryFonts: readonly PDFFont[],
  values: unknown,
  allowFallback = true,
) {
  const unsupported = uniqueCharacters(stringsIn(values).join("\n"))
    .filter((character) => !primaryFonts.some((font) => supports(font, character)));
  if (!unsupported.length) return;
  if (!allowFallback) {
    throw new Error("Federal Court generated pages contain characters unavailable in the permitted fonts. Use a permitted-font spelling or prepare the filing outside the builder.");
  }

  const sources = FONT_SOURCES.filter((source) => unsupported.some(source.matches));
  if (unsupported.some((character) => !sources.some((source) => source.matches(character)))) {
    sources.push(GENERAL_FONT);
  }
  const imported = await import("@pdf-lib/fontkit") as unknown as {
    default?: Parameters<PDFDocument["registerFontkit"]>[0];
  } & Parameters<PDFDocument["registerFontkit"]>[0];
  document.registerFontkit(imported.default ?? imported);
  const embedded = await Promise.all(sources.map(async ({ file }) => {
    const bytes = await fetchBytes(new URL(file, FONT_ROOT), `The bundled court PDF font ${file}`);
    return document.embedFont(bytes, { subset: true });
  }));
  const missing = unsupported.filter((character) =>
    !embedded.some((font) => supports(font, character)));
  if (missing.length) throw unsupportedFontError(missing);
  primaryFonts.forEach((font) => fallbacks.set(font, embedded));
}

export function courtPdfTextWidth(value: string, font: PDFFont, size: number) {
  return fontRuns(value, font).reduce((width, run) =>
    width + run.font.widthOfTextAtSize(run.text, size), 0);
}

export function drawCourtPdfText(page: PDFPage, value: string, options: CourtTextOptions) {
  const lines = courtPdfText(value).split(/\r?\n/u);
  if (lines.length > 1) {
    lines.forEach((line, index) => drawCourtPdfText(page, line, {
      ...options,
      y: options.y - index * (options.lineHeight ?? 24),
    }));
    return;
  }
  let x = options.x;
  for (const run of fontRuns(lines[0], options.font)) {
    page.drawText(run.text, { ...options, x, font: run.font });
    x += run.font.widthOfTextAtSize(run.text, options.size);
  }
}

function fontRuns(value: string, primary: PDFFont) {
  const text = courtPdfText(value);
  const candidates = [primary, ...(fallbacks.get(primary) ?? [])];
  const segments = [...graphemes.segment(text)].map(({ segment }) => ({
    text: segment,
    font: candidates.find((font) => supports(font, segment)),
  }));
  const missing = segments.filter(({ font }) => !font).map(({ text: segment }) => segment);
  if (missing.length) throw unsupportedFontError(uniqueCharacters(missing.join("")));
  for (let index = 0; index < segments.length; index += 1) {
    if (!/^\s+$/u.test(segments[index].text)) continue;
    const previous = segments.slice(0, index)
      .findLast(({ text: segment }) => !/^\s+$/u.test(segment));
    const next = segments.slice(index + 1)
      .find(({ text: segment }) => !/^\s+$/u.test(segment));
    if (previous && next && previous.font === next.font) segments[index].font = previous.font;
  }
  return segments.reduce<Array<{ text: string; font: PDFFont }>>((runs, segment) => {
    const font = segment.font!;
    if (runs.at(-1)?.font === font) runs[runs.length - 1].text += segment.text;
    else runs.push({ text: segment.text, font });
    return runs;
  }, []);
}

function supports(font: PDFFont, value: string) {
  let set = characterSets.get(font);
  if (!set) {
    set = new Set(font.getCharacterSet());
    characterSets.set(font, set);
  }
  return [...value].every((character) => /[\r\n]/u.test(character) ||
    set!.has(character.codePointAt(0)!));
}

function uniqueCharacters(value: string) {
  return [...new Set([...courtPdfText(value)]
    .filter((character) => !/[\r\n]/u.test(character)))];
}

function stringsIn(value: unknown, seen = new Set<object>()): string[] {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  return Object.values(value).flatMap((child) => stringsIn(child, seen));
}

function unsupportedFontError(characters: string[]) {
  return new Error(`The bundled court PDF fonts cannot render ${characters.map((character) =>
    `"${character}" (U+${character.codePointAt(0)!.toString(16).toUpperCase()})`).join(", ")}.`);
}
