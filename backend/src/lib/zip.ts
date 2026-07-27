import type JSZip from "jszip";

/** jszip costs ~50ms to require; load it on first archive open, not at boot. */
export async function loadZip(
  bytes: Buffer | Uint8Array | ArrayBuffer,
): Promise<JSZip> {
  return (await import("jszip")).default.loadAsync(bytes);
}
