import { ARIAL_POSTSCRIPT_NAMES, type ArialFace, type ArialFaces } from "mike/shared/runtime/arialFont.mjs";

type LocalFont = { postscriptName: string; blob(): Promise<Blob> };
declare global {
  interface Window { queryLocalFonts?: (options?: { postscriptNames?: string[] }) => Promise<LocalFont[]> }
}

/** The machine's own Arial, through Chrome's local font access: called while the Build click still
 *  counts as the person's gesture, so Chrome can ask once. None where the browser has no such access
 *  or the person declines; the book then names Arial without embedding it. */
export async function localArial(): Promise<ArialFaces> {
  try {
    const fonts = await window.queryLocalFonts?.({ postscriptNames: Object.values(ARIAL_POSTSCRIPT_NAMES) }) ?? [];
    const faces: ArialFaces = {};
    for (const [face, name] of Object.entries(ARIAL_POSTSCRIPT_NAMES) as Array<[ArialFace, string]>) {
      const font = fonts.find((candidate) => candidate.postscriptName === name);
      if (font) faces[face] = new Uint8Array(await (await font.blob()).arrayBuffer());
    }
    return faces;
  } catch { return {}; }
}
