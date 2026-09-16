import { check, hash, validateGold, columnOptions } from './contract.mjs';

export const mean = values => { const valid = values.filter(Number.isFinite); return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null; };
export const quantile = (values, p) => { const v = values.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.ceil((v.length - 1) * p)] : null; };
const ratio = (a, b) => b ? a / b : null;
const distribution = answer => { const sum = Object.values(answer.probabilities).reduce((a, b) => a + b, 0); return Object.fromEntries(Object.entries(answer.probabilities).map(([k, p]) => [k, p / sum])); };
const matchSet = (a, b) => a.length === b.length && a.every(id => b.includes(id));
const dcg = grades => grades.slice(0, 10).reduce((sum, grade, i) => sum + (2 ** grade - 1) / Math.log2(i + 2), 0);

export function ranking(order, candidateIds, gold) {
  const useful = Object.keys(gold.grades).filter(id => gold.grades[id] >= 2);
  const inPool = useful.filter(id => candidateIds.includes(id));
  const ideal = dcg(candidateIds.map(id => gold.grades[id]).sort((a, b) => b - a));
  const first = order.findIndex(id => gold.grades[id] >= 2);
  return { ndcg10: ideal ? dcg(order.map(id => gold.grades[id])) / ideal : null,
    mrr: inPool.length ? first < 0 ? 0 : 1 / (first + 1) : null,
    recall10: ratio(order.slice(0, 10).filter(id => gold.grades[id] >= 2).length, useful.length),
    candidate_recall: ratio(inPool.length, useful.length),
    adverse_recall10: ratio(order.slice(0, 10).filter(id => gold.adverse_ids.includes(id)).length, gold.adverse_ids.length),
    pool_answerable: inPool.length > 0 };
}

