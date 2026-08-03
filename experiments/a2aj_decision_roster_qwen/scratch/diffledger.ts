#!/usr/bin/env node

async function main() {
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");

  const mod = await import("../../../backend/src/lib/legalOpinionBoundaries.ts");
  const runner = await import("../runner.ts");

  const rows = (await readFile(path.join(process.cwd(), "seeds", "1.SCC.jsonl"), "utf8"))
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  for (const row of rows) {
    if (!row.verdict) continue;
    const record = await runner.loadCase({
      documentId: row.documentId,
      dataset: "SCC",
      citation: row.citation,
      name: null,
      date: null,
    });
    if (!record || record.sourceSha256 !== row.sourceSha256) {
      console.log("===", row.citation, "SOURCE CHANGED");
      continue;
    }
    const oldPanel = JSON.stringify(row.claims.panel);
    const oldBindings = JSON.stringify(
      row.claims.bindings.map((b) => [b.role, b.names, b.from, b.to, b.line.slice(0, 60)]),
    );
    const newPanel = JSON.stringify(record.structure.panel);
    const newBindings = JSON.stringify(
      record.structure.bindings.map((b) => [b.role, b.names, b.from, b.to, b.line.slice(0, 60)]),
    );
    const changed = oldPanel !== newPanel || oldBindings !== newBindings;
    if (!changed) continue;
    console.log("===", row.citation, `(id=${row.documentId}, verdict=${row.verdict})`);
    if (oldPanel !== newPanel) console.log("  panel OLD:", oldPanel, "\n  panel NEW:", newPanel);
    if (oldBindings !== newBindings) {
      console.log("  bindings OLD:", oldBindings);
      console.log("  bindings NEW:", newBindings);
    }
    const refusals = JSON.stringify(row.claims.refusals);
    const newRefusals = JSON.stringify(record.structure.refusals);
    if (refusals !== newRefusals) console.log("  refusals OLD:", refusals, "\n  refusals NEW:", newRefusals);
    const markerN = row.claims.markers.length;
    const newMarkerN = record.structure.bodyMarkers.length;
    if (markerN !== newMarkerN) console.log(`  markers OLD:${markerN} NEW:${newMarkerN}`);
    console.log("  header snippet:", JSON.stringify(record.structure.header?.slice(0, 300)));
  }
}

main();
