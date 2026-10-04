import { App } from "@modelcontextprotocol/ext-apps";

/** Beaver inside ChatGPT or Claude: the host renders this page for a tool result and relays its calls. */
export const app = new App({ name: "Beaver", version: "1.0.0" }, { availableDisplayModes: ["inline", "fullscreen"] });

export async function toBase64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(binary);
}
const fromBase64 = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

type Reply = { status: number; headers: Record<string, string>; text?: string; base64?: string };

// The page's Beaver requests go through the host to the connector, which makes them for it: a host's
// sandbox may reach no server of its own. Every other request is the browser's as usual.
const browserFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith("/api/")) return browserFetch(input, init);
  const request = new Request(new URL(url, "https://beaver.invalid"), input instanceof Request ? input : init);
  const body = init?.body ?? (input instanceof Request ? await input.clone().blob() : undefined);
  const headers = Object.fromEntries(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)));
  const form = body instanceof FormData ? await Promise.all([...body].map(async ([name, value]) => typeof value === "string"
    ? { name, value } : { name, filename: value.name, type: value.type, data: await toBase64(value) })) : undefined;
  const result = await app.callServerTool({ name: "beaver_api", arguments: { method: request.method, path: url.slice(4), headers,
    ...(form ? { form } : body == null ? {} : typeof body === "string" ? { body }
      : { base64: await toBase64(body instanceof Blob ? body : new Blob([body as BlobPart])) }) } });
  const reply = result.structuredContent as Reply | undefined;
  if (result.isError || !reply) throw new TypeError("Beaver could not be reached. Reopen it from the chat.");
  const content = [101, 204, 205, 304].includes(reply.status) ? null
    : reply.base64 !== undefined ? fromBase64(reply.base64) : reply.text ?? "";
  return new Response(content, { status: reply.status, headers: reply.headers });
};

// Links leave through the host, which opens them beside the conversation.
document.addEventListener("click", (event) => {
  const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!anchor || anchor.hasAttribute("download") || !/^https?:/iu.test(anchor.href)) return;
  event.preventDefault();
  void app.openLink({ url: anchor.href });
}, true);
window.open = ((url?: string | URL) => {
  if (url) void app.openLink({ url: String(url) });
  return null;
}) as typeof window.open;
