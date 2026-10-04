import jbig2 from "pdfjs-dist/wasm/jbig2.wasm?url";
import openjpeg from "pdfjs-dist/wasm/openjpeg.wasm?url";
import qcms from "pdfjs-dist/wasm/qcms_bg.wasm?url";

/** Where PDF.js loads its image decoders from, by file name. The standalone page replaces this module
 *  with one that hands over the decoders it carries gzipped (AuthoritiesHelper/modern/html/standalone-pdf-decoders.mjs),
 *  which its recognizer's PDF.js shares. */
export const pdfDecoders = async (): Promise<Record<string, string>> =>
  ({ "jbig2.wasm": jbig2, "openjpeg.wasm": openjpeg, "qcms_bg.wasm": qcms });
