import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildPlan, hash, payload, validateCases, validateGold, validateResponse } from './contract.mjs';
import { config } from './cli.mjs';
import { fixtures, protocolFixture } from './fixtures.mjs';
import { jevTransport, beaverTransport } from './transport.mjs';
import { atomicJson, loadRun, runPlan } from './runner.mjs';
import { applyPolicy, compareReports, fitPolicy, groupRiskUpper, ranking, riskAt, summarize } from './metrics.mjs';

const data = fixtures();
const makePlan = values => buildPlan(structuredClone(data.cases), config({ provider: 'fixture', model: 'protocol-fixture', ...values }));
async function temporary(t) {
  const path = await mkdtemp(join(tmpdir(), 'beaver-jev-'));
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}
async function server(t, handler) {
  const http = createServer(handler);
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(async () => { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); });
  return `http://127.0.0.1:${http.address().port}/v1/systemone`;
}
async function requestJson(request) { const parts = []; for await (const part of request) parts.push(part); return JSON.parse(Buffer.concat(parts).toString('utf8')); }
const runFixture = (plan, directory, options = {}) => runPlan(plan, { directory, evaluate: protocolFixture(plan, data.gold), maxCalls: plan.calls.length, ...options });

test('frozen source identities, exact spans, closed inputs and split boundaries fail closed', () => {
  for (const mutate of [
    rows => { rows[0].input.passages[0].span_text += ' altered'; },
    rows => { rows[0].input.sources[0].sha256 = '0'.repeat(64); },
    rows => { rows[0].input.passages[0].version = '2'; },
    rows => { rows[0].input.cited_evidence_ids = ['foreign']; },
    rows => { rows[0].input.expected = 'gold'; },
    rows => { rows[0].input.passages[0].expected_label = 'gold'; },
    rows => { rows[1].group = rows[0].group; rows[1].split = 'calibration'; },
    rows => { rows[1] = { ...structuredClone(rows[0]), id: 'another', group: 'another', split: 'development' }; },
    rows => { rows[1].id = rows[0].id; },
  ]) {
    const changed = structuredClone(data.cases); mutate(changed);
    assert.throws(() => validateCases(changed));
  }
  assert.equal(validateCases(data.cases).length, 9);
  const plan = makePlan(), changed = structuredClone(data.gold);
  changed[0].input_sha256 = '0'.repeat(64);
  assert.throws(() => validateGold(plan, changed), /hash mismatch/);
  assert.throws(() => validateGold(plan, [...data.gold, data.gold[0]]));
});

test('batched questions identify targets in instructions, never leak gold or metadata, never truncate', () => {
  const rows = structuredClone(data.cases); rows[0].slice = 'DO_NOT_SEND_GOLD';
  const plan = buildPlan(rows, config({ model: 'jev-latest', 'verify-mode': 'decomposed', 'batch-size': '2', 'max-bytes': '256' }));
  assert.ok(plan.calls.length > plan.items.length);
  for (const call of plan.calls) {
    const body = payload(plan, call);
    assert.ok(!JSON.stringify(body).includes('DO_NOT_SEND_GOLD'));
    assert.ok(Object.keys(body.questions).length <= 2);
    assert.equal(call.refusal, 'request_too_large');
    assert.equal(hash(body), call.request_sha256);
    assert.ok(body.state.passages[0].span_text.length > 0);
  }
  const tabular = plan.items.find(item => item.task === 'tabular');
  assert.match(tabular.questions.c1.instructions, /columns\[1\]\.prompt/);
  assert.match(tabular.questions.e1_0.instructions, /passages\[0\]/);
  assert.deepEqual(tabular.state.columns[0].format, 'yes_no');
});

test('typed responses reject missing answers, malformed probabilities and inconsistent scores', async () => {
  const plan = makePlan(), fixture = protocolFixture(plan, data.gold);
  for (const call of plan.calls) {
    const request = payload(plan, call), result = await fixture(request);
    assert.equal(validateResponse(result.response, request), result.response);
    const bad = structuredClone(result.response); delete bad.answers[call.question_ids[0]];
    assert.throws(() => validateResponse(bad, request), /answers/);
  }
  const call = plan.calls[0], request = payload(plan, call), original = (await fixture(request)).response;
  const bad = structuredClone(original); bad.answers.relationship.probabilities.supported = -0.1;
  assert.throws(() => validateResponse(bad, request), /distribution/);
  bad.answers.relationship.probabilities.supported = 0.1;
  assert.throws(() => validateResponse(bad, request), /mass/);
  const rankCall = plan.calls.find(c => c.item_id === 'r-adverse'), rankRequest = payload(plan, rankCall);
  const rank = structuredClone((await fixture(rankRequest)).response); rank.answers.p0.score = 2;
  assert.throws(() => validateResponse(rank, rankRequest), /Score/);
  rank.answers.p0.score = 0; rank.answers.any.noul = 2;
  assert.throws(() => validateResponse(rank, rankRequest), /Noul/);
});

