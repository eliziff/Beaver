import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

async function main() {
  const [manifestArg, outputArg] = process.argv.slice(2);
  const rounds = Number(process.env.OCR_PROJECTION_ROUNDS || 3);
  assert([1, 3].includes(rounds));
  assert(manifestArg && outputArg, 'usage: native_projection_benchmark.ts MANIFEST OUTPUT');
  const root = process.cwd(), manifestPath = path.resolve(manifestArg), output = path.resolve(outputArg);
  const home = path.join(output, 'app-data');
  assert(!existsSync(home), 'remove the previous isolated app-data before running');
  process.env.MIKE_LOCAL_DATA_DIR = home;
  process.env.LEGALPDF_ENGINE_ROOT = path.join(root, 'legal-pdf-parser');
  process.env.LEGAL_STRUCTURE_NATIVE = path.join(root, 'native/legal-structure-node/target/release/legal_structure_node.dll');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const bytes = readFileSync(path.join(path.dirname(manifestPath), 'input.pdf'));
  const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
  const sourceSha256 = hash(bytes);
  assert.equal(sourceSha256, '039410bc7219449184726a09e261724c3a0f52b050e844f4649fc3ee605bb8a8');
  mkdirSync(home, { recursive: true });
  try {
    const { documentProjectionService: service } = await import('../../backend/src/lib/documentProjectionService');
    const events: number[] = [];
    const reference = { documentId: 'machine-test-ocr-projection', versionId: 'invented-version', sourceSha256 };
    const start = performance.now();
    const prepared = await service.preparePdf({ ...reference, bytes, ocrProvider: 'indra', layout: false,
      progress(value) { if (value.phase === 'recognizing') events.push(value.recognized); } });
    const seconds = (performance.now() - start) / 1000;
    writeFileSync(path.join(output, 'preparation.json'), JSON.stringify({ ...prepared, seconds, progress: events }, null, 2) + '\n');
    assert(['ready', 'degraded'].includes(prepared.status));
    assert.equal(prepared.pagesNeedingOcr.length, 0, 'every scanned page must have usable OCR');
    assert.equal(prepared.pageCount, manifest.pages.length);
    assert.equal(prepared.profile.ocr?.provider, 'indra');
    assert.equal(prepared.ocrRoutedPages.length, manifest.pages.length);
    assert(events.length && events.at(-1) === manifest.pages.length);
    assert(events.every((value, index) => index === 0 || value >= events[index - 1]));
    const pdfProfile = { cacheKey: prepared.cacheKey, profile: prepared.profile, status: prepared.status };
    const pages = await service.pdfTextLayer(() => bytes, { ...reference, cacheKey: prepared.cacheKey }, { pdfProfile });
    assert.equal(pages.length, manifest.pages.length);
    let edits = 0, characters = 0, lines = 0, words = 0;
    for (let index = 0; index < pages.length; index++) {
      const page = pages[index];
      assert.equal(page.pageNumber, index + 1);
      for (const line of page.lines) {
        assert(line.rect.every(Number.isFinite));
        assert(line.rect[0] >= 0 && line.rect[1] >= 0 && line.rect[2] <= page.width && line.rect[3] <= page.height);
        assert(line.rect[2] > line.rect[0] && line.rect[3] > line.rect[1]);
        lines++; words += line.words.length;
      }
      const gold = normalized(manifest.pages[index].gold);
      edits += distance(normalized(page.lines.map(line => line.text).join('\n')), gold);
      characters += Array.from(gold).length;
    }
    const textHash = (values: typeof pages) => hash(Buffer.from(JSON.stringify(values.map(page => page.lines.map(line => line.text)))));
    const referenceText = textHash(pages), runs = [];
    for (let round = 0; round < rounds; round++) {
      // A trailing PDF comment changes the source identity without changing its rendered pages.
      const trialBytes = Buffer.concat([bytes, Buffer.from(`\n% machine_test OCR throughput ${randomUUID()}\n`)]);
      const trialReference = { ...reference, documentId: reference.documentId + '-' + round,
        sourceSha256: hash(trialBytes) };
      const begin = performance.now();
      const trial = await service.preparePdf({ ...trialReference, bytes: trialBytes, ocrProvider: 'indra', layout: false,
        progress() {} });
      const elapsed = (performance.now() - begin) / 1000;
      assert.equal(trial.pagesNeedingOcr.length, 0);
      const trialPages = await service.pdfTextLayer(() => trialBytes, { ...trialReference, cacheKey: trial.cacheKey },
        { pdfProfile: { cacheKey: trial.cacheKey, profile: trial.profile, status: trial.status } });
      assert.equal(textHash(trialPages), referenceText, 'render-equivalent trials must recognize the same text');
      runs.push({ source_sha256: trialReference.sourceSha256, seconds: elapsed });
    }
    const warmSeconds = runs.map(run => run.seconds).sort((a, b) => a - b)[Math.floor(rounds / 2)];
    const cachedStart = performance.now();
    const cached = await service.preparePdf({ ...reference, bytes, pdfProfile });
    const cachedSeconds = (performance.now() - cachedStart) / 1000;
    assert.equal(cached.cacheKey, prepared.cacheKey);
    const result = { origin: 'machine_test', run_id: randomUUID(), source_sha256: sourceSha256,
      native_sha256: hash(readFileSync(process.env.LEGAL_STRUCTURE_NATIVE)),
      model_manifest_sha256: hash(readFileSync(path.join(process.env.LEGALPDF_ENGINE_ROOT, 'runtime/indra/manifest.json'))),
      recognized_sha256: hash(Buffer.from(JSON.stringify(pages))), text_sha256: referenceText,
      page_count: pages.length, lines, words, edits, characters, cer: edits / characters,
      cold_seconds: seconds, cold_pages_per_second: pages.length / seconds, warm_runs: runs,
      warm_seconds: warmSeconds, warm_pages_per_second: pages.length / warmSeconds, cached_seconds: cachedSeconds,
      status: prepared.status, progress: events, profile: prepared.profile, cache_key: prepared.cacheKey, parser_version: prepared.parserVersion };
    writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ page_count: pages.length, cer: result.cer, cold_seconds: seconds,
      warm_pages_per_second: pages.length / warmSeconds, cached_seconds: cachedSeconds, progress: events, lines, words }));
  } finally {
    assert(path.dirname(home) === output && path.basename(home) === 'app-data');
    rmSync(home, { recursive: true, force: true });
  }
}
const normalized = (value: string) => value.replace(/[\u00ad\u00ac]\r?\n/g, '').normalize('NFKC')
  .replace(/[\u00ad\u00ac]/g, '').replace(/\s+/gu, ' ').trim();
function distance(a: string, b: string) {
  const left = Array.from(a), right = Array.from(b), row = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 0; i < left.length; i++) {
    let previous = row[0]; row[0] = i + 1;
    for (let j = 0; j < right.length; j++) {
      const old = row[j + 1]; row[j + 1] = Math.min(old + 1, row[j] + 1, previous + Number(left[i] !== right[j])); previous = old;
    }
  }
  return row[right.length];
}
main().catch(error => { console.error(error); process.exitCode = 1; });
