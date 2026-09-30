import type JSZip from "jszip";

export type ZipReadBudget = { remaining: number };
export const zipReadBudget = (maxBytes: number): ZipReadBudget => ({ remaining: maxBytes });

/** Stream an entry so forged ZIP size metadata cannot bypass allocation limits. */
export async function readZipEntry(entry: JSZip.JSZipObject, maxBytes: number,
  budget = zipReadBudget(maxBytes), label = "ZIP entry") {
  const chunks: Buffer[] = [];
  let size = 0;
  return new Promise<Buffer>((resolve, reject) => {
    // JSZip's declarations omit this documented portable streaming API.
    const stream = (entry as JSZip.JSZipObject & {
      internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array>;
    }).internalStream("uint8array");
    stream.on("data", (chunk) => {
      size += chunk.byteLength;
      if (size > maxBytes || chunk.byteLength > budget.remaining) {
        stream.pause();
        reject(new Error(`${label} expands beyond the read limit`));
        return;
      }
      budget.remaining -= chunk.byteLength;
      chunks.push(Buffer.from(chunk));
    }).on("error", reject).on("end", () => resolve(Buffer.concat(chunks, size))).resume();
  });
}

/** jszip costs ~50ms to require; load it on first archive open, not at boot. */
export async function loadZip(
  bytes: Buffer | Uint8Array | ArrayBuffer,
): Promise<JSZip> {
  return (await import("jszip")).default.loadAsync(bytes);
}

export function assertBoundedZip(zip: JSZip, label: string, options: {
  maxEntries: number; maxExpandedBytes: number;
  selected?: { test: RegExp; maxEntryBytes: number; maxBytes: number; name: string };
}) {
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (entries.length > options.maxEntries)
    throw new Error(`${label} contains too many package entries`);
  let expanded = 0, selected = 0;
  for (const entry of entries) {
    const raw = (entry as { _data?: { uncompressedSize?: unknown } })._data?.uncompressedSize;
    if (!Number.isSafeInteger(raw) || Number(raw) < 0)
      throw new Error(`${label} has invalid ZIP size metadata`);
    const size = Number(raw); expanded += size;
    if (options.selected?.test.test(entry.name)) {
      if (size > options.selected.maxEntryBytes)
        throw new Error(`${label} contains an oversized ${options.selected.name}`);
      selected += size;
    }
  }
  if (expanded > options.maxExpandedBytes ||
      options.selected && selected > options.selected.maxBytes)
    throw new Error(`${label} expands beyond the read limit`);
}
