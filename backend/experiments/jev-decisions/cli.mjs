import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPlan, check, hash } from './contract.mjs';
import { atomicJson, codeHash, loadRun, moduleDirectory, readJsonl, runPlan } from './runner.mjs';
import { beaverTransport, jevTransport } from './transport.mjs';
import { applyPolicy, compareReports, fitPolicy, summarize } from './metrics.mjs';
import { protocolFixture, writeFixtures } from './fixtures.mjs';

export function config(values = {}) {
  return { provider: values.provider ?? 'jev', model: values.model ?? '', context: values.context ?? 'passage',
    verifyMode: values['verify-mode'] ?? 'choice', tabularMode: values['tabular-mode'] ?? 'choice', rankMode: values['rank-mode'] ?? 'score',
    order: values.order ?? 'original', batchSize: Number(values['batch-size'] ?? 10000), repeats: Number(values.repeats ?? 1),
    maxBytes: Number(values['max-bytes'] ?? 96000), effort: values.effort ?? '', maxTokens: Number(values['max-tokens'] ?? 8192) };
}
function revision() {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: moduleDirectory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}
async function planFor(cases, options) {
  const plan = buildPlan(cases, options);
  return { ...plan, code_sha256: await codeHash(), git_commit: revision(), node: process.version, platform: process.platform };
}
const parseJson = async path => JSON.parse(await readFile(path, 'utf8'));
async function save(path, value) {
  await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  await atomicJson(path, value);
}
const HELP = `Jev decision experiments (Node >=22.13; no new dependencies)
  smoke --out DIR                         offline protocol/scorer checks, NOT model quality
  fixtures --out DIR                      write invented input and separate gold JSONL
  plan --input FILE --model ID --out DIR   freeze requests without credentials or calls
  run --input FILE --model ID --out DIR --max-calls N --allow-live [--allow-metered]
  score --run DIR --gold FILE [--out REPORT.json] [--policy FILE]
  fit --run DIR --gold FILE --task verify|tabular --out POLICY.json
  compare --left REPORT --right REPORT --task TASK [--split test] [--metric quality]

Run/plan options: --provider jev|beaver --context passage|window|source
  --verify-mode choice|decomposed --tabular-mode choice|noul --rank-mode score|noul|choice
  --batch-size N --repeats N --order original|reverse --max-bytes N
Run options: --workers N --timeout-ms N --allow-private --effort VALUE --max-tokens N
Scoring: --evidence-threshold P (default .5); fit: --max-risk P --min-groups N
Same output directory resumes only untouched pending calls; errors/unknown outcomes never retry.
Beaver baseline: run with node --import tsx from backend, using its existing provider credentials.
See README.md for packet/gold contracts and what these benchmarks do NOT establish.`;

