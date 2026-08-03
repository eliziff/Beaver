#!/usr/bin/env node

async function main() {
  const mod = await import("../../../backend/src/lib/legalOpinionBoundaries.ts");

  const hostile = [
    "The Honourable Madam Justice Stromberg-Stein",
    "The Honourable Madam Justice W.J. Ritchie, C.J., and Strong, Fournier, Henry, Taschereau and Gwynne, JJ.",
    "The Honourable Madam Justice Stromberg-Steinberg-Steinberg-Steinberg",
    "Sir W.J. Ritchie, C.J., and Strong, Fournier, Henry, Taschereau and Gwynne, JJ.",
    "The Honourable Madam Justice D. Smith, J.A.",
    "The Honourable Madam Justice " + "Karakatsanis ".repeat(30) + "J.",
  ];
  for (const text of hostile) {
    const t = Date.now();
    const r = mod.analyzeOpinionStructure({ text });
    console.log(`${String(Date.now() - t).padStart(7)}ms panel=${JSON.stringify(r.panel)} bindings=${r.bindings.length} refusals=${r.refusals.length}`);
  }

  const doc193176 = `PRESENT:—Sir W.J. Ritchie, C.J., and Strong, Fournier, Henry, Taschereau and Gwynne, JJ.

[1] This is an appeal.`;
  const t = Date.now();
  const r = mod.analyzeOpinionStructure({ text: doc193176 });
  console.log("193176-style:", Date.now() - t, "ms", JSON.stringify(r.panel));
}

main();
