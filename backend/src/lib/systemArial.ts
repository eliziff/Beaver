import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { PDFDocument } from "pdf-lib";
import type { ArialFace, ArialFaces } from "mike/shared/runtime/arialFont.mjs";

// Where each system keeps the Arial it installs, and what it calls each face's file.
const DIRECTORIES = process.platform === "win32" ? [path.join(process.env.WINDIR ?? "C:\\Windows", "Fonts")]
  : process.platform === "darwin" ? ["/System/Library/Fonts/Supplemental", "/Library/Fonts"]
  : ["/usr/share/fonts/truetype/msttcorefonts", "/usr/share/fonts/TTF", "/usr/share/fonts/truetype"];
const FILES: Record<ArialFace, string[]> = { regular: ["arial.ttf"], bold: ["arialbd.ttf", "arial bold.ttf", "arial_bold.ttf"],
  italic: ["ariali.ttf", "arial italic.ttf", "arial_italic.ttf"],
  boldItalic: ["arialbi.ttf", "arial bold italic.ttf", "arial_bold_italic.ttf"] };

let found: Promise<ArialFaces> | undefined;
/** The machine's own Arial files, read once; none where it has no Arial. */
export function systemArial() {
  return found ??= (async () => {
    const faces: ArialFaces = {};
    for (const directory of DIRECTORIES) {
      const names = await readdir(directory).catch(() => [] as string[]);
      for (const [face, files] of Object.entries(FILES) as Array<[ArialFace, string[]]>) {
        const file = !faces[face] && names.find((name) => files.includes(name.toLowerCase()));
        if (file) faces[face] = new Uint8Array(await readFile(path.join(directory, file)));
      }
    }
    return faces;
  })();
}

/** The font engine pdf-lib embeds a font file with, where it is installed. */
export async function pdfFontkit(): Promise<Parameters<PDFDocument["registerFontkit"]>[0] | undefined> {
  return import("@pdf-lib/fontkit").then((module) => (module as { default?: unknown }).default ?? module,
    () => undefined) as Promise<Parameters<PDFDocument["registerFontkit"]>[0] | undefined>;
}
