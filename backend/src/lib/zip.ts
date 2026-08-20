import type JSZip from "jszip";
import { Readable } from "node:stream";

export type ZipReadBudget = { remaining: number };
export const zipReadBudget = (maxBytes: number): ZipReadBudget => ({ remaining: maxBytes });

/** Stream an entry so forged ZIP size metadata cannot bypass allocation limits. */
export async function readZipEntry(entry: JSZip.JSZipObject, maxBytes: number,
  budget = zipReadBudget(maxBytes), label = "ZIP entry") {
  const chunks: Buffer[] = [];
  let size = 0;
  const stream = new Readable({ read() {} }).wrap(entry.nodeStream());
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.byteLength;
    if (size > maxBytes || chunk.byteLength > budget.remaining)
      throw new Error(`${label} expands beyond the read limit`);
    budget.remaining -= chunk.byteLength;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
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
