import { stat } from "node:fs/promises";
import path from "node:path";
import type { RequestHandler } from "express";

const types: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
};
const encodings = [{ name: "br", extension: "br" }, { name: "gzip", extension: "gz" }];

/** Serve only build-time compressed public assets; no dynamic compression,
 * document bytes, configuration, cookies, API responses, or stream buffering.
 * Mount before express.static, after the normal security boundary.
 */
export function precompressedAssets(frontend: string): RequestHandler {
  return async (req, res, next) => {
    const match = /^\/assets\/([a-zA-Z0-9_.-]+\.(js|css|svg))$/u.exec(req.path);
    if (!match || !["GET", "HEAD"].includes(req.method)) return next();
    res.vary("Accept-Encoding");
    // Byte ranges remain the existing unencoded static-file contract.
    if (req.get("Range")) {
      if (!req.acceptsEncodings("identity")) { res.sendStatus(406); return; }
      return next();
    }
    try {
      const original = path.join(frontend, "assets", match[1]);
      const source = await stat(original).catch(() => null);
      if (!source?.isFile()) return next();
      const variants = (await Promise.all(encodings.map(async (encoding) => {
        const file = `${original}.${encoding.extension}`;
        const info = await stat(file).catch(() => null);
        return info?.isFile() ? { ...encoding, file, info } : null;
      }))).filter((variant) => variant !== null);
      const preferred = req.acceptsEncodings(...variants.map((variant) => variant.name), "identity");
      if (!preferred) { res.sendStatus(406); return; }
      const variant = variants.find((item) => item.name === preferred);
      if (!variant) return next();
      res.sendFile(variant.file, {
        immutable: true, maxAge: "1y", acceptRanges: false,
        headers: {
          "Content-Type": types[match[2]],
          "Content-Encoding": variant.name,
          // Validators distinguish representations even when their sizes match.
          ETag: `W/"${variant.info.size.toString(16)}-${variant.info.mtimeMs.toString(16)}-${variant.name}"`,
        },
      }, (error) => {
        if (!error) return;
        if (!res.headersSent) {
          res.removeHeader("Content-Encoding");
          res.removeHeader("Content-Length");
          res.removeHeader("Content-Type");
          res.removeHeader("ETag");
        }
        next(error);
      });
    } catch (error) { next(error); }
  };
}
