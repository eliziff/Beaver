// Execute both real browser cores; only the existing extension transport is replaced
// by an in-process call to the packaged WASM engine. No citation logic lives here.
import { readFileSync, createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import os from 'node:os';

os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
const [baselinePath, candidatePath, packagePath, inputs, output] = process.argv.slice(2).map(value => resolve(value));
const engine = await import(pathToFileURL(join(packagePath, 'node.js')));
const baseline = vm.createContext({});
const candidate = vm.createContext({ LegalPinpointerCitationCall: engine.call });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const files = {};
for (const [context, directory, names] of [
  [baseline, baselinePath, ['canlii-courts.js', 'core.js']],
  [candidate, candidatePath, ['core.js']],
]) {
  for (const name of names) {
    const path = join(directory, name), source = readFileSync(path);
    files[path] = hash(source);
    vm.runInContext(source.toString('utf8'), context, { filename: path });
  }
}
const stream = createWriteStream(output, { flags: 'wx' });
let completed = 0;
for await (const line of createInterface({ input: createReadStream(inputs), crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  const request = JSON.parse(line), record = { id: request.id, method: request.method };
  for (const [arm, context] of [['baseline', baseline], ['candidate', candidate]]) {
    const started = performance.now();
    try {
      record[arm] = { status: 'ok', output: await context.LegalPinpointerCore[request.method](...request.args) };
    } catch (error) {
      record[arm] = { status: 'error', error: String(error.stack || error) };
    }
    record[arm].elapsed_ms = performance.now() - started;
  }
  record.equal = record.baseline.status === 'ok' && record.candidate.status === 'ok'
    && JSON.stringify(record.baseline.output) === JSON.stringify(record.candidate.output);
  if (!stream.write(JSON.stringify(record) + '\n')) await once(stream, 'drain');
  if (++completed % 1000 === 0) console.error(`Compared ${completed} Pinpointer requests`);
}
stream.end();
await once(stream, 'finish');
console.log(JSON.stringify({ node: process.version, engine: engine.version(), files,
  inputs_sha256: hash(readFileSync(inputs)), outputs_sha256: hash(readFileSync(output)),
  bridge_sha256: hash(readFileSync(new URL(import.meta.url))),
  wasm_sha256: hash(readFileSync(join(packagePath, 'pkg/legal_citations_wasm_bg.wasm'))),
  scope: 'Pinpointer core functions using the real WASM transport; excludes browser retrieval and editing' }, null, 2));
