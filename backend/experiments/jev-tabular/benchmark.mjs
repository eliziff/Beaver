import { readFile, open, writeFile, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const hash = text => createHash('sha256').update(text).digest('hex');
export function scoreCell(cell, expected, direct) {
  if (expected.normal) return { routingPassed: !direct, scored: false, completed: !!cell };
  const text = cell?.evidence?.map(e => e.span_text ?? '').join('\n') ?? '';
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  return { scored: true, passed: !!cell && (expected.values ?? [expected.value]).some(value => same(cell.value, value)) &&
    cell.outcome === (expected.outcome ?? 'answered') && (expected.evidence ?? []).every(fragment => text.includes(fragment)) };
}
function summarize(rows, preparations) {
  return ['off', 'auto'].map(mode => {
    const selected = rows.filter(row => row.mode === mode), checks = selected.flatMap(row => row.scores),
      completed = selected.flatMap(row => Object.entries(row.cells).map(([index, cell]) => ({ cell, direct: row.direct.includes(Number(index)),
        score: row.scores.find(score => score.index === Number(index)) }))), accepted = completed.filter(item => item.direct),
      jev = selected.flatMap(row => row.decisions), times = selected.map(row => row.elapsedMs).sort((a, b) => a - b),
      setup = mode === 'auto' ? Object.values(preparations) : [],
      measurements = [...setup.flatMap(item => item.measurements), ...selected.flatMap(row => row.measurements)], phases = ['routing', 'answer', 'repair'],
      sessions = measurements.filter(event => phases.includes(event.phase));
    const tokens = field => jev.every(row => typeof row[field] === 'number') ? jev.reduce((n, row) => n + row[field], 0) : null;
    return { mode, completedRows: selected.length, scoredCells: checks.filter(s => s.scored).length,
      fixturePasses: checks.filter(s => s.scored && s.passed).length,
      directCells: accepted.length, incorrectDirectCells: accepted.filter(item => item.score.scored && !item.score.passed).length,
      routingFailures: checks.filter(s => s.routingPassed === false).length,
      missingCells: selected.reduce((n, row) => n + row.missing.length, 0), failedRows: selected.filter(row => row.failure).length,
      routingCalls: setup.reduce((n, item) => n + item.measurements.length, 0) + selected.reduce((n, row) => n + row.routingCalls, 0), normalAnsweringCalls: selected.reduce((n, row) => n + row.answeringCalls, 0),
      jevCalls: jev.reduce((n, row) => n + row.calls, 0), jevInputTokens: tokens('inputTokens'), jevOutputTokens: tokens('outputTokens'),
      normalTokenUsage: null, rowElapsedMs: times.reduce((a, b) => a + b, 0),
      setupElapsedMs: setup.reduce((total, item) => total + item.elapsedMs, 0),
      elapsedMs: times.reduce((a, b) => a + b, 0) + setup.reduce((total, item) => total + item.elapsedMs, 0),
      inferenceSessions: sessions.length,
      repairSessions: sessions.filter(event => event.phase === 'repair').length,
      rejectedSubmissions: measurements.filter(event => event.status === 'rejected').length,
      failedCells: measurements.filter(event => event.status === 'failed').length,
      duplicateSubmissions: measurements.filter(event => event.status === 'duplicate').length,
      phaseMs: Object.fromEntries(['read', 'routing', 'jev', 'answer', 'repair'].map(phase =>
        [phase, measurements.filter(event => event.phase === phase).reduce((total, event) => total + event.elapsedMs, 0)])),
      // Native provider sessions may hide multiple internal requests; never count them as one request.
      providerRequests: sessions.every(event => Array.isArray(event.contextRounds))
        ? sessions.reduce((total, event) => total + event.contextRounds.reduce((n, round) => n + round.requestAttempts, 0), 0) : null,
      p50RowMs: times.length ? times[Math.ceil(times.length * .5) - 1] : null,
      p95RowMs: times.length ? times[Math.ceil(times.length * .95) - 1] : null };
  });
}
async function main() {
  const { values } = parseArgs({ options: { live: { type: 'boolean' }, model: { type: 'string' }, out: { type: 'string' },
    repeats: { type: 'string', default: '1' }, effort: { type: 'string', default: 'max' }, resume: { type: 'boolean' }, case: { type: 'string' },
    'allow-metered': { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help || !values.live) {
    console.log('From backend: npx tsx experiments/jev-tabular/benchmark.mjs --live --model <configured-model> --out <results.json> [--effort max] [--repeats 3] [--case <row-id>] [--resume]');
    console.log('Actual standard/hybrid extractor comparison; paired order alternates, includes routing overhead and failed/missing cells. Requires native reader prerequisites and TypeSafe credentials. Metered normal models require --allow-metered.');
    return;
  }
  const repeats = Number(values.repeats);
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 20) throw new Error('--repeats must be an integer from 1 to 20.');
  if (!values.model || !values.out || !process.env.TYPESAFE_API_KEY?.trim()) throw new Error('Require --model, --out and TYPESAFE_API_KEY.');
  const { providerForModel } = await import('../../src/lib/llm/index.ts');
  if (!['codex', 'claude-p', 'ollama', 'opencode-go'].includes(providerForModel(values.model)) && !values['allow-metered'])
    throw new Error('A metered normal-model control requires explicit --allow-metered.');
  const { extractTabularAnswers } = await import('../../src/lib/tabular/extraction.ts');
  const { prepareTabularRouting } = await import('../../src/lib/tabular/routing.ts');
  const { runChatTurn } = await import('../../src/lib/chat/turnEngine.ts');
  const { shutdownCodexAppServers } = await import('../../src/lib/llm/codexAppServer.ts');
  const { jevConfig } = await import('../../src/lib/tabular/jev.ts');
  const config = jevConfig({ ...process.env, BEAVER_JEV_TABULAR_MODE: 'auto' });
  if (!config) throw new Error('Invalid Jev configuration; refusing a comparison that silently disables the hybrid.');
  const corpusText = await readFile(new URL('./corpus.json', import.meta.url), 'utf8'),
    goldText = await readFile(new URL('./gold.json', import.meta.url), 'utf8'), allRows = JSON.parse(corpusText), gold = JSON.parse(goldText),
    corpus = values.case && Array.isArray(allRows) ? allRows.filter(row => row.id === values.case) : allRows;
  if (!Array.isArray(corpus) || !corpus.length || new Set(corpus.map(row => row.id)).size !== corpus.length ||
      corpus.some(row => typeof row.source !== 'string' || !row.columns?.length ||
        new Set(row.columns.map(c => c.index)).size !== row.columns.length || row.columns.some(c => !gold[row.id]?.[c.index])))
    throw new Error('Corpus/gold must cover every distinct row and column before inference.');
  const code = await Promise.all(['../../src/lib/tabular/jev.ts', '../../src/lib/tabular/extraction.ts', '../../src/lib/tabular/routing.ts',
    '../../src/lib/chat/turnEngine.ts', '../../src/lib/chat/toolRegistry.ts', '../../src/lib/chat/legalEvidence.ts', '../../src/lib/llm/codex.ts', './benchmark.mjs']
    .map(async file => [file, hash(await readFile(new URL(file, import.meta.url), 'utf8'))]));
  const { apiKey: _key, ...configuration } = config;
  let report = { status: 'running', policy: null, model: values.model, reasoningEffort: values.effort,
    configuration, code: Object.fromEntries(code),
    datasetSha256: hash(corpusText), goldSha256: hash(goldText), selectedCase: values.case ?? null, createdAt: new Date().toISOString(), repeats,
    plannedRows: corpus.length * repeats * 2, order: 'alternating paired arms', preparations: {}, rows: [], summary: [] };
  if (values.resume) {
    const saved = JSON.parse(await readFile(values.out, 'utf8'));
    for (const key of ['model', 'reasoningEffort', 'configuration', 'code', 'datasetSha256', 'goldSha256', 'selectedCase', 'repeats', 'plannedRows'])
      if (JSON.stringify(saved[key]) !== JSON.stringify(report[key])) throw new Error(`Cannot resume: ${key} changed.`);
    const plan = Array.from({ length: repeats }, (_, repeat) => corpus.flatMap((row, r) =>
      ((repeat + r) % 2 ? ['auto', 'off'] : ['off', 'auto']).map(mode => ({ id: row.id, repeat, mode })))).flat();
    if (!Array.isArray(saved.rows) || saved.rows.length > plan.length || saved.rows.some((row, index) =>
      ['id', 'repeat', 'mode'].some(key => row[key] !== plan[index][key]))) throw new Error('Invalid saved row sequence.');
    if (saved.status === 'completed') { console.log(JSON.stringify(saved.summary, null, 2)); return; }
    report = { ...saved, status: 'running', resumptions: [...(saved.resumptions ?? []),
      { at: new Date().toISOString(), completedRows: saved.rows.length, routing: 'restored saved column decisions' }] };
  } else {
    const reserved = await open(values.out, 'wx', 0o600); await reserved.close();
  }
  const checkpoint = async () => {
    report.summary = summarize(report.rows, report.preparations);
    const temporary = `${values.out}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await rename(temporary, values.out); }
    finally { await unlink(temporary).catch(() => {}); }
  };
  const originalMode = process.env.BEAVER_JEV_TABULAR_MODE, controller = new AbortController(),
    cancel = () => controller.abort(new Error('Interrupted'));
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    await checkpoint();
    process.env.BEAVER_JEV_TABULAR_MODE = 'auto';
    for (const row of corpus) if (!report.preparations[row.id]) {
      const started = performance.now(), measurements = [];
      const routing = await prepareTabularRouting({ columns: row.columns, model: values.model, apiKeys: {},
        signal: controller.signal, onMeasurement: event => measurements.push(structuredClone(event)) });
      report.preparations[row.id] = { routing, measurements, elapsedMs: performance.now() - started };
      await checkpoint();
      console.log(`Prepared ${row.id}: ${measurements.length} classification session(s)`);
    }
    for (let repeat = 0; repeat < repeats; repeat++) for (let r = 0; r < corpus.length; r++) {
      const row = corpus[r], order = (repeat + r) % 2 ? ['auto', 'off'] : ['off', 'auto'];
      for (const mode of order) {
        if (report.rows.some(saved => saved.id === row.id && saved.repeat === repeat && saved.mode === mode)) continue;
        controller.signal.throwIfAborted(); process.env.BEAVER_JEV_TABULAR_MODE = mode;
        const data = Buffer.from(row.source), sourceSha256 = hash(data), documents = { metadata: async () => ({ filename: `${row.id}.txt` }),
          versions: async () => ({ versions: [{ id: 'v1', size_bytes: data.length }] }),
          projectionSource: async () => ({ documentId: row.id, versionId: 'v1', fileType: 'txt', sourceSha256, readBytes: () => data }) };
        const cells = {}, decisions = [], measurements = [], fallbackColumns = new Set(); let routingCalls = 0, answeringCalls = 0, failure = null;
        const started = performance.now();
        try {
          await extractTabularAnswers({ documents, scope: { userId: 'jev-synthetic-benchmark' },
            subject: { sourceId: row.id, resource: `document://${row.id}/version/v1`, sourceSha256,
              reference: { provider: 'library', kind: 'document', id: row.id, versionId: 'v1' } },
            columns: row.columns, jevRouting: mode === 'auto' ? report.preparations[row.id].routing : undefined,
            model: values.model, reasoningEffort: values.effort, apiKeys: {}, signal: controller.signal,
            onMeasurement: event => measurements.push(structuredClone(event)),
            runTurn: async options => {
              if (options.grounded === false) routingCalls++;
              else { answeringCalls++;
                const tools = options.createTools(options.evidenceState, 'main', { evidence: options.evidenceState,
                  research: options.researchContext, operation: options.operation, addEvent() {} });
                for (const index of tools.find(t => t.name === 'submit_extraction').inputSchema.properties.column_index.enum) fallbackColumns.add(index);
              }
              return runChatTurn(options);
            },
            onResearchObserved: event => { for (const query of event.queries ?? []) if (query.input.purpose === 'tabular_judgment') {
              report.policy = query.input.policy; decisions.push(structuredClone(query.input)); } },
            accept: async (index, cell) => { cells[index] = cell; },
          });
        } catch { failure = controller.signal.aborted ? 'cancelled' : 'extraction_failed'; }
        const direct = row.columns.filter(c => !!cells[c.index] && !fallbackColumns.has(c.index)).map(c => c.index),
          missing = row.columns.filter(c => !cells[c.index]).map(c => c.index),
          scores = row.columns.map(column => ({ index: column.index, ...scoreCell(cells[column.index], gold[row.id][column.index], direct.includes(column.index)) }));
        report.rows.push({ id: row.id, repeat, mode, sourceSha256, elapsedMs: performance.now() - started, routingCalls, answeringCalls,
          failure: failure ?? (missing.length ? 'incomplete_output' : null), direct, missing, decisions, scores, cells, measurements });
        await checkpoint();
        console.log(`${report.rows.length}/${report.plannedRows} ${row.id} ${mode}: ${Math.round(performance.now() - started)} ms, ${missing.length} missing`);
      }
    }
    report.status = 'completed';
  } catch (error) { report.status = controller.signal.aborted ? 'cancelled' : 'failed'; throw error; }
  finally {
    if (originalMode === undefined) delete process.env.BEAVER_JEV_TABULAR_MODE; else process.env.BEAVER_JEV_TABULAR_MODE = originalMode;
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    await checkpoint();
    await shutdownCodexAppServers();
  }
  console.log(JSON.stringify(report.summary, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
