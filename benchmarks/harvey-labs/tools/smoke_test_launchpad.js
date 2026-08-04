// Smoke test: run the launchpad's inline app JS in a node `vm` with a minimal
// DOM stub, verify init()+render() work, then exercise the rubric and materials
// renderers against real index + materials data.
// Usage: node smoke_test_launchpad.js <launchpad.html> <launchpad_materials.json>
const fs = require('fs');
const vm = require('vm');

const htmlPath = process.argv[2] || 'launchpad.html';
const matPath = process.argv[3] || 'launchpad_materials.json';
const html = fs.readFileSync(htmlPath, 'utf8');
const materialsFile = JSON.parse(fs.readFileSync(matPath, 'utf8'));
const materialsMap = {};
for (const rec of materialsFile.tasks) materialsMap[rec.id] = rec;

function extractJson(id) {
  const m = html.match(new RegExp('<script type="application/json" id="' + id + '">([\\s\\S]*?)</script>'));
  if (!m) throw new Error('no <script id="' + id + '"> found');
  return m[1];
}
const index = JSON.parse(extractJson('index'));
const exp = JSON.parse(extractJson('experiments'));

function appScript() {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no inline app script found');
  return m[1];
}

// ---- minimal element stub -------------------------------------------------
function makeEl(tag, id) {
  const listeners = {};
  return {
    tag, id, _listeners: listeners, _children: [],
    innerHTML: '', textContent: '', value: '', disabled: false, max: '',
    className: '', open: false, dataset: {}, options: [], files: null,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatch(type, ev) { (listeners[type] || []).forEach(fn => fn(ev || { target: {} })); },
    appendChild(child) { this._children.push(child); if (Array.isArray(this.options)) this.options.push(child); return child; },
    insertAdjacentHTML() {}, remove() {}, click() {},
    querySelector(sel) {
      if (sel === '[data-crit-container]' || sel === '[data-mat-container]' || sel === '.body' || sel === '.docrows') return makeEl('div');
      if (sel === 'details') return makeEl('details');
      if (sel === '.morebtn') return null;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === 'section.blk') return [makeEl('section'), makeEl('section'), makeEl('section')];
      return [];
    },
  };
}

const byId = {};
function getEl(id) { if (!byId[id]) byId[id] = makeEl('div', id); return byId[id]; }
const indexEl = getEl('index'); indexEl.textContent = JSON.stringify(index);
const expEl = getEl('experiments'); expEl.textContent = JSON.stringify(exp);

const MATERIALS_JSON = JSON.stringify(materialsFile);
const context = {
  console,
  JSON,
  Math,
  FileReader: class {
    constructor() { this.result = MATERIALS_JSON; }
    readAsText() { /* synchronous: complete immediately */ if (this.onload) this.onload(); }
  },
  document: {
    getElementById: getEl,
    createElement: tag => makeEl(tag),
  },
};
vm.createContext(context);

let fail = 0;
function assert(cond, msg) { if (!cond) { console.error('  ASSERT FAIL:', msg); fail++; } }

try {
  vm.runInContext(appScript(), context, { filename: 'launchpad-app.js' });
  const cardsEl = getEl('cards');
  console.log('cards rendered on first page:', cardsEl._children.length);
  assert(cardsEl._children.length === 10, 'expected 10 cards');
  assert(getEl('status').textContent.includes('of 489 tasks'), 'status shows 489 tasks');
  assert(getEl('stats').innerHTML.includes('17,727'), 'stats shows 17,727 docs');
  console.log('area options:', getEl('area').options.length, '| wt options:', getEl('wt').options.length);

  // exercise the rubric renderer on a mid-size task and a huge-criteria task
  const t1 = index.find(t => t.crit && t.crit.length >= 40);
  const c1 = makeEl('div');
  context.renderCriteria(t1, c1);
  assert(c1.innerHTML.includes('C-001'), 'rubric renders C-001');
  assert(c1.innerHTML.split('class="crit"').length - 1 === t1.crit.length, 'rubric renders all criteria for ' + t1.id);

  // exercise the materials renderer on a huge data-room task (manifest + cap)
  const big = index.find(t => t.docs.length > 500);
  const m1 = makeEl('div');
  context.renderMaterials(big, m1);
  assert(m1.innerHTML.includes('Show remaining'), 'materials shows "Show remaining" for huge task');
  assert(m1.innerHTML.includes('/'), 'materials shows nested doc path');

  // trigger the app's own materials load handler via the file picker
  getEl('file').files = [{ name: 'launchpad_materials.json' }];
  getEl('file').dispatch('change', { target: getEl('file') });
  assert(getEl('status').textContent.includes('materials loaded'), 'materials loaded status');
  assert(getEl('loadbtn').textContent.includes('Reload'), 'load button updated');

  // materials renderer after the real load: small task shows extracted text
  const m2 = makeEl('div');
  const small = index.find(t => t.docs.length > 0 && t.docs.length <= 3);
  context.renderMaterials(small, m2);
  assert(m2.innerHTML.includes('text'), 'materials renders doc text toggle for small task');
  const docText = (materialsMap[small.id].docs[0] || {}).t || '';
  const sample = docText.slice(0, 40);
  if (sample) {
    const escaped = sample.replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    assert(m2.innerHTML.includes(escaped), 'materials includes first-doc text (escaped)');
  }

  // simulate a search filter over prompt text
  const qEl = getEl('q'); qEl.value = 'credit agreement'; qEl.dispatch('input', { target: { value: 'credit agreement' } });
  assert(getEl('status').textContent.includes('(filtered from'), 'search filter applied');

  console.log(fail ? ('FAILURES: ' + fail) : 'SMOKE OK');
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error('SMOKE FAIL:', e && e.stack ? e.stack : e);
  process.exit(1);
}