export function observationRows(run, goldRecords, evidenceThreshold = 0.5) {
  check(Number.isFinite(evidenceThreshold) && evidenceThreshold >= 0 && evidenceThreshold <= 1, 'Invalid evidence threshold');
  const gold = validateGold(run.plan, goldRecords), rows = [], callsByTrial = new Map();
  for (const call of run.plan.calls) {
    const key = JSON.stringify([call.item_id, call.repeat]);
    callsByTrial.set(key, [...callsByTrial.get(key) ?? [], call]);
  }
  for (const item of run.plan.items) for (let repeat = 0; repeat < run.plan.config.repeats; repeat++) {
    const calls = callsByTrial.get(JSON.stringify([item.id, repeat])) ?? [];
    const receipts = calls.map(call => run.receipts.get(call.id));
    const ok = receipts.length > 0 && receipts.every(receipt => receipt?.status === 'ok');
    const answers = Object.assign({}, ...receipts.filter(r => r?.status === 'ok').map(r => r.response.answers));
    const complete = ok && Object.keys(item.questions).every(key => Object.hasOwn(answers, key));
    const truth = gold.get(item.id);
    const base = { item_id: item.id, repeat, group: item.group, task: item.task, split: item.split, slice: item.slice,
      adjudication: truth.adjudication, completed: complete, source_keys: item.source_keys,
      failures: receipts.filter(r => r?.status !== 'ok').map(r => r?.error ?? r?.status ?? 'not_run') };
    if (item.task === 'verify') {
      const probabilities = complete ? distribution(answers.relationship) : null;
      const predicted = complete ? answers.relationship.choice : null;
      const safe = truth.label === 'supported', probability = probabilities?.supported ?? null;
      rows.push({ ...base, id: JSON.stringify([item.id, repeat]), expected: truth.label, predicted, probabilities,
        quality: Number(complete && predicted === truth.label), eligible: predicted === 'supported', error: !safe,
        gate: complete ? Math.min(probability, answers.attribution?.noul ?? 1, answers.qualifications?.noul ?? 1) : null,
        vendor_confidence: answers.relationship?.confidence ?? null, probability, target: Number(safe),
        material_error_detected: !safe ? Number(complete && predicted !== 'supported') : null,
        valid_claim_passed: safe ? Number(complete && predicted === 'supported') : null,
        calibration_kind: 'binary_supported' });
    } else if (item.task === 'tabular') {
      item.state.columns.forEach((column, i) => {
        const expected = truth.cells.find(cell => cell.column_id === column.id);
        const probabilities = complete ? distribution(answers[`c${i}`]) : null;
        let predicted = complete ? answers[`c${i}`].choice : null, gate = complete ? probabilities[predicted] : null;
        const noul = run.plan.config.tabularMode === 'noul' && column.format === 'yes_no';
        if (complete && noul) {
          const yes = answers[`yes${i}`].noul, no = answers[`no${i}`].noul;
          predicted = yes >= 0.5 && no < 0.5 ? 'yes' : no >= 0.5 && yes < 0.5 ? 'no'
            : yes >= 0.5 && no >= 0.5 ? 'ambiguous' : ['not_found', 'ambiguous'].includes(predicted) ? predicted : 'ambiguous';
          gate = predicted === 'yes' ? Math.min(yes, 1 - no) : predicted === 'no' ? Math.min(no, 1 - yes) : probabilities[predicted];
        }
        const evidence = complete ? item.state.passages.filter((_, p) => answers[`e${i}_${p}`].noul >= evidenceThreshold).map(p => p.evidence_id) : [];
        const valid = complete && (predicted === 'not_found' ? item.state.scope_complete && !evidence.length
          : predicted === 'ambiguous' || evidence.length > 0);
        const valueCorrect = Number(complete && predicted === expected.choice);
        const evidenceCorrect = complete && expected.evidence_sets.some(set => matchSet(set, evidence));
        const correct = Number(valid && valueCorrect && evidenceCorrect);
        rows.push({ ...base, id: JSON.stringify([item.id, repeat, column.id]), column_id: column.id,
          expected: expected.choice, predicted, probabilities, evidence_ids: evidence, evidence_correct: Number(evidenceCorrect),
          value_correct: valueCorrect, quality: correct, contract_valid: Boolean(valid),
          value: predicted === 'yes' ? true : predicted === 'no' ? false : ['ambiguous', 'not_found', null].includes(predicted) ? null : predicted,
          eligible: valid && predicted !== 'ambiguous', error: !correct, gate,
          false_no: Number(predicted === 'no' && expected.choice !== 'no'),
          false_not_found: Number(predicted === 'not_found' && expected.choice !== 'not_found'),
          probability: complete ? noul ? answers[`yes${i}`].noul : probabilities[expected.choice] : null,
          target: noul ? Number(expected.choice === 'yes') : 1,
          // Multiclass Brier uses every option; do not calibrate "probability of gold" as a binary forecast.
          multiclass_brier: complete && !noul ? Object.keys(columnOptions(column)).reduce((n, key) => n + (probabilities[key] - Number(key === expected.choice)) ** 2, 0) : null,
          calibration_kind: noul ? 'binary_yes' : 'multiclass_choice', vendor_confidence: answers[`c${i}`]?.confidence ?? null });
      });
    } else {
      const scores = complete ? item.state.passages.map((p, i) => ({ id: p.evidence_id,
        score: run.plan.config.rankMode === 'choice' ? answers.rank.probabilities[`p${i}`]
          : run.plan.config.rankMode === 'noul' ? answers[`p${i}`].noul : answers[`p${i}`].score })) : [];
      scores.sort((a, b) => b.score - a.score || item.original_order.indexOf(a.id) - item.original_order.indexOf(b.id));
      const order = scores.map(p => p.id), measured = ranking(order, item.original_order, truth);
      const original = ranking(item.original_order, item.original_order, truth);
      const any = complete ? answers.any.noul : null;
      rows.push({ ...base, id: JSON.stringify([item.id, repeat]), order, scores, ...measured,
        quality: measured.ndcg10, original_ndcg10: original.ndcg10, original_recall10: original.recall10,
        original_adverse_recall10: original.adverse_recall10, probability: any, target: Number(measured.pool_answerable),
        answerability_correct: Number(complete && (any >= 0.5) === measured.pool_answerable),
        false_pool_answer: !measured.pool_answerable ? Number(complete && any >= 0.5) : null,
        calibration_kind: 'binary_pool_answerable' });
    }
  }
  return rows;
}

