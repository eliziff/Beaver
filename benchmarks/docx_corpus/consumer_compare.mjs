// Compare the real Beaver Node addon and Authorities HTML adapter with saved
// Python-core results. Native calls run in a child so a panic cannot erase a run.
import fs from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { once } from 'node:events';
import os from 'node:os';

os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
const hash = path => createHash('sha256').update(fs.readFileSync(path)).digest('hex');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
function execute(addon, request) {
  try {
    const extracted = addon.citationEngineCall('extract', JSON.stringify({
      text: request.text, offsetUnit: 'char', options: { resolve: false, notes: request.notes },
    })).citations;
    const resolved = addon.citationEngineCall('resolve', JSON.stringify({ citations: extracted, notes: request.notes }));
    return { status: 'ok', extracted, resolved };
  } catch (error) {
    return { status: 'error', error: String(error.stack || error) };
  }
}
if (process.argv[3] === 'native-worker') {
  const module = { exports: {} };
  process.dlopen(module, config.native);
  process.stdout.write(JSON.stringify(execute(module.exports, JSON.parse(fs.readFileSync(0, 'utf8')))));
} else {
  const { createStructureAddon } = await import(pathToFileURL(config.htmlAdapter));
  const { createWasi } = await import(pathToFileURL(config.wasiAdapter));
  const { createFsFromVolume, Volume } = createRequire(config.htmlPackage)('memfs');
  const memoryFs = createFsFromVolume(new Volume());
  const engineModule = new WebAssembly.Module(fs.readFileSync(config.wasm));
  const html = createStructureAddon(() => {
    let stderr = '';
    const wasi = createWasi(memoryFs, { stderr: text => { stderr = `${stderr}\n${text}`.slice(-4000); } });
    const instance = new WebAssembly.Instance(engineModule, wasi.imports);
    wasi.initialize(instance);
    return { instance, close: wasi.close, panic: () => stderr };
  });
  const output = fs.createWriteStream(config.output, { flags: 'wx' });
  const counts = {};
  let completed = 0;
  for await (const line of createInterface({ input: fs.createReadStream(config.inputs), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const request = JSON.parse(line), row = { id: request.id, html: execute(html, request) };
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), process.argv[2], 'native-worker'], {
      input: JSON.stringify({ text: request.text, notes: request.notes }), encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024, windowsHide: true,
    });
    try {
      row.native = child.status === 0 ? JSON.parse(child.stdout) : {
        status: 'error', exit_code: child.status, signal: child.signal,
        error: String(child.error || child.stderr || 'Native worker terminated'),
      };
    } catch (error) {
      row.native = { status: 'error', error: String(error) };
    }
    row.python_status = request.expected.status;
    for (const arm of ['html', 'native']) {
      const actual = row[arm];
      const outcome = actual.status !== 'ok' || request.expected.status !== 'ok' ? 'error'
        : isDeepStrictEqual(actual.extracted, request.expected.extracted)
          && isDeepStrictEqual(actual.resolved, request.expected.resolved) ? 'equal' : 'different';
      row[arm + '_comparison'] = outcome;
      counts[arm + ':' + outcome] = (counts[arm + ':' + outcome] || 0) + 1;
    }
    if (!output.write(JSON.stringify(row) + '\n')) await once(output, 'drain');
    if (++completed % 10 === 0) console.error(`Compared ${completed} consumer documents`);
  }
  output.end();
  await once(output, 'finish');
  console.log(JSON.stringify({ counts, node: process.version,
    files: Object.fromEntries(['native', 'wasm', 'htmlAdapter', 'wasiAdapter', 'htmlPackage', 'inputs']
      .map(key => [key, { path: config[key], sha256: hash(config[key]) }])),
    output_sha256: hash(config.output), harness_sha256: hash(fileURLToPath(import.meta.url)),
    scope: 'Real Node and HTML/WASI citation boundaries; excludes browser UI and document extraction',
    preservation_established: false,
  }, null, 2));
}
