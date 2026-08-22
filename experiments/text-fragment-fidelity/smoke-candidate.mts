import { buildLegalSourcePinpointUrl } from "./builder-candidate";
import fs from "node:fs";

const seeds = fs.readFileSync(new URL("./results/seeds.jsonl", import.meta.url), "utf8")
  .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
// Smoke: a plain seed, a colon-seam seed (Pratten-style), an NBSP seed.
const picks = [
  seeds.find((s) => s.label === "BCCA_2012_BCCA_480_p14_short-exact"),
  seeds.find((s) => s.label === "BCCA_2014_BCCA_79_p63_short-exact"),
  seeds.find((s) => s.shape === "hard-statute-ref"),
  seeds.find((s) => s.shape === "long-range"),
].filter(Boolean);
for (const seed of picks) {
  const url = buildLegalSourcePinpointUrl(
    { url: seed.url, ...(seed.anchor ? { anchor: seed.anchor } : {}), blockText: seed.blockText },
    seed.quotes ?? [],
  );
  const raw = url ? url.split(":~:text=")[1] ?? "" : "";
  const fragments = raw ? raw.split("&text=").map((piece) => {
    const trimmed = piece.replace(/%(?![0-9A-Fa-f]{2})/gu, "");
    try { return decodeURIComponent(trimmed.slice(0, 130)); } catch { return trimmed.slice(0, 130); }
  }) : [];
  console.log(JSON.stringify({ label: seed.label, directives: fragments.length, fragments }, null, 1));
}
