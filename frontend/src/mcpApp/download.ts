import { app, toBase64 } from "./host";

/** The host saves files: the page's sandbox has no downloads of its own. A host without a download
 *  of its own opens a short-lived link to the file from the connector instead. */
export async function downloadBlob(blob: Blob, filename: string) {
  const data = await toBase64(blob), type = blob.type || "application/octet-stream";
  if (app.getHostCapabilities()?.downloadFile) {
    const { isError } = await app.downloadFile({ contents: [{ type: "resource", resource: {
      uri: `file:///${encodeURIComponent(filename)}`, mimeType: type, blob: data } }] });
    if (isError) throw new Error(`${filename} was not downloaded.`);
    return;
  }
  const result = await app.callServerTool({ name: "beaver_download", arguments: { filename, type, data } });
  const url = (result.structuredContent as { url?: string } | undefined)?.url;
  if (result.isError || !url) throw new Error(`${filename} could not be downloaded.`);
  await app.openLink({ url });
}
export async function downloadUrl(url: string, filename: string) {
  await downloadBlob(await (await fetch(url)).blob(), filename);
}
