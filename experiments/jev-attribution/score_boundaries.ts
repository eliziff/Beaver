// Offline mechanical scoring only: existing line units and the existing
// case-decision comparator. No model adapter, no Codex, no benchmark mutation.
import { readFileSync, writeFileSync } from 'node:fs';
import { compareDecisionStructure } from '../../backend/experiments/a2aj-decision-roster/caseDecisionBenchmark';

const base = 'experiments/jev-attribution/receipts/';
const tag = process.argv[2] ?? 'run1';
const predictions = JSON.parse(readFileSync(base + `boundary-predictions-${tag}.json`, 'utf8'));
const rows = predictions.filter((p: any) => p.predicted).map((p: any) => {
  const opinions = p.predicted.map((o: any) => ({
    boundary: { start_line: o.start, end_line: o.end },
    authorship: { kind: 'unstated' as const }, result_position: 'unclear' as const,
    result_evidence: null, full_joiners: [],
  }));
  const candidate: any = { disposition_evidence: [], opinions, other_panel_members: [], nonparticipants: [] };
  const gold: any = { disposition_evidence: [], opinions: p.gold.map((b: any) => ({
    boundary: { start_line: b.start, end_line: b.end },
    authorship: { kind: 'unstated' as const }, result_position: 'unclear' as const,
    result_evidence: null, full_joiners: [],
  })), other_panel_members: [], nonparticipants: [] };
  const c = compareDecisionStructure(gold, candidate);
  return { document_id: p.document_id, citation: p.citation, cohort: p.cohort,
    gold_opinions: p.gold.length, predicted_opinions: opinions.length,
    count_reported: p.opinion_count_answer,
    exact_boundaries: c.categories.opinion_boundaries_exact,
    exact_starts: c.metrics.exact_starts, exact_ends: c.metrics.exact_ends,
    matched: c.metrics.matched_opinions,
    gold: p.gold.map((b: any) => `${b.start}-${b.end}`),
    predicted: p.predicted.map((o: any) => `${o.start}-${o.end}`) };
});

const totalGold = rows.reduce((n: number, r: any) => n + r.gold_opinions, 0);
const summary = {
  documents: rows.length,
  exact_boundary_documents: rows.filter((r: any) => r.exact_boundaries).length,
  gold_opinions: totalGold,
  exact_start: rows.reduce((n: number, r: any) => n + r.exact_starts, 0),
  exact_end: rows.reduce((n: number, r: any) => n + r.exact_ends, 0),
  exact_both: rows.reduce((n: number, r: any) => n + (r.exact_boundaries ? r.gold_opinions : 0), 0),
  by_cohort: ['earlier-multi-opinion', 'fresh-v2'].map(cohort => {
    const slice = rows.filter((r: any) => r.cohort === cohort);
    return { cohort, documents: slice.length,
      exact_boundary_documents: slice.filter((r: any) => r.exact_boundaries).length,
      gold_opinions: slice.reduce((n: number, r: any) => n + r.gold_opinions, 0),
      exact_both: slice.reduce((n: number, r: any) => n + (r.exact_boundaries ? r.gold_opinions : 0), 0) };
  }),
};
writeFileSync(base + `boundary-scores-${tag}.json`, JSON.stringify({ summary, rows }, null, 2));
console.log(JSON.stringify({ summary, rows }, null, 2));
