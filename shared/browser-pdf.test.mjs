import test from 'node:test';
import assert from 'node:assert/strict';
import {openPdfDocument, createPdfRuntime} from './browser-pdf.mjs';

test('opening concurrent documents preserves caller bytes across worker transfers', async () => {
  const original = new Uint8Array([37, 80, 68, 70]);
  const lib = {getDocument({data}) {
    return structuredClone(data, {transfer: [data.buffer]});
  }};
  const first = openPdfDocument(lib, {data: original}, {});
  const second = openPdfDocument(lib, {data: original}, {});
  assert.deepEqual(first, original);
  assert.deepEqual(second, original);
  assert.equal(original.byteLength, 4);
});

test('host assets are loaded without eval and missing decoders fail explicitly', async () => {
  const runtime = createPdfRuntime({GlobalWorkerOptions: {}, PDFWorker: class {destroy() {}}}, {
    fileOrigin: false, workerUrl: '/pdf.worker.mjs',
    decoders: {'jbig2.wasm': 'data:application/wasm;base64,AAE='},
  });
  assert.equal(runtime.options.isEvalSupported, false);
  const factory = new runtime.options.BinaryDataFactory({});
  assert.deepEqual(await factory.fetch({kind: 'wasmUrl', filename: 'jbig2.wasm'}), new Uint8Array([0, 1]));
  await assert.rejects(factory.fetch({kind: 'wasmUrl', filename: 'unknown.wasm'}), /Unknown PDF decoder/);
  runtime.destroy();
});