test('all three tasks traverse real loopback HTTP, retain raw responses and score exact evidence', async t => {
  const plan = makePlan({ 'verify-mode': 'decomposed', repeats: '2', order: 'reverse' }), fixture = protocolFixture(plan, data.gold);
  let requests = 0;
  const endpoint = await server(t, async (request, response) => {
    requests++; assert.equal(request.headers.authorization, undefined);
    const result = await fixture(await requestJson(request)); response.setHeader('x-request-id', `fixture-${requests}`);
    response.end(result.raw);
  });
  const run = await runPlan(plan, { directory: await temporary(t), evaluate: jevTransport({ endpoint }), maxCalls: plan.calls.length, workers: 3 });
  const report = summarize(run, data.gold);
  assert.equal(requests, 18); assert.equal(report.rows.length, 22);
  assert.ok(report.rows.every(row => row.completed));
  assert.ok(report.rows.filter(r => r.task !== 'rerank').every(r => r.quality === 1));
  const rank = report.rows.find(r => r.item_id === 'r-adverse');
  assert.equal(rank.order[0], 'r-adverse:e1'); assert.equal(rank.candidate_recall, 0.5);
  assert.equal(rank.adverse_recall10, 1); assert.ok(rank.ndcg10 > rank.original_ndcg10);
  assert.equal(report.rows.find(r => r.item_id === 'r-none').answerability_correct, 1);
  assert.ok([...run.receipts.values()].every(r => r.raw && r.request_id));
  assert.equal(report.accounting.unknown_usage_calls, 0);
});

test('budgets and resume never reissue terminal or uncertain remote calls', async t => {
  const plan = makePlan(), directory = await temporary(t); let calls = 0;
  const fixture = protocolFixture(plan, data.gold), evaluate = async (...args) => { calls++; return fixture(...args); };
  let run = await runPlan(plan, { directory, evaluate, maxCalls: 2, workers: 3 });
  assert.equal(calls, 2); assert.equal(run.receipts.size, 2);
  let report = summarize(run, data.gold);
  assert.equal(report.accounting.pending_calls, 7);
  assert.equal(report.rows.filter(r => !r.completed).length, 9);
  const uncertain = plan.calls[2];
  await atomicJson(join(directory, 'receipts', `${uncertain.id}.json`), {
    call_id: uncertain.id, request_sha256: uncertain.request_sha256, status: 'started', attempted: true,
  });
  run = await runPlan(plan, { directory, evaluate, maxCalls: 20, workers: 2 });
  assert.equal(calls, 8); assert.equal(run.receipts.get(uncertain.id).status, 'interrupted');
  report = summarize(run, data.gold);
  assert.equal(report.accounting.unknown_usage_calls, 1);
  assert.equal(report.rows.find(r => r.item_id === uncertain.item_id).quality, 0);
  await runPlan(plan, { directory, evaluate, maxCalls: 20 }); assert.equal(calls, 8);
  await assert.rejects(runPlan(makePlan({ order: 'reverse' }), { directory, evaluate, maxCalls: 1 }), /changed corpus/);
  await writeFile(join(directory, '.lock'), 'another writer');
  await assert.rejects(runPlan(plan, { directory, evaluate, maxCalls: 1 }), /locked/);
});

