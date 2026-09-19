// Deterministic engine vs the same gold and the same line units Jev was scored on.
// Offline only: calls the repository's deterministic boundary extractor. No model.
import { readFileSync, writeFileSync } from 'node:fs';
import { fetchLocalA2AJDocumentsByIds } from '../../backend/src/lib/a2ajLocalBulk';
import { modelSourceLines } from '../../backend/experiments/a2aj-decision-roster/caseTargetMvpReduced';
import { deriveTextOpinionStructure } from '../../backend/experiments/a2aj-decision-roster/legalOpinionBoundaries';

const base = 'experiments/jev-attribution/receipts/';
const gold = new Map<number, any[]>(
  JSON.parse(readFileSync(base + 'boundaries.json', 'utf8'))
    .map((p: any) => [p.document_id, p.gold.opinions.map((o: any) => ({ start: o.boundary.start_line, end: o.boundary.end_line }))]));

const docs = fetchLocalA2AJDocumentsByIds({ ids: [...gold.keys()], maxChars: Number.MAX_SAFE_INTEGER });
const rows: any[] = [];
for (const [documentId, expected] of gold) {
  const doc = docs.get(documentId);
  if (!doc) throw new Error(`missing source ${documentId}`);
  const lines = modelSourceLines(doc.text);
  const first = doc.text.indexOf('[1]');
  const result = deriveTextOpinionStructure({ text: doc.text, firstParagraphStart: first >= 0 ? first : 0 });
  const lineOf = (offset: number) => {
    for (const line of lines) if (offset >= line.start && offset < line.end) return line.line;
    return lines.length;
  };
  const predicted = result.opinions.map((opinion, index) => ({
    index: index + 1,
    start: lineOf(opinion.start),
    end: lineOf(Math.max(opinion.start, opinion.end - 1)),
    authors: opinion.authors,
    alignment: opinion.alignment,
    startQuote: opinion.startQuote.slice(0, 60),
    endQuote: opinion.endQuote.slice(0, 60),
  }));
  rows.push({ document_id: documentId, citation: doc.citation, status: result.status,
    refusals: result.refusals, panel: result.panel, predicted, gold: expected });
}
writeFileSync(base + 'boundary-predictions-det.json', JSON.stringify(rows, null, 2));
for (const row of rows) {
  const exact = JSON.stringify(row.predicted.map(({ start, end }: any) => [start, end]))
    === JSON.stringify(row.gold.map(({ start, end }: any) => [start, end]));
  console.log(`${exact ? 'EXACT' : 'diff '} ${row.document_id} ${row.citation} status=${row.status} gold=${JSON.stringify(row.gold.map(({ start, end }: any) => `${start}-${end}`))} det=${JSON.stringify(row.predicted.map(({ start, end }: any) => `${start}-${end}`))}\n        refusals=${JSON.stringify(row.refusals)}`);
}
console.log('status counts', rows.reduce((acc: any, r: any) => (acc[r.status] = (acc[r.status] ?? 0) + 1, acc), {}));