// Upper Wilson bound for *groups with any accepted error*, not an independence claim about cells.
export function groupRiskUpper(errors, n) {
  if (!n) return null;
  const z = 1.959963984540054, p = errors / n;
  return (p + z * z / (2 * n) + z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n);
}
export function riskAt(rows, threshold) {
  const accepted = rows.filter(row => row.eligible && Number.isFinite(row.gate) && row.gate >= threshold);
  const groups = new Map();
  for (const row of accepted) groups.set(row.group, Boolean(groups.get(row.group) || row.error));
  const errors = accepted.filter(row => row.error).length;
  return { threshold, accepted: accepted.length, accepted_groups: groups.size, errors,
    coverage: ratio(accepted.length, rows.length), risk: ratio(errors, accepted.length),
    group_any_error_upper95: groupRiskUpper([...groups.values()].filter(Boolean).length, groups.size) };
}
export function calibration(rows) {
  const valid = rows.filter(row => row.completed && Number.isFinite(row.probability));
  const binary = valid.filter(row => row.calibration_kind.startsWith('binary_'));
  return { scored: valid.length, missing: rows.length - valid.length,
    binary_brier: mean(binary.map(row => (row.probability - row.target) ** 2)),
    binary_log_loss: mean(binary.map(row => -Math.log(Math.max(1e-15, row.target ? row.probability : 1 - row.probability)))),
    multiclass_brier: mean(valid.map(row => row.multiclass_brier)),
    reliability: Array.from({ length: 10 }, (_, i) => {
      const bin = binary.filter(row => Math.min(9, Math.floor(row.probability * 10)) === i);
      return { lower: i / 10, upper: (i + 1) / 10, n: bin.length, predicted: mean(bin.map(r => r.probability)), observed: mean(bin.map(r => r.target)) };
    }) };
}
export const THRESHOLDS = [0, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.975, 0.99, 0.995, 1];
export function summarize(run, goldRecords, evidenceThreshold = 0.5) {
  const rows = observationRows(run, goldRecords, evidenceThreshold), groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.task, row.split, row.slice, row.adjudication]);
    groups.set(key, [...groups.get(key) ?? [], row]);
  }
  const receipts = [...run.receipts.values()], attempted = receipts.filter(r => r.attempted);
  const usages = attempted.map(r => r.response?.usage ?? r.usage);
  const unknownUsage = usages.filter(u => !u || !Number.isFinite(u.input_tokens) || !Number.isFinite(u.output_tokens)).length;
  return { version: run.plan.version, plan_sha256: hash(run.plan), gold_sha256: hash(goldRecords),
    warning: 'Offline decision benchmark only. Synthetic/model-draft gold, fixture outputs and microbenchmarks do not establish legal/product quality. No automatic promotion.',
    probability_source: run.plan.config.provider === 'jev' ? 'native_distribution' : run.plan.config.provider === 'beaver' ? 'elicited_estimate' : 'protocol_fixture',
    evidence_threshold: evidenceThreshold, requested_model: run.plan.config.model,
    reported_models: [...new Set(receipts.flatMap(r => r.reported_model ? [r.reported_model] : []))],
    accounting: { planned_calls: run.plan.calls.length, attempted_calls: attempted.length, successful_calls: receipts.filter(r => r.status === 'ok').length,
      pending_calls: run.plan.calls.length - receipts.length, unknown_usage_calls: unknownUsage,
      known_input_tokens: usages.reduce((n, u) => n + (u?.input_tokens ?? 0), 0), known_output_tokens: usages.reduce((n, u) => n + (u?.output_tokens ?? 0), 0),
      summed_request_ms: attempted.reduce((n, r) => n + (r.elapsed_ms ?? 0), 0),
      request_p50_ms: quantile(attempted.map(r => r.elapsed_ms), 0.5), request_p95_ms: quantile(attempted.map(r => r.elapsed_ms), 0.95),
      completed_session_wall_ms: run.sessions.filter(s => s.status !== 'started').reduce((n, s) => n + s.elapsed_ms, 0),
      interrupted_sessions: run.sessions.filter(s => s.status === 'started').length,
      monetary_cost: null, cost_note: 'Apply current account pricing externally; missing usage is unknown, never free. Session and request times are not full-product row latency.' },
    strata: [...groups.entries()].map(([key, subset]) => ({ stratum: JSON.parse(key), n: subset.length, independent_groups: new Set(subset.map(r => r.group)).size,
      completed: subset.filter(r => r.completed).length, quality: mean(subset.map(r => r.quality)),
      quality_n: subset.filter(r => Number.isFinite(r.quality)).length,
      quality_metric: subset[0].task === 'verify' ? 'relationship_accuracy' : subset[0].task === 'tabular' ? 'value_and_exact_evidence_accuracy' : 'ndcg10_candidate_conditional',
      metrics: Object.fromEntries(['value_correct', 'evidence_correct', 'false_no', 'false_not_found', 'material_error_detected', 'valid_claim_passed',
        'mrr', 'recall10', 'candidate_recall', 'adverse_recall10', 'original_ndcg10', 'original_recall10', 'answerability_correct', 'false_pool_answer'].map(key => [key, mean(subset.map(r => r[key]))])),
      confusion: subset[0].task === 'rerank' ? null : subset.reduce((counts, r) => {
        const key = JSON.stringify([r.expected, r.predicted ?? '(failed)']); counts[key] = (counts[key] ?? 0) + 1; return counts;
      }, {}), calibration: calibration(subset), risk_coverage: subset[0].task === 'rerank' ? [] : THRESHOLDS.map(t => riskAt(subset, t)) })), rows };
}