test('HTTP failures do not retry, retain raw diagnostics, and stay in score denominators', async t => {
  let requests = 0;
  const endpoint = await server(t, async (request, response) => {
    await requestJson(request); requests++;
    response.statusCode = requests === 1 ? 429 : 200;
    response.end(requests === 1 ? '{"error":"rate limited"}' : '{"model":"jev-fixture","answers":{},"usage":{"input_tokens":23,"output_tokens":1}}');
  });
  const plan = makePlan(), directory = await temporary(t);
  const run = await runPlan(plan, { directory, evaluate: jevTransport({ endpoint }), maxCalls: 2 });
  const report = summarize(run, data.gold);
  assert.equal(requests, 2); assert.equal(report.accounting.successful_calls, 0);
  assert.equal(report.accounting.known_input_tokens, 23);
  assert.equal(report.accounting.unknown_usage_calls, 1);
  assert.ok(report.rows.every(r => !r.completed));
  assert.equal(run.receipts.get(plan.calls[0].id).error, 'http_429');
  assert.ok(run.receipts.get(plan.calls[1].id).raw.includes('jev-fixture'));
  assert.equal(report.strata.find(s => s.stratum[0] === 'verify').quality, 0);
  await runPlan(plan, { directory, evaluate: jevTransport({ endpoint }), maxCalls: 0 }); assert.equal(requests, 2);
});

test('timeout, pre-abort, byte refusal and credential routing prevent accidental work', async t => {
  let requests = 0;
  const endpoint = await server(t, async (request, response) => {
    await requestJson(request); requests++;
    setTimeout(() => response.end('{}'), 100);
  });
  const plan = makePlan();
  const run = await runPlan(plan, { directory: await temporary(t), evaluate: jevTransport({ endpoint }), maxCalls: 1, timeoutMs: 30 });
  assert.equal(run.receipts.get(plan.calls[0].id).error, 'aborted_or_timeout');
  assert.ok(requests <= 1);
  const small = makePlan({ 'max-bytes': '256' }); let evaluated = 0;
  const refused = await runPlan(small, { directory: await temporary(t), evaluate: async () => evaluated++, maxCalls: 100 });
  assert.equal(evaluated, 0); assert.equal(refused.receipts.size, small.calls.length);
  const controller = new AbortController(); controller.abort();
  const aborted = await runPlan(plan, { directory: await temporary(t), evaluate: async () => evaluated++, maxCalls: 100, signal: controller.signal });
  assert.equal(evaluated, 0); assert.equal(aborted.receipts.size, 0);
  assert.throws(() => jevTransport({ endpoint, apiKey: 'never-send-this' }), /must not receive/);
  assert.throws(() => jevTransport({ endpoint: 'https://example.org', apiKey: 'never-send-this' }), /Only TypeSafe/);
});

test('confident wrong evidence and partial-scope not_found cannot become correct grounded cells', async t => {
  const plan = makePlan(), run = await runFixture(plan, await temporary(t));
  const get = id => run.receipts.get(plan.calls.find(c => c.item_id === id).id).response.answers;
  const value = get('t-complete'); value.e0_0.noul = 0; value.e0_1.noul = 1;
  const partial = get('t-partial'); partial.c0.choice = 'not_found';
  partial.c0.probabilities = Object.fromEntries(Object.keys(partial.c0.probabilities).map(k => [k, Number(k === 'not_found')]));
  const verifier = get('v-qualified').relationship; verifier.choice = 'supported';
  verifier.probabilities = Object.fromEntries(Object.keys(verifier.probabilities).map(k => [k, Number(k === 'supported')]));
  const report = summarize(run, data.gold), wrongEvidence = report.rows.find(r => r.item_id === 't-complete' && r.column_id === 'renewal');
  assert.equal(wrongEvidence.value_correct, 1); assert.equal(wrongEvidence.quality, 0);
  assert.equal(report.rows.find(r => r.item_id === 't-partial').contract_valid, false);
  const risk = riskAt(report.rows.filter(r => r.task === 'verify'), 0.99);
  assert.equal(risk.accepted, 2); assert.equal(risk.risk, 0.5);
});

test('Noul ablation preserves No versus absence; shortlist Choice and Score share stable ranking metrics', async t => {
  for (const rankMode of ['score', 'noul', 'choice']) {
    const plan = makePlan({ 'tabular-mode': 'noul', 'rank-mode': rankMode, 'batch-size': '1' });
    const report = summarize(await runFixture(plan, await temporary(t), { workers: 4 }), data.gold);
    assert.equal(report.rows.find(r => r.item_id === 't-complete' && r.column_id === 'assignment').value, false);
    assert.equal(report.rows.find(r => r.item_id === 't-complete' && r.column_id === 'notice').predicted, 'not_found');
    assert.equal(report.rows.find(r => r.item_id === 'r-adverse').order[0], 'r-adverse:e1');
  }
  const result = ranking(['a', 'b'], ['a', 'b'], { grades: { a: 0, b: 3, missing: 2 }, adverse_ids: ['b', 'missing'] });
  assert.equal(result.ndcg10, 1 / Math.log2(3)); assert.equal(result.candidate_recall, 0.5);
  assert.equal(result.mrr, 0.5); assert.equal(result.adverse_recall10, 0.5);
});

