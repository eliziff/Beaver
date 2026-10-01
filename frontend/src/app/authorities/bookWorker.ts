/// <reference lib="webworker" />
// Assembles a prepared book away from the page, so building never stalls scrolling or typing.
// Imported inline (?worker&inline): the self-contained page carries it, with no file of its own.
import * as pdf from "pdf-lib";
import { renderAuthoritiesBook, type PreparedAuthoritiesBook } from "../../../../backend/src/lib/authoritiesBook";

self.onmessage = async ({ data }: MessageEvent<PreparedAuthoritiesBook>) => {
  try {
    const built = await renderAuthoritiesBook(pdf, data);
    self.postMessage({ built }, { transfer: [...new Set(built.map(({ bytes }) => bytes.buffer as ArrayBuffer))] });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