export function policySignature(plan, evidenceThreshold) {
  const { repeats: _, ...config } = plan.config;
  return hash([plan.version, config, plan.code_sha256, evidenceThreshold]);
}
export function fitPolicy(run, report, task, { maxRisk = 0.01, minGroups = 20 } = {}) {
  check(['verify', 'tabular'].includes(task), 'Fit applies only to verify/tabular');
  check(Number.isFinite(maxRisk) && maxRisk >= 0 && maxRisk <= 1 && Number.isSafeInteger(minGroups) && minGroups > 0, 'Invalid calibration bounds');
  const rows = report.rows.filter(r => r.task === task && r.split === 'calibration');
  check(rows.length > 0 && rows.every(r => r.adjudication === 'human'), 'Fit requires human-adjudicated calibration rows; never test or synthetic gold');
  const chosen = THRESHOLDS.map(t => riskAt(rows, t)).filter(r => r.accepted_groups >= minGroups && r.group_any_error_upper95 <= maxRisk)
    .sort((a, b) => b.accepted - a.accepted || b.threshold - a.threshold)[0];
  return { task, enabled: Boolean(chosen), threshold: chosen?.threshold ?? null,
    reason: chosen ? 'calibration_bound_met' : 'insufficient_calibration_evidence', max_risk: maxRisk, min_groups: minGroups,
    configuration_sha256: policySignature(run.plan, report.evidence_threshold), calibration_gold_sha256: report.gold_sha256,
    groups: [...new Set(rows.map(r => r.group))], source_keys: [...new Set(rows.flatMap(r => r.source_keys))], calibration: chosen ?? null };
}
export function applyPolicy(run, report, policy) {
  check(policy.configuration_sha256 === policySignature(run.plan, report.evidence_threshold), 'Policy/configuration mismatch');
  check(['verify', 'tabular'].includes(policy.task) && typeof policy.enabled === 'boolean'
    && (!policy.enabled || Number.isFinite(policy.threshold) && policy.threshold >= 0 && policy.threshold <= 1), 'Invalid policy');
  const rows = report.rows.filter(r => r.task === policy.task && r.split === 'test');
  check(rows.length > 0 && rows.every(r => !policy.groups.includes(r.group) && !r.source_keys.some(key => policy.source_keys.includes(key))), 'No independent test rows or calibration overlap');
  return policy.enabled ? riskAt(rows, policy.threshold) : { accepted: 0, coverage: 0, risk: null, reason: policy.reason };
}

/** Paired bootstrap resamples document/topic groups, retaining all correlated cells/repeats. */
export function compareReports(left, right, { task, split = 'test', metric = 'quality', samples = 2000 } = {}) {
  check(left.gold_sha256 === right.gold_sha256, 'Comparisons require the same frozen gold');
  check(['verify', 'tabular', 'rerank'].includes(task) && ['development', 'calibration', 'test'].includes(split), 'Select task and split');
  check(['quality', 'value_correct', 'answerability_correct', 'recall10', 'adverse_recall10'].includes(metric), 'Unsupported comparison metric');
  check(Number.isSafeInteger(samples) && samples >= 100 && samples <= 10_000, 'Invalid bootstrap sample count');
  const a = left.rows.filter(r => r.task === task && r.split === split), b = right.rows.filter(r => r.task === task && r.split === split);
  check(a.length > 0 && a.length === b.length, 'Unequal comparison observations');
  const byId = new Map(b.map(row => [row.id, row])), groups = new Map();
  for (const row of a) {
    const other = byId.get(row.id);
    check(other && other.group === row.group && JSON.stringify(other.source_keys) === JSON.stringify(row.source_keys), 'Unpaired observation');
    check(Number.isFinite(row[metric]) === Number.isFinite(other[metric]), 'Metric denominator changed');
    if (!Number.isFinite(row[metric])) continue;
    groups.set(row.group, [...groups.get(row.group) ?? [], other[metric] - row[metric]]);
  }
  const values = [...groups.values()];
  check(values.length > 0, 'No comparable observations');
  let seed = 12345;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const boot = Array.from({ length: samples }, () => {
    let n = 0, total = 0;
    for (let i = 0; i < values.length; i++) for (const delta of values[Math.floor(random() * values.length)]) { total += delta; n++; }
    return total / n;
  });
  return { task, split, metric, paired_groups: values.length, observations: values.flat().length,
    delta_right_minus_left: mean(values.flat()), ci95: values.length >= 2 ? [quantile(boot, 0.025), quantile(boot, 0.975)] : null,
    seed: 12345, bootstrap_samples: samples, warning: 'Exploratory paired interval; not a multiple-comparison correction or production promotion gate.' };
}
