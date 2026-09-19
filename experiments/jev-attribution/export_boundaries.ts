// Offline only: existing source reader, line units and mechanical comparator. No runner or model adapter.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fetchLocalA2AJDocumentsByIds } from '../../backend/src/lib/a2ajLocalBulk';
import { modelSourceLines } from '../../backend/experiments/a2aj-decision-roster/caseTargetMvpReduced';
import { compareDecisionStructure } from '../../backend/experiments/a2aj-decision-roster/caseDecisionBenchmark';

const base = path.resolve('experiments/jev-attribution/receipts');
mkdirSync(base, { recursive: true });
if (process.argv.includes('--score')) {
  const packets = JSON.parse(readFileSync(path.join(base, 'boundaries.json'), 'utf8'));
  const runs = readFileSync(path.join(base, 'boundaries-live.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const scores = packets.map((packet: any) => {
    const run = runs.find((r: any) => r.document_id === packet.document_id && r.stage === 'boundaries' && r.response);
    if (!run) return { document_id: packet.document_id, error: 'no boundary response' };
    // Placeholder non-boundary fields are deliberately NOT scored or reported.
    const opinions = Array.from({ length: run.opinion_count }, (_, i) => ({
      boundary: { start_line: Number(run.response.answers[`start_${i + 1}`].choice.replace('L', '')), end_line: Number(run.response.answers[`end_${i + 1}`].choice.replace('L', '')) },
      authorship: { kind: 'unstated' }, result_position: 'unclear', result_evidence: null, full_joiners: [],
    }));
    const candidate: any = { disposition_evidence: [], opinions, other_panel_members: [], nonparticipants: [] };
    const comparison = compareDecisionStructure(packet.gold, candidate);
    return { document_id: packet.document_id, citation: packet.citation, cohort: packet.cohort,
      exact: comparison.categories.opinion_boundaries_exact,
      metrics: Object.fromEntries(Object.entries(comparison.metrics).filter(([k]) => /opinions|boundaries|starts|ends/.test(k))),
      expected: packet.gold.opinions.map((o: any) => o.boundary), predicted: opinions.map(o => o.boundary) };
  });
  writeFileSync(path.join(base, 'boundary-scores.json'), JSON.stringify(scores, null, 2));
  console.log(JSON.stringify(scores, null, 2));
} else {
  const old = JSON.parse(readFileSync('experiments/a2aj_decision_roster_qwen/manual-case-decision-gold-v1.json', 'utf8')).filter((r: any) => r.annotation.structure.opinions.length > 1);
  const fresh = readFileSync('experiments/a2aj_decision_roster_qwen/case-decision-gold-v2.jsonl', 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const rows = [...old.map((r: any) => ({ ...r, cohort: 'earlier-multi-opinion' })), ...fresh.map((r: any) => ({ ...r, cohort: 'fresh-v2' }))];
  const docs = fetchLocalA2AJDocumentsByIds({ ids: rows.map(r => r.document_id), maxChars: Number.MAX_SAFE_INTEGER });
  const packets = rows.map(r => {
    const doc = docs.get(r.document_id);
    if (!doc) throw new Error(`Missing source ${r.document_id}`);
    return { document_id: r.document_id, citation: doc.citation, cohort: r.cohort,
      source_sha256: createHash('sha256').update(doc.text).digest('hex'),
      lines: modelSourceLines(doc.text).map(line => ({ ...line, text: doc.text.slice(line.start, line.end) })), gold: r.annotation.structure };
  });
  writeFileSync(path.join(base, 'boundaries.json'), JSON.stringify(packets, null, 2));
  console.log(JSON.stringify(packets.map(p => ({ document_id: p.document_id, lines: p.lines.length, cohort: p.cohort }))));
}