test('calibration cannot use test/synthetic labels, cannot certify tiny samples or overlap test families', async t => {
  const run = await runFixture(makePlan(), await temporary(t)), report = summarize(run, data.gold);
  assert.throws(() => fitPolicy(run, report, 'verify'), /calibration/);
  const template = report.rows.find(r => r.item_id === 'v-supported');
  // Artificial statistical observations exercise the bound; these are not saved as human gold.
  const rows = Array.from({ length: 40 }, (_, i) => ({ ...template, split: 'calibration', adjudication: 'human', group: `g${i}`, source_keys: [`s${i}`] }));
  const calibration = { ...report, rows };
  assert.equal(fitPolicy(run, calibration, 'verify').enabled, false);
  const policy = fitPolicy(run, calibration, 'verify', { maxRisk: 0.1, minGroups: 20 });
  assert.equal(policy.enabled, true); assert.ok(groupRiskUpper(0, 40) > 0);
  assert.throws(() => applyPolicy(run, { ...report, rows: [{ ...rows[0], split: 'test' }] }, policy), /overlap/);
  const result = applyPolicy(run, { ...report, rows: [{ ...template, group: 'fresh', source_keys: ['fresh'] }] }, policy);
  assert.equal(result.accepted, 1);
  assert.throws(() => applyPolicy(run, { ...report, evidence_threshold: 0.8 }, policy), /configuration/);
});

test('paired comparisons keep failures and resample source groups rather than correlated repeats', async t => {
  const run = await runFixture(makePlan({ repeats: '3' }), await temporary(t));
  const report = summarize(run, data.gold), comparison = compareReports(report, report, { task: 'verify', samples: 100 });
  assert.equal(comparison.paired_groups, 5); assert.equal(comparison.observations, 15);
  assert.deepEqual(comparison.ci95, [0, 0]);
  assert.throws(() => compareReports(report, { ...report, gold_sha256: 'different' }, { task: 'verify' }), /frozen gold/);
  const missing = structuredClone(report); missing.rows.pop();
  assert.throws(() => compareReports(report, missing, { task: 'rerank' }), /Unequal/);
});

test('Beaver comparison uses its existing bounded provider call, retains usage and labels elicited estimates', async () => {
  const plan = makePlan(), request = payload(plan, plan.calls[0]), answer = (await protocolFixture(plan, data.gold)(request)).response.answers;
  let params;
  const evaluate = await beaverTransport({ model: 'codex:configured-model', effort: 'low', load: async () => ({ streamChatWithTools: async input => {
    params = input; return { fullText: JSON.stringify({ answers: answer }), usage: { inputTokens: 7, outputTokens: 3 } };
  } }) });
  const result = await evaluate(request, new AbortController().signal);
  assert.equal(params.maxProviderAttempts, 1); assert.equal(params.maxIterations, 1);
  assert.deepEqual(params.tools, []); assert.equal(params.nativeSubagents, false);
  assert.deepEqual(JSON.parse(params.messages[0].content).state, request.state);
  assert.equal(result.response.usage.input_tokens, 7); assert.equal(result.reported_model, null);
});

test('CLI runs without installs or credentials; a live command without opt-in refuses before calls', async t => {
  const directory = join(await temporary(t), 'smoke'), cli = fileURLToPath(new URL('cli.mjs', import.meta.url));
  const output = execFileSync(process.execPath, [cli, 'smoke', '--out', directory], { encoding: 'utf8', env: { ...process.env, TYPESAFE_API_KEY: 'DO_NOT_USE' } });
  assert.match(output, /no model was called/);
  const run = await loadRun(directory); assert.equal(run.receipts.size, 9);
  assert.throws(() => execFileSync(process.execPath, [cli, 'run', '--input', join(directory, 'inputs', 'all.input.jsonl'),
    '--model', 'jev-latest', '--out', join(directory, 'live'), '--max-calls', '1'], { stdio: 'pipe' }), error => error.stderr.toString().includes('--allow-live'));
  const report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
  assert.equal(report.probability_source, 'protocol_fixture');
});
