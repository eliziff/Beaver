// Laptop-CPU cost of the LLM multiple-choice step in the browser runtime: onnxruntime-web WASM
// (as Lens ships it) running Qwen2.5-0.5B-Instruct q4 over one record's tokenized f2l prompts.
// Chunked prefill with the KV cache (the export returns logits for every position), letter
// log-probs read at the last token. Usage: node wasm_time.mjs <model.onnx> <prompts.json> [threads=1] [maxPrompts]
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const ORT = 'C:/Users/elias/Desktop/legal-pinpointer-sonar/lens/node_modules/onnxruntime-web/dist/';
const ort = await import(pathToFileURL(ORT + 'ort.wasm.min.mjs').href).catch(() => import(pathToFileURL(ORT + 'ort.min.mjs').href));
const [modelPath, promptsPath, thr = '1', maxP = '0'] = process.argv.slice(2);
ort.env.wasm.numThreads = +thr;
ort.env.wasm.wasmPaths = pathToFileURL(ORT).href;
const t0 = Date.now();
const sess = await ort.InferenceSession.create(new Uint8Array(fs.readFileSync(modelPath)), {executionProviders: ['wasm']});
const tLoad = (Date.now() - t0) / 1000;
const {prompts, letters, record} = JSON.parse(fs.readFileSync(promptsPath, 'utf8'));
const LAYERS = sess.inputNames.filter(n => n.endsWith('.key')).length, CH = 128;
const empty = () => new ort.Tensor('float32', new Float32Array(0), [1, 2, 0, 64]);
let tokens = 0; const t1 = Date.now(); const answers = [];
for (const ids of (+maxP ? prompts.slice(0, +maxP) : prompts)) {
  let past = {}; for (let l = 0; l < LAYERS; l++) { past[`past_key_values.${l}.key`] = empty(); past[`past_key_values.${l}.value`] = empty(); }
  let logits = null;
  for (let s = 0; s < ids.length; s += CH) {
    const chunk = ids.slice(s, s + CH), n = chunk.length, end = s + n;
    const feeds = {input_ids: new ort.Tensor('int64', BigInt64Array.from(chunk.map(BigInt)), [1, n]),
      attention_mask: new ort.Tensor('int64', new BigInt64Array(end).fill(1n), [1, end]),
      position_ids: new ort.Tensor('int64', BigInt64Array.from(Array.from({length: n}, (_, i) => BigInt(s + i))), [1, n]), ...past};
    const out = await sess.run(feeds);
    past = {}; for (let l = 0; l < LAYERS; l++) { past[`past_key_values.${l}.key`] = out[`present.${l}.key`]; past[`past_key_values.${l}.value`] = out[`present.${l}.value`]; }
    logits = out.logits;
  }
  const V = logits.dims[2], T = logits.dims[1], base = (T - 1) * V;
  answers.push(letters.map(id => logits.data[base + id]));
  tokens += ids.length;
}
const dt = (Date.now() - t1) / 1000;
console.log(JSON.stringify({record, model: modelPath.split(/[\\/]/).pop(), threads: +thr, load_s: tLoad, prompts: answers.length, tokens, seconds: dt, tok_per_s: tokens / dt}));
