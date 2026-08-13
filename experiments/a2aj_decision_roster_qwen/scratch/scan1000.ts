#!/usr/bin/env node

async function main() {
  const runner = await import("../runner.ts");
  const a2ajLocalBulk = await import("../../../backend/src/lib/a2ajLocalBulk.ts");
  const a2aj = await import("../../../backend/src/lib/a2aj.ts");
  const boundaries = await import("../../../backend/experiments/a2aj-decision-roster/legalOpinionBoundaries.ts");

  const started = performance.now();
  const candidates = runner.selectedCandidates(2, 1000, "SCC");
  console.log(`draw: ${candidates.length} candidates in ${(performance.now() - started).toFixed(0)}ms`);

  let slow = 0;
  let maxTotal = 0;
  let worst: { id: number; stage: string; ms: number } | null = null;
  const stageTotals: Record<string, number> = { source: 0, analyze: 0, partition: 0, sha: 0 };
  let ordinal = 0;
  for (let index = 0; index < candidates.length; index += 50) {
    const chunk = candidates.slice(index, index + 50);
    const tFetch = performance.now();
    const documents = a2ajLocalBulk.fetchLocalA2AJDocumentsByIds({
      ids: chunk.map((c) => c.documentId),
      docType: "cases",
      language: "en",
      maxChars: Number.MAX_SAFE_INTEGER,
    });
    console.log(`chunk ${index / 50 + 1}: fetch ${(performance.now() - tFetch).toFixed(0)}ms for ${documents.size}/${chunk.length} docs`);
    for (const candidate of chunk) {
      ordinal += 1;
      const document = documents.get(candidate.documentId);
      if (!document) continue;
      const t0 = performance.now();
      const source = a2ajLocalBulk.getLocalA2AJStructure(document) ?? a2aj.getA2AJDocumentSourceDoc(document);
      const t1 = performance.now();
      const paragraphs = source.blocks.filter((block) => block.kind === "paragraph");
      const structure = boundaries.analyzeOpinionStructure({
        text: source.text,
        firstParagraphStart: paragraphs[0]?.start ?? 0,
      });
      const t2 = performance.now();
      boundaries.partitionOpinionStructure(
        structure,
        paragraphs.map((block) => {
          const match = /^par(\d+)$/u.exec(block.label);
          return match ? Number(match[1]) : Number(block.label) || 0;
        }),
      );
      const t3 = performance.now();
      const total = t3 - t0;
      stageTotals.source += t1 - t0;
      stageTotals.analyze += t2 - t1;
      stageTotals.partition += t3 - t2;
      if (total > maxTotal) {
        maxTotal = total;
        worst = { id: candidate.documentId, stage: "all", ms: total };
      }
      if (total > 500) {
        slow += 1;
        console.log(`SLOW ${candidate.documentId} ${candidate.citation} total=${total.toFixed(0)}ms source=${(t1 - t0).toFixed(0)} analyze=${(t2 - t1).toFixed(0)} partition=${(t3 - t2).toFixed(0)}`);
      }
    }
    console.log(`... ${Math.min(index + 50, candidates.length)}/${candidates.length} processed ${((performance.now() - started) / 1000).toFixed(1)}s`);
  }
  console.log(`slow(>500ms): ${slow}`);
  console.log(`worst: ${worst?.id} ${worst?.stage} ${worst?.ms.toFixed(0)}ms`);
  console.log(`stage totals: ${JSON.stringify(Object.fromEntries(Object.entries(stageTotals).map(([k, v]) => [k, v.toFixed(0) + "ms"])))}`);
  console.log(`overall: ${((performance.now() - started) / 1000).toFixed(1)}s`);
}

main();
