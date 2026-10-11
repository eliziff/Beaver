// What the works harvest knows of how far works run, for the citation engine's locator rules (its `extents`
// option): a decision's last paragraph, a report's or article's last page. The pack is
// backend/scripts/harvest-works.ts pack's (work-extents-data.mjs); a build may leave it out, and then no work has
// an extent.
import pack from "./work-extents-data.mjs";

let read;

/** The pack read once: decisions' last paragraphs by neutral key, and reports' and articles' extents by key. */
function extents() {
  if (read) return read;
  read = new Map();
  for (const line of pack ? pack.split("\n") : []) {
    const [kind, first, second, list] = line.split("\t");
    if (kind === "N") {
      let number = 0;
      for (const entry of list.split(",")) {
        const [gap, paragraphs] = entry.split(":");
        number += Number(gap);
        read.set(`3:neutral:${second}:${first}:${number}`, { paragraphs: Number(paragraphs) });
      }
    } else if (kind === "V") {
      let page = 0;
      for (const entry of second.split(",")) {
        const [gap, span, paragraphs] = entry.split(":");
        page += Number(gap);
        read.set(`3:${first}:${page}`, {
          ...(span ? { lastPage: page + Number(span) } : {}),
          ...(paragraphs ? { paragraphs: Number(paragraphs) } : {}),
        });
      }
    }
  }
  return read;
}

const registered = new WeakSet();
/** Registers the pack's extents with an engine, once: its extractions read a work's extent by the citation's key. */
export function registerWorkExtents(engine) {
  if (registered.has(engine)) return;
  registered.add(engine);
  const known = extents();
  if (known.size) engine.citationEngineCall("registerExtents",
    JSON.stringify({ extents: [...known].map(([key, extent]) => ({ key, ...extent })) }));
}
