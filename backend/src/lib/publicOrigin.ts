export function publicOrigin() {
  const value = process.env.PUBLIC_ORIGIN?.trim();
  if (!value) throw new Error("PUBLIC_ORIGIN is required");
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(hostname);
  if (url.origin !== value.replace(/\/$/u, "") || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash ||
      !["https:", "http:"].includes(url.protocol) ||
      (url.protocol !== "https:" && (process.env.NODE_ENV === "production" || !loopback))) {
    throw new Error("PUBLIC_ORIGIN must be an exact HTTPS origin");
  }
  return url.origin;
}
