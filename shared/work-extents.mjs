// What the works harvest knows of how far works run, for the citation engine's locator rules (its `extents`
// option): a decision's last paragraph, a report's or article's last page. The pack is
// backend/scripts/harvest-works.ts pack's (work-extents-data.mjs); a build may leave it out, and then no work has
// an extent.
import pack from "./work-extents-data.mjs";

const registered = new WeakSet();
/** Registers the pack's extents with an engine, once: its extractions read a work's extent by the citation's key. */
export function registerWorkExtents(engine) {
  if (registered.has(engine)) return;
  registered.add(engine);
  // The engine reads the pack itself.
  if (pack) engine.citationEngineCall("registerExtents", JSON.stringify({ pack }));
}