export async function main(argv = process.argv.slice(2)) {
  const stringOptions = ['out', 'input', 'model', 'provider', 'context', 'verify-mode', 'tabular-mode', 'rank-mode', 'order', 'batch-size', 'repeats', 'max-bytes',
    'max-calls', 'workers', 'timeout-ms', 'effort', 'max-tokens', 'run', 'gold', 'policy', 'evidence-threshold', 'task', 'max-risk', 'min-groups', 'left', 'right', 'split', 'metric'];
  const booleanOptions = ['allow-live', 'allow-metered', 'allow-private', 'help'];
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true,
    options: Object.fromEntries([...stringOptions.map(key => [key, { type: 'string' }]), ...booleanOptions.map(key => [key, { type: 'boolean' }])]) });
  if (values.help || !positionals.length) { console.log(HELP); return; }
  check(positionals.length === 1, 'Expected exactly one command');
  const command = positionals[0];
  const allow = names => check(Object.keys(values).every(key => names.includes(key)), `Unsupported option for ${command}`);
  const require = names => { for (const name of names) check(typeof values[name] === 'string' && values[name].trim(), `--${name} is required`); };
  const threshold = Number(values['evidence-threshold'] ?? 0.5);
  if (command === 'fixtures' || command === 'smoke') {
    allow(['out']); require(['out']);
    const data = await writeFixtures(join(values.out, 'inputs'));
    if (command === 'fixtures') { console.log('Wrote synthetic fixtures; not legal benchmark gold.'); return; }
    const plan = await planFor(data.cases, config({ provider: 'fixture', model: 'protocol-fixture', 'verify-mode': 'decomposed' }));
    const run = await runPlan(plan, { directory: values.out, evaluate: protocolFixture(plan, data.gold), maxCalls: plan.calls.length, workers: 3 });
    const report = summarize(run, data.gold);
    check(report.rows.every(row => row.completed) && report.rows.filter(row => row.task !== 'rerank').every(row => row.quality === 1), 'Protocol smoke failed');
    await save(join(values.out, 'report.json'), report);
    console.log(JSON.stringify({ warning: 'PROTOCOL FIXTURE ONLY; no model was called.', calls: report.accounting.successful_calls,
      observations: report.rows.length, report: join(values.out, 'report.json') }, null, 2)); return;
  }
  if (command === 'plan' || command === 'run') {
    allow(['input', 'out', 'model', 'provider', 'context', 'verify-mode', 'tabular-mode', 'rank-mode', 'order', 'batch-size', 'repeats', 'max-bytes', 'effort', 'max-tokens',
      ...(command === 'run' ? ['max-calls', 'workers', 'timeout-ms', 'allow-live', 'allow-metered', 'allow-private'] : [])]);
    require(['input', 'out', 'model']);
    const settings = config(values);
    check(['jev', 'beaver'].includes(settings.provider), 'Fixture provider is only available through smoke');
    check(Number.isSafeInteger(settings.maxTokens) && settings.maxTokens > 0 && settings.maxTokens <= 131072, 'Invalid output budget');
    const plan = await planFor(await readJsonl(values.input), settings);
    let evaluate = async () => { throw new Error('Offline plan cannot call a model'); };
    if (command === 'run') {
      require(['max-calls']);
      check(values['allow-live'] === true, 'Live calls require explicit --allow-live');
      check(settings.provider !== 'jev' || values['allow-metered'] === true, 'Jev spend requires explicit --allow-metered');
      check(!plan.items.some(item => item.privacy === 'private') || values['allow-private'] === true, 'Private transmission requires --allow-private');
      if (settings.provider === 'beaver') {
        check(/^(codex:|claude-p:|ollama:)/u.test(settings.model) || values['allow-metered'] === true, 'Metered baseline requires --allow-metered');
        evaluate = await beaverTransport({ model: settings.model, effort: settings.effort, maxTokens: settings.maxTokens });
      } else evaluate = jevTransport({ apiKey: process.env.TYPESAFE_API_KEY });
    }
    const controller = new AbortController(), cancel = () => controller.abort();
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    try {
      const run = await runPlan(plan, { directory: values.out, evaluate, maxCalls: command === 'plan' ? 0 : Number(values['max-calls']),
        workers: Number(values.workers ?? 1), timeoutMs: Number(values['timeout-ms'] ?? 30000), signal: controller.signal });
      const complete = [...run.receipts.values()].filter(r => r.status === 'ok').length;
      console.log(JSON.stringify({ planned_calls: plan.calls.length, completed_calls: complete,
        pending_calls: plan.calls.length - run.receipts.size, refused_or_failed_calls: run.receipts.size - complete, plan_sha256: hash(plan) }, null, 2));
      if (command === 'run' && complete !== plan.calls.length) process.exitCode = 2;
    } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
    return;
  }
  if (command === 'score' || command === 'fit') {
    allow(['run', 'gold', 'out', 'evidence-threshold', ...(command === 'fit' ? ['task', 'max-risk', 'min-groups'] : ['policy'])]);
    require(['run', 'gold', ...(command === 'fit' ? ['task', 'out'] : [])]);
    const run = await loadRun(values.run), report = summarize(run, await readJsonl(values.gold), threshold);
    const result = command === 'fit' ? fitPolicy(run, report, values.task, { maxRisk: Number(values['max-risk'] ?? 0.01), minGroups: Number(values['min-groups'] ?? 20) })
      : { ...report, ...(values.policy && { policy_test: applyPolicy(run, report, await parseJson(values.policy)) }) };
    if (values.out) await save(values.out, result);
    const { rows: _, ...summary } = result;
    console.log(JSON.stringify(summary, null, 2)); return;
  }
  if (command === 'compare') {
    allow(['left', 'right', 'task', 'split', 'metric', 'out']); require(['left', 'right', 'task']);
    const result = compareReports(await parseJson(values.left), await parseJson(values.right), { task: values.task, split: values.split ?? 'test', metric: values.metric ?? 'quality' });
    if (values.out) await save(values.out, result);
    console.log(JSON.stringify(result, null, 2)); return;
  }
  throw new Error('Unknown command; use --help');
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
