// Host code is trusted and fixed. The model's program runs only inside QuickJS
// WASM, not Node vm/eval. This thread is independently terminable by its parent.
const { parentPort, workerData } = require('node:worker_threads');
const { newAsyncContext } = require('quickjs-emscripten');
const pending = new Map();
let sequence = 0;
parentPort.on('message', ({ id, value }) => {
  const resolve = pending.get(id);
  if (resolve) { pending.delete(id); resolve(value); }
});
async function main() {
  const vm = await newAsyncContext();
  vm.runtime.setMemoryLimit(32 * 1024 * 1024);
  vm.runtime.setMaxStackSize(1024 * 1024);
  const deadline = Date.now() + 90000;
  vm.runtime.setInterruptHandler(() => Date.now() > deadline);
  try {
    const fn = vm.newAsyncifiedFunction('__rpc', async handle => {
      const text = vm.getString(handle);
      if (Buffer.byteLength(text) > 262144) throw new Error('Native request exceeds limit');
      const command = JSON.parse(text);
      if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error('Invalid native request');
      const id = ++sequence;
      if (id > 4000) throw new Error('Native operation budget exhausted');
      const result = await new Promise(resolve => {
        pending.set(id, resolve); parentPort.postMessage({ type: 'rpc', id, command });
      });
      const encoded = JSON.stringify(result ?? null);
      if (Buffer.byteLength(encoded) > 262144) throw new Error('Native response exceeds limit');
      return vm.newString(encoded);
    });
    vm.setProp(vm.global, '__rpc', fn); fn.dispose();
    // These are guest functions, never host objects or functions/prototypes.
    const bootstrap = `
      const invoke = c => unpack(JSON.parse(__rpc(JSON.stringify(c))));
      function unpack(v) {
        if (Array.isArray(v)) return v.map(unpack);
        if (v && typeof v === 'object') {
          if (Object.keys(v).length === 1 && typeof v.ref === 'string') return object(v.ref);
          return Object.fromEntries(Object.entries(v).map(([k,x]) => [k,unpack(x)]));
        }
        return v;
      }
      function object(ref) {
        return Object.freeze({
          toJSON: () => ({ref}),
          get: name => invoke({op:'get',target:ref,name}),
          set: values => invoke({op:'set',target:ref,values}),
          reset: names => invoke({op:'reset',target:ref,names:Array.isArray(names)?names:[names]}),
          items: (offset=0,limit=20,properties=[]) => invoke({op:'items',target:ref,offset,limit,properties}),
          find: text => invoke({op:'find',target:ref,text}),
          call: (name,...args) => invoke({op:'call',target:ref,name,args}),
          describe: (filter='',offset=0,limit=50) => invoke({op:'describe',target:ref,filter,offset,limit}),
          expect: values => invoke({op:'expect',target:ref,values})
        });
      }
      const doc = object('doc');
      const word = Object.freeze({
        target: target => invoke({op:'target',target}),
        inspect: (query={}) => invoke({op:'inspect',query}),
        create: service => invoke({op:'create',service}),
        review: (targets,decision) => invoke({op:'review',targets:Array.isArray(targets)?targets:[targets],decision}),
        constant: name => invoke({op:'constant',name}),
        any: (type,value) => ({any:type,value}),
        enum: (type,value) => ({enum:type,value}),
        struct: (type,fields) => ({struct:type,fields}),
        mm: value => Math.round(value*100),
        pt: value => Math.round(value*2540/72),
        assert: (test,message='Document assertion failed') => { if (!test) throw new Error(message); }
      });
      const returned = (function(){'use strict';\n${workerData.program}\n})();
      if (returned && typeof returned.then === 'function') throw new Error('Use synchronous JavaScript; native calls already suspend');
      JSON.stringify(returned ?? null);
    `;
    const evaluated = await vm.evalCodeAsync(bootstrap, 'word-program.js');
    if (evaluated.error) {
      const error = vm.dump(evaluated.error); evaluated.error.dispose();
      throw new Error(typeof error?.message === 'string' ? error.message : 'Word program failed');
    }
    const result = vm.getString(evaluated.value); evaluated.value.dispose();
    if (Buffer.byteLength(result) > 64000) throw new Error('Console result exceeds 64000 bytes; return a summary');
    parentPort.postMessage({ type: 'result', value: JSON.parse(result) });
  } finally { vm.dispose(); }
}
main().catch(error => parentPort.postMessage({ type: 'error', error: String(error.message).slice(0,1000) }));
