// Host code is trusted and fixed. The model's program runs only inside QuickJS
// WASM, not Node vm/eval. This thread is independently terminable by its parent.
const { parentPort, workerData } = require('node:worker_threads');
const { newAsyncContext } = require('quickjs-emscripten');
const pending = new Map();
let sequence = 0;
parentPort.on('message', message => {
  const resolve = pending.get(message.id);
  if (resolve) { pending.delete(message.id); resolve(message); }
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
      const reply = await new Promise(resolve => {
        pending.set(id, resolve); parentPort.postMessage({ type: 'rpc', id, command });
      });
      const encoded = JSON.stringify(typeof reply.error === 'string' ? { error: reply.error } : { value: reply.value ?? null });
      if (Buffer.byteLength(encoded) > 262144) throw new Error('Native response exceeds limit');
      return vm.newString(encoded);
    });
    vm.setProp(vm.global, '__rpc', fn); fn.dispose();
    // These are guest functions, never host objects or functions/prototypes.
    // Other members follow UNO naming: UpperCamel reads/assigns a property and
    // lowerCamel calls a native method, both through the same checked broker ops.
    const prefix = `
      const invoke = c => {
        const reply = JSON.parse(__rpc(JSON.stringify(c)));
        if ('error' in reply) throw new Error(reply.error);
        return unpack(reply.value);
      };
      function unpack(v) {
        if (Array.isArray(v)) return v.map(unpack);
        if (v && typeof v === 'object') {
          if (Object.keys(v).length === 1 && typeof v.ref === 'string') return object(v.ref);
          return Object.fromEntries(Object.entries(v).map(([k,x]) => [k,unpack(x)]));
        }
        return v;
      }
      function object(ref) {
        const handle = Object.freeze({
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
        return new Proxy(handle, {
          get: (target, name) => name in target || typeof name !== 'string' || name === 'then' ? target[name]
            : /^[A-Z]/.test(name) ? invoke({op:'get',target:ref,name})
            : (...args) => invoke({op:'call',target:ref,name,args}),
          set: (target, name, value) => {
            if (typeof name !== 'string' || !/^[A-Z]/.test(name)) throw new Error('Cannot assign ' + String(name) + '; native properties are UpperCamel, e.g. String');
            invoke({op:'set',target:ref,values:{[name]:value}}); return true;
          }
        });
      }
      const doc = object('doc');
      const word = Object.freeze({
        target: target => invoke({op:'target',target}),
        inspect: (query={}) => invoke({op:'inspect',query}),
        create: service => invoke({op:'create',service}),
        review: (targets,decision) => invoke({op:'review',targets:Array.isArray(targets)?targets:[targets],decision}),
        section: (paragraph,values={}) => invoke({op:'section',target:typeof paragraph==='string'?paragraph:paragraph.toJSON().ref,values}),
        // Word measures top/bottom margins to the body; an enabled header/footer keeps its edge distance.
        margins: (style,m) => {
          const s = style.get(['TopMargin','BottomMargin','HeaderIsOn','FooterIsOn']), v = {};
          if (m.left !== undefined) v.LeftMargin = m.left;
          if (m.right !== undefined) v.RightMargin = m.right;
          for (const [side,edge,story] of [['top','TopMargin','Header'],['bottom','BottomMargin','Footer']]) {
            if (m[side] === undefined) continue;
            v[edge] = s[story+'IsOn'] ? Math.min(s[edge], Math.round(m[side]/2)) : m[side];
            if (s[story+'IsOn']) v[story+'Height'] = m[side] - v[edge];
          }
          style.set(v); return v;
        },
        constant: name => invoke({op:'constant',name}),
        any: (type,value) => ({any:type,value}),
        enum: (type,value) => ({enum:type,value}),
        struct: (type,fields) => ({struct:type,fields}),
        mm: value => Math.round(value*100),
        pt: value => Math.round(value*2540/72),
        assert: (test,message='Document assertion failed') => { if (!test) throw new Error(message); }
      });
      const returned = (function(){'use strict';
`;
    const evaluated = await vm.evalCodeAsync(prefix + workerData.program + `
})();
      if (returned && typeof returned.then === 'function') throw new Error('Use synchronous JavaScript; native calls already suspend');
      JSON.stringify(returned ?? null);`, 'word-program.js');
    if (evaluated.error) {
      const error = vm.dump(evaluated.error); evaluated.error.dispose();
      // Report the model's own line: the innermost stack frame inside its program.
      const offset = prefix.split('\n').length - 1, lines = workerData.program.split('\n').length;
      const line = [...String(error?.stack ?? '').matchAll(/word-program\.js:(\d+)/g)]
        .map(match => Number(match[1]) - offset).find(n => n >= 1 && n <= lines);
      throw new Error((typeof error?.message === 'string' ? error.message : 'Word program failed') +
        (line ? ` (program line ${line})` : ''));
    }
    const result = vm.getString(evaluated.value); evaluated.value.dispose();
    if (Buffer.byteLength(result) > 64000) throw new Error('Console result exceeds 64000 bytes; return a summary');
    parentPort.postMessage({ type: 'result', value: JSON.parse(result) });
  } finally { vm.dispose(); }
}
main().catch(error => parentPort.postMessage({ type: 'error', error: String(error.message).slice(0,1000) }));
