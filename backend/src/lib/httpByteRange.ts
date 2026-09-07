import type { Request, Response } from "express";

// A single range is sufficient for PDF.js. Unsupported/malformed/multiple ranges
// fall back to the complete representation, rather than inventing a multipart body.
export function sendByteRange(req: Request, res: Response, bytes: Buffer, digest: string) {
  const etag = `"${digest}"`, size = bytes.length;
  res.set({ ETag: etag, "Accept-Ranges": "bytes", "Cache-Control": "private, no-store" });
  const matches = req.get("If-Match");
  if (matches && !matches.split(",").some(value => value.trim() === etag || value.trim() === "*"))
    return void res.status(412).end();
  const unchanged = req.get("If-None-Match");
  if (unchanged?.split(",").some(value => value.trim().replace(/^W\//u, "") === etag || value.trim() === "*"))
    return void res.status(304).end();
  const header = req.get("Range"), condition = req.get("If-Range");
  const match = req.method === "GET" && (!condition || condition === etag) && header && header.length <= 150
    ? /^bytes=(\d*)-(\d*)$/iu.exec(header ?? "") : null;
  if (!match || (!match[1] && !match[2])) return void res.send(bytes);
  const length = BigInt(size);
  const from = match[1] ? BigInt(match[1]) : length - BigInt(match[2]);
  const start = from < 0n ? 0n : from;
  const to = match[1] && match[2] ? BigInt(match[2]) : length - 1n;
  const end = to >= length ? length - 1n : to;
  if (start >= length || end < start) {
    res.set("Content-Range", `bytes */${size}`);
    return void res.status(416).end();
  }
  res.set("Content-Range", `bytes ${start}-${end}/${size}`);
  res.status(206).send(bytes.subarray(Number(start), Number(end) + 1));
}
