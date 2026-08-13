#!/usr/bin/env node

async function main() {
  const runner = await import("../runner.ts");
  const a2ajLocalBulk = await import("../../../backend/src/lib/a2ajLocalBulk.ts");
  const a2aj = await import("../../../backend/src/lib/a2aj.ts");
  const boundaries = await import("../../../backend/experiments/a2aj-decision-roster/legalOpinionBoundaries.ts");

  const candidates = runner.selectedCandidates(7, 15, "SCC");
  const times: Record<string, number[]> = {
    fetch: [], structure: [], analyze: [], partition: [], loadCase: [], total: [],
  };
  for (const candidate of candidates) {
    const t0 = performance.now();
    const document = a2ajLocalBulk.fetchLocalA2AJDocument({
      citation: candidate.citation,
      dataset: candidate.dataset,
      docType: "cases",
      language: "en",
      maxChars: Number.MAX_SAFE_INTEGER,
    });
    if (!document) continue;
    const t1 = performance.now();
    const source = a2ajLocalBulk.getLocalA2AJStructure(document) ?? a2aj.getA2AJDocumentSourceDoc(document);
    const t2 = performance.now();
    const paragraphs = source.blocks.filter((block) => block.kind === "paragraph");
    const structure = boundaries.analyzeOpinionStructure({
      text: source.text,
      firstParagraphStart: paragraphs[0]?.start ?? 0,
    });
    const t3 = performance.now();
    boundaries.partitionOpinionStructure(
      structure,
      paragraphs.map((block) => {
        const match = /^par(\d+)$/u.exec(block.label);
        return match ? Number(match[1]) : Number(block.label) || 0;
      }),
    );
    const t4 = performance.now();
    times.fetch.push(t1 - t0);
    times.structure.push(t2 - t1);
    times.analyze.push(t3 - t2);
    times.partition.push(t4 - t3);
    times.total.push(t4 - t0);
    const t5 = performance.now();
    await runner.loadCase(candidate);
    times.loadCase.push(performance.now() - t5);
  }
  for (const [name, arr] of Object.entries(times)) {
    if (!arr.length) continue;
    const sorted = [...arr].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const max = sorted[sorted.length - 1];
    console.log(`${name.padEnd(12)} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${max.toFixed(1)}ms`);
  }
}

main();
