import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export function scoreCell(cell, expected, direct) {
  if (expected.normal) return { routingPassed: !direct, scored: false };
  const text = cell?.evidence?.map(e => e.span_text ?? '').join('\n') ?? '';
  return { scored: true, passed: !!cell && JSON.stringify(cell.value) === JSON.stringify(expected.value) &&
    cell.outcome === (expected.outcome ?? 'answered') && (expected.evidence ?? []).every(fragment => text.includes(fragment)) };
}
async function main() {
  const { values } = parseArgs({ options: { live: { type: 'boolean' }, model: { type: 'string' }, out: { type: 'string' },
    'allow-metered': { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help || !values.live) {
    console.log('From backend: npx tsx experiments/jev-tabular/benchmark.mjs --live --model <configured-model> --out <new-results.json>');
    console.log('Runs synthetic fixtures through the ACTUAL extractor, standard then hybrid; requires native reader prerequisites and TypeSafe credentials. Metered normal providers additionally require --allow-metered.');
    return;
  }
  if (!values.model || !values.out || !process.env.TYPESAFE_API_KEY?.trim()) throw new Error('Require --model, --out and TYPESAFE_API_KEY.');
  const { providerForModel } = await import('../../src/lib/llm/index.ts');
  if (!['codex', 'claude-p', 'ollama', 'opencode-go'].includes(providerForModel(values.model)) && !values['allow-metered'])
    throw new Error('A metered normal-model control requires explicit --allow-metered.');
  const { extractTabularAnswers } = await import('../../src/lib/tabular/extraction.ts');
  const { runChatTurn } = await import('../../src/lib/chat/turnEngine.ts');
  const { JEV_ROUTING_PROMPT, JEV_POLICY } = await import('../../src/lib/tabular/jev.ts');
  const corpusText = await readFile(new URL('./corpus.json', import.meta.url), 'utf8');
  const corpus = JSON.parse(corpusText), gold = JSON.parse(await readFile(new URL('./gold.json', import.meta.url), 'utf8'));
  const report = { policy: JEV_POLICY, model: values.model, datasetSha256: createHash('sha256').update(corpusText).digest('hex'),
    createdAt: new Date().toISOString(), rows: [] };
  // Allocate before any billed call; never silently overwrite an existing result.
  const { open } = await import('node:fs/promises'); const output = await open(values.out, 'wx', 0o600);
  const originalMode = process.env.BEAVER_JEV_TABULAR_MODE;
  const controller = new AbortController(), cancel = () => controller.abort(new Error('Interrupted'));
  process.once('SIGINT', cancel);
  try {
    for (const row of corpus) for (const mode of ['off', 'auto']) {
      controller.signal.throwIfAborted(); process.env.BEAVER_JEV_TABULAR_MODE = mode;
      const data = Buffer.from(row.source), sourceSha256 = createHash('sha256').update(data).digest('hex');
      const documents = { metadata: async () => ({ filename: `${row.id}.txt` }),
        versions: async () => ({ versions: [{ id: 'v1', size_bytes: data.length }] }),
        projectionSource: async () => ({ documentId: row.id, versionId: 'v1', fileType: 'txt', sourceSha256, readBytes: () => data }) };
      const cells = {}, decisions = [], fallbackColumns = new Set(); let routingCalls = 0, answeringCalls = 0, failure = null;
      const started = performance.now();
      try {
        await extractTabularAnswers({ documents, scope: { userId: 'jev-synthetic-benchmark' },
          subject: { sourceId: row.id, resource: `document://${row.id}/version/v1`, sourceSha256,
            reference: { provider: 'library', kind: 'document', id: row.id, versionId: 'v1' } },
          columns: row.columns, model: values.model, apiKeys: {}, signal: controller.signal,
          runTurn: async options => {
            if (options.systemPrompt === JEV_ROUTING_PROMPT) routingCalls++;
            else {
              answeringCalls++;
              const tools = options.createTools(options.evidenceState, 'main', { evidence: options.evidenceState,
                research: options.researchContext, operation: options.operation, addEvent() {} });
              for (const index of tools.find(t => t.name === 'submit_extraction').inputSchema.properties.column_index.enum) fallbackColumns.add(index);
            }
            return runChatTurn(options);
          },
          onResearchObserved: event => { for (const query of event.queries ?? [])
            if (query.input.purpose === 'tabular_judgment') decisions.push(query.input); },
          accept: async (index, cell) => { cells[index] = cell; },
        });
      } catch { failure = controller.signal.aborted ? 'cancelled' : 'extraction_failed'; }
      const scores = row.columns.map(column => ({ index: column.index, ...scoreCell(cells[column.index], gold[row.id][column.index],
        !!cells[column.index] && !fallbackColumns.has(column.index)) }));
      report.rows.push({ id: row.id, mode, elapsedMs: performance.now() - started, routingCalls, answeringCalls,
        failure, decisions, scores, cells });
      await output.truncate(0); await output.write(JSON.stringify(report, null, 2) + '\n', 0, 'utf8'); await output.sync();
    }
  } finally {
    if (originalMode === undefined) delete process.env.BEAVER_JEV_TABULAR_MODE; else process.env.BEAVER_JEV_TABULAR_MODE = originalMode;
    process.removeListener('SIGINT', cancel); await output.close();
  }
  console.log(JSON.stringify(['off', 'auto'].map(mode => {
    const rows = report.rows.filter(row => row.mode === mode), checks = rows.flatMap(row => row.scores);
    return { mode, fixturePasses: checks.filter(s => s.scored && s.passed).length, scoredCells: checks.filter(s => s.scored).length,
      routingFailures: checks.filter(s => s.routingPassed === false).length, failedRows: rows.filter(r => r.failure).length,
      routingCalls: rows.reduce((n, r) => n + r.routingCalls, 0), normalAnsweringCalls: rows.reduce((n, r) => n + r.answeringCalls, 0),
      elapsedMs: rows.reduce((n, r) => n + r.elapsedMs, 0) };
  }), null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
