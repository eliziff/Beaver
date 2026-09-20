import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hash, payload } from './contract.mjs';

/** Invented texts exercise the protocol; they are not legal authorities or quality gold. */
export function fixtures() {
  const cases = [], gold = [];
  function add(id, task, texts, rest, expected) {
    const sources = texts.map((text, i) => ({ source_id: `synthetic:${id}:${i}`, version: '1', sha256: hash(text), text }));
    const passages = sources.map((source, i) => ({ evidence_id: `${id}:e${i}`, stable_source_id: source.source_id,
      version: source.version, source_sha256: source.sha256, span: { start: 0, end: source.text.length },
      span_text: source.text, locator: `paragraph ${i + 1}`, name: 'Invented protocol fixture' }));
    const input = { sources, passages, ...rest };
    if (task === 'verify') input.cited_evidence_ids = [passages[0].evidence_id];
    const row = { id, task, group: id, split: 'test', slice: 'synthetic-protocol', privacy: 'synthetic', input };
    cases.push(row);
    gold.push({ id, input_sha256: hash(input), adjudication: 'synthetic', ...expected(passages) });
  }
  for (const [id, text, claim, label] of [
    ['supported', 'The panel held that notice is required unless the supplier waives it.', 'The panel held that notice is required unless the supplier waives it.', 'supported'],
    ['qualified', 'Notice is required unless the supplier waives it.', 'Notice is always required.', 'overstated_or_qualified'],
    ['attribution', 'The dissent would allow the appeal. The majority dismissed the appeal.', 'The majority allowed the appeal.', 'contradicted'],
    ['unaddressed', 'Costs were fixed at CAD 500.', 'The court imposed a notice requirement.', 'unaddressed'],
    ['context', 'For those reasons, the exception applies.', 'The exception applies to every supply agreement.', 'insufficient_context'],
  ]) add(`v-${id}`, 'verify', [text], { claim }, () => ({ label }));
  add('t-complete', 'tabular', ['This agreement renews automatically each year.', 'Assignment is prohibited.'],
    { scope_complete: true, columns: [
      { id: 'renewal', prompt: 'Does the agreement renew automatically?', format: 'yes_no' },
      { id: 'assignment', prompt: 'Does the agreement permit assignment?', format: 'yes_no' },
      { id: 'notice', prompt: 'Does the agreement require written termination notice?', format: 'yes_no' },
    ] }, p => ({ cells: [
      { column_id: 'renewal', choice: 'yes', evidence_sets: [[p[0].evidence_id]] },
      { column_id: 'assignment', choice: 'no', evidence_sets: [[p[1].evidence_id]] },
      { column_id: 'notice', choice: 'not_found', evidence_sets: [[]] },
    ] }));
  add('t-partial', 'tabular', ['Page one identifies the parties; the remaining terms are not supplied.'],
    { scope_complete: false, columns: [{ id: 'renewal', prompt: 'How does the agreement renew?', format: 'tag', options: { automatic: 'Automatic annual renewal', written: 'Renewal by written agreement' } }] },
    () => ({ cells: [{ column_id: 'renewal', choice: 'ambiguous', evidence_sets: [[]] }] }));
  add('r-adverse', 'rerank', ['The parties disputed costs.', 'Automatic renewal is ineffective unless notice of renewal is delivered.', 'Renewal clauses appeared in many supply agreements.'],
    { query: 'Is an automatic renewal clause effective without notice?' }, p => ({ grades: { [p[0].evidence_id]: 0, [p[1].evidence_id]: 3, [p[2].evidence_id]: 1, 'outside-pool': 2 }, adverse_ids: [p[1].evidence_id] }));
  add('r-none', 'rerank', ['The schedule lists office opening hours.', 'The invoice is payable in Canadian dollars.'],
    { query: 'What notice is required to renew the agreement?' }, p => ({ grades: Object.fromEntries(p.map(p => [p.evidence_id, 0])), adverse_ids: [] }));
  return { cases, gold };
}

export async function writeFixtures(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const data = fixtures();
  for (const task of ['all', 'verify', 'tabular', 'rerank']) {
    const cases = data.cases.filter(row => task === 'all' || row.task === task), ids = new Set(cases.map(c => c.id));
    for (const [suffix, rows] of [['input', cases], ['gold', data.gold.filter(row => ids.has(row.id))]])
      await writeFile(join(directory, `${task}.${suffix}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  }
  return data;
}

/** Gold-derived oracle ONLY for labelled offline protocol/scorer checks; never a model benchmark. */
export function protocolFixture(plan, records) {
  const byRequest = new Map();
  for (const call of plan.calls) {
    const request = payload(plan, call), item = plan.items.find(item => item.id === call.item_id), gold = records.find(g => g.id === item.id);
    const answers = {};
    for (const [id, q] of Object.entries(request.questions)) {
      let choice, yes;
      if (item.task === 'verify') { choice = gold.label; yes = gold.label === 'supported'; }
      else if (item.task === 'tabular') {
        const index = Number(id.match(/\d+/u)[0]), cell = gold.cells.find(c => c.column_id === item.state.columns[index].id);
        choice = cell.choice;
        if (id.startsWith('yes')) yes = choice === 'yes';
        else if (id.startsWith('no')) yes = choice === 'no';
        else if (id.startsWith('e')) yes = cell.evidence_sets[0].includes(item.state.passages[Number(id.split('_')[1])].evidence_id);
      } else {
        const grades = item.state.passages.map(p => gold.grades[p.evidence_id]);
        if (id === 'any') yes = grades.some(g => g >= 2);
        else if (id === 'rank') choice = grades.some(g => g >= 2) ? `p${grades.indexOf(Math.max(...grades))}` : 'none';
        else { choice = String(grades[Number(id.slice(1))]); yes = Number(choice) >= 2; }
      }
      if (q.type === 'noul') answers[id] = { type: 'noul', noul: Number(yes) };
      else {
        const options = q.type === 'choice' ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
        answers[id] = { type: q.type, confidence: 1, probabilities: Object.fromEntries(options.map(key => [key, Number(key === choice)])),
          ...(q.type === 'choice' ? { choice } : { score: Number(choice), legend: Object.fromEntries(q.criteria.map((value, i) => [String(i), value])) }) };
      }
    }
    byRequest.set(hash(request), { model: 'protocol-fixture', answers, usage: { input_tokens: 0, output_tokens: 0 } });
  }
  return async request => {
    const response = byRequest.get(hash(request));
    if (!response) throw new Error('Fixture request mismatch');
    return { response, raw: JSON.stringify(response), reported_model: 'protocol-fixture' };
  };
}
