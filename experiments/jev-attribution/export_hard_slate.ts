// Adapter for the a2aj-case-treatment structure slate: verify the line-unit
// convention, then emit packets in the same form the Jev runner consumes, plus
// gold character spans for overlap scoring. Offline; no model calls.
import { readFileSync, writeFileSync } from 'node:fs';
import { fetchLocalA2AJDocumentsByIds } from '../../backend/src/lib/a2ajLocalBulk';
import { modelSourceLines } from '../../backend/experiments/a2aj-decision-roster/caseTargetMvpReduced';

const file = 'backend/experiments/a2aj-case-treatment/gold/gold-structure-30-v6.jsonl';
const records = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
const structure = (record: any) => record.annotation?.structure ?? record.structure;
const docs = fetchLocalA2AJDocumentsByIds({
  ids: records.map((r: any) => r.document_id), maxChars: Number.MAX_SAFE_INTEGER,
});

const packets: any[] = [];
const diagnostics: any[] = [];
for (const record of records) {
  const doc = docs.get(record.document_id);
  if (!doc) { diagnostics.push({ document_id: record.document_id, error: 'missing source' }); continue; }
  const lines = modelSourceLines(doc.text);
  const opinions = structure(record).opinions.map((opinion: any) => ({
    start_line: opinion.boundary.start_line, end_line: opinion.boundary.end_line,
    start_quote: opinion.boundary.start_quote ?? '', end_quote: opinion.boundary.end_quote ?? '',
  }));
  // Does their line number address the same unit as modelSourceLines?
  const unitMatch = opinions.every((opinion: any) => {
    const line = lines[opinion.start_line - 1];
    if (!line) return false;
    const text = doc.text.slice(line.start, line.end);
    const probe = opinion.start_quote.replace(/\s+/g, ' ').trim().slice(0, 24);
    return !probe || text.replace(/\s+/g, ' ').includes(probe);
  });
  const gold = opinions.map((opinion: any) => {
    const start = lines[opinion.start_line - 1]?.start ?? 0;
    const end = lines[opinion.end_line - 1]?.end ?? 0;
    return { start_line: opinion.start_line, end_line: opinion.end_line, start, end };
  });
  diagnostics.push({ document_id: record.document_id, citation: record.citation,
    line_count: lines.length, opinions: opinions.length, unit_match: unitMatch,
    start_quotes: opinions.map((o: any) => o.start_quote.slice(0, 30)) });
  packets.push({ document_id: record.document_id, citation: record.citation,
    cohort: 'case-treatment-structure-30',
    lines: lines.map((line) => ({ ...line, text: doc.text.slice(line.start, line.end) })),
    gold });
}
writeFileSync('experiments/jev-attribution/receipts/hard-slate.json', JSON.stringify(packets, null, 2));
const mismatched = diagnostics.filter((d) => d.unit_match === false);
console.log(JSON.stringify({ records: records.length, packets: packets.length,
  unit_mismatch: mismatched.length, over_255_lines: diagnostics.filter((d) => (d.line_count ?? 0) > 255).length,
  max_lines: Math.max(...diagnostics.map((d) => d.line_count ?? 0)), mismatched,
  line_counts: diagnostics.map((d) => `${d.document_id}:${d.line_count}L/${d.opinions}op`) }, null, 2));
