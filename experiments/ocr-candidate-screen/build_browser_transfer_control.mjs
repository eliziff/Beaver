import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const baseline = resolve(process.argv[2] || resolve(root, 'legal-browser-ocr/dist/runtime-speed-baseline'));
const worker = readFileSync(resolve(baseline, 'dist/recognition-worker.js'));
const manifest = JSON.parse(readFileSync(resolve(baseline, 'assets/manifest.json'), 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha(worker), '5dc8bb19e194a792bc904536da611f72cba78168bbe12efbceb8baff963fc9dd', 'Use the original v0.2.1 recognition worker for this control');
assert.equal(sha(worker), manifest.assets['dist/recognition-worker.js'].sha256);
const path = resolve(root, 'legal-browser-ocr/dist/runtime-speed-control.html');
const current = readFileSync(resolve(root, 'legal-browser-ocr/dist/legal-browser-ocr.html'), 'utf8');
assert.equal((current.match(/"recognitionWorker":"[^"]*"/g) || []).length, 1);
writeFileSync(path, current.replace(/"recognitionWorker":"[^"]*"/, () => `"recognitionWorker":"${worker.toString('base64')}"`));
console.log(JSON.stringify({control_sha256:sha(readFileSync(path)),worker_sha256:sha(worker)}));
