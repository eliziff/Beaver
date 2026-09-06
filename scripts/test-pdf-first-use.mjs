// Focused production-renderer probe. No backend, native parser, cloud, OCR or model calls.
// node scripts/test-pdf-first-use.mjs [REPORT_DIR] [BASELINE_REPO]
// CHROMIUM_PATH may point to an installed Chromium; otherwise use Playwright's browser.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile, cp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(repo, 'frontend/package.json'));
const { PDFDocument, StandardFonts, degrees } = require('pdf-lib');
const { chromium } = createRequire(path.join(repo, 'package.json'))('playwright');
const { build } = await import(pathToFileURL(require.resolve('vite')).href);
const react = (await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href)).default;
const reportDir = path.resolve(process.argv[2] || path.join(repo, '.perf/pdf-first-use'));
await mkdir(reportDir, { recursive: true });
const fixture = await PDFDocument.create(), font = await fixture.embedFont(StandardFonts.Helvetica);
for (let n = 1; n <= 300; n++) {
  const page = fixture.addPage(n % 2 ? [612, 792] : [700, 900]);
  page.drawText(`Document page ${n}`, { x: 72, y: 700, size: 20, font });
  page.drawText(`Target passage on page ${n}.`, { x: 72, y: 620, size: 14, font });
  if (n >= 297 && n <= 299) {
    page.setCropBox(20, 30, 560, 710); page.setRotation(degrees([180, 270, 90][n - 297]));
  }
}
const bytes = Buffer.from(await fixture.save());
const instrument = `
export async function getPdfJs() {
  const lib = await originalGetPdfJs();
  const probe = window.pdfProbe;
  return { ...lib, getDocument(options) {
    const task = lib.getDocument(options);
    return { destroy: () => task.destroy(), promise: task.promise.then(pdf => {
      const original = pdf.getPage.bind(pdf);
      pdf.getPage = async number => {
        probe.pages.push(number);
        if (number === 2 && probe.hold) await probe.gate;
        const page = await original(number);
        if (!page.__probe) {
          page.__probe = true;
          const text = page.getTextContent.bind(page);
          page.getTextContent = (...args) => { probe.text.push(number); return text(...args); };
        }
        return page;
      };
      return pdf;
    }) };
  } };
}
`;
async function bundle(source, name) {
  const root = path.join(source, 'frontend');
  const entry = await mkdtemp(path.join(root, '.pdf-first-use-'));
  const output = path.join(reportDir, `dist-${name}`);
  try {
    await writeFile(path.join(entry, 'index.html'), '<!doctype html><html><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>');
    await writeFile(path.join(entry, 'main.tsx'), `
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PdfView } from '@/app/components/shared/views/PdfView';
import { eraseAnnotations } from '${path.join(source, 'shared/pdf-annotations.mjs').replaceAll('\\', '/')}';
import '@/app/globals.css';
const query = new URLSearchParams(location.search);
const targetPage = Number(query.get('target') || 299);
let release;
window.pdfProbe = { pages: [], text: [], hold: query.has('hold'), gate: new Promise(resolve => release = resolve),
  release() { this.hold = false; release(); } };
function App() {
 const editing = query.has('editor');
 const [tool,setTool] = useState('select');
 const [selectedId,onSelect] = useState(null);
 const [marks,setMarks] = useState([{ id:'auto',kind:'highlight',origin:'automatic',label:'Fixture',excerpt:'',rgb:[1,1,0],opacity:.3,
   fragments:[{pageNumber:299,rects:[[.20,.20,.55,.24]]}] }]);
 window.pdfMarks = marks;
 const editor = { marks, selectedId, tool, focus:{ id:'auto',request:1 }, onSelect,
   onCreate(fragments,excerpt) { setMarks(value => [...value,{id:crypto.randomUUID(),kind:'highlight',origin:'manual',label:'Manual',excerpt,rgb:[1,1,0],opacity:.3,fragments}]); },
   onErase(fragments) { setMarks(value=>eraseAnnotations(value,fragments)); } };
 return <main style={{height:'100vh',display:'flex',flexDirection:'column'}}>
   {editing && <nav>{['select','draw','highlight','erase-area'].map(value => <button style={{padding:8}} key={value} onClick={()=>setTool(value)}>{value}</button>)}</nav>}
   <PdfView doc={{document_id:'fixture',version_id:'fixture-v1'}}
     quotes={editing ? undefined : [{page:targetPage,quote:'Target passage on page '+targetPage+'.'}]}
     annotationEditor={editing ? editor : undefined} />
 </main>;
}
createRoot(document.getElementById('root')).render(<App/>);
`);
    await build({ root, configFile: false, plugins: [react(), {
      name: 'controlled-page-metadata-only', enforce: 'pre',
      transform(code, id) {
        if (!id.endsWith('/src/app/lib/pdfJs.ts')) return;
        return code.replace(/export (async )?function getPdfJs\(/u, '$1function originalGetPdfJs(') + instrument;
      },
    }], resolve: { alias: { '@': path.join(root, 'src') } },
      build: { outDir: output, emptyOutDir: true, modulePreload: { polyfill: false },
        rolldownOptions: { input: path.join(entry, 'index.html'), output: { strictExecutionOrder: true } } } });
    await cp(path.join(require.resolve('pdfjs-dist/package.json'), '../standard_fonts'), path.join(output, 'pdfjs-standard-fonts'), { recursive: true });
    // Vite keeps a nested entry's directory in the emitted HTML path.
    return { output, entry: `${path.basename(entry)}/index.html` };
  } finally { await rm(entry, { recursive: true, force: true }); }
}
const reports = [];
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
async function run(source, name, candidate) {
  const { output, entry } = await bundle(source, name);
  const mime = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.pfb':'application/octet-stream' };
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'GET') { response.writeHead(405).end(); return; }
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/api/single-documents/fixture/file') {
        response.writeHead(200, { 'Content-Type':'application/pdf', 'Cache-Control':'private, no-store' }); response.end(bytes); return;
      }
      const file = path.resolve(output, `.${decodeURIComponent(url.pathname)}`);
      if (!file.startsWith(output + path.sep)) { response.writeHead(403).end(); return; }
      const content = await readFile(file);
      response.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }); response.end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext({ viewport:{width:1080,height:900} });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  try {
    await page.goto(`${origin}/${entry}?hold`);
    await page.waitForFunction(() => window.pdfProbe?.pages.includes(2));
    const target = page.locator('[data-page-number="299"]');
    if (candidate) { await target.locator('canvas').waitFor(); await target.locator('.pdf-text-highlight').waitFor(); }
    else assert.equal(await page.locator('canvas').count(), 0);
    await page.screenshot({path:path.join(reportDir, `${name}-metadata-held.png`)});
    const held = { targetPainted: await target.locator('canvas').count() > 0,
      textLayers:await page.locator('.pdf-text-layer').count(), requestedPages:await page.evaluate(()=>window.pdfProbe.pages.length) };
    const before = candidate ? await target.evaluate(el=>el.getBoundingClientRect().top) : null;
    await page.evaluate(()=>window.pdfProbe.release());
    await target.locator('canvas').waitFor();
    await target.locator('.pdf-text-highlight').waitFor();
    await page.waitForFunction(() => window.pdfProbe.pages.includes(300));
    if (candidate) {
      await page.waitForFunction(() => document.querySelectorAll('[data-geometry-ready="true"]').length===300);
      assert.ok(Math.abs((await target.evaluate(el=>el.getBoundingClientRect().top))-before)<2, 'geometry changed visible anchor');
      assert.ok(await page.locator('.pdf-text-layer').count() < 6, 'quote lookup mounted offscreen DOM');
    } else await page.waitForFunction(()=>document.querySelectorAll('.pdf-text-layer').length===300);
    const targetBitmap = await target.locator('canvas').evaluate(el=>el.toDataURL());
    await page.screenshot({path:path.join(reportDir, `${name}-ready.png`)});
    const report = { name, held, readyTextLayers:await page.locator('.pdf-text-layer').count(), errors };
    if (candidate) {
      // Compare the actual highlight box to raster ink, not just its own CSS.
      report.rotations = [];
      for (const [number, angle] of [[297, 180], [298, 270], [299, 90]]) {
        await page.goto(`${origin}/${entry}?target=${number}`);
        const rotated = page.locator(`[data-page-number="${number}"]`);
        await rotated.locator('canvas').waitFor();
        await rotated.locator('.pdf-text-highlight').waitFor();
        const ink = await rotated.evaluate(wrapper => {
          const canvas = wrapper.querySelector('canvas');
          const c = canvas.getBoundingClientRect();
          const r = wrapper.querySelector('.pdf-text-highlight').getBoundingClientRect();
          const x = Math.max(0, Math.floor((r.left-c.left)*canvas.width/c.width));
          const y = Math.max(0, Math.floor((r.top-c.top)*canvas.height/c.height));
          const w = Math.min(canvas.width-x, Math.ceil(r.width*canvas.width/c.width));
          const h = Math.min(canvas.height-y, Math.ceil(r.height*canvas.height/c.height));
          const data = canvas.getContext('2d').getImageData(x,y,w,h).data;
          let dark = 0;
          for(let i=0;i<data.length;i+=4) if(data[i]<100 && data[i+1]<100 && data[i+2]<100 && data[i+3]>128) dark++;
          return { dark, width:r.width, height:r.height };
        });
        assert.ok(ink.dark > 50, `rotation ${angle}: highlight must cover rendered text ink`);
        assert.equal(ink.height > ink.width, angle !== 180);
        report.rotations.push({ angle, inkPixels:ink.dark });
        await page.screenshot({path:path.join(reportDir,`candidate-rotation-${angle}.png`)});
      }
      await page.goto(`${origin}/${entry}?editor`);
      await page.locator('[data-page-number="299"] canvas').waitFor();
      const rectangles = () => page.locator('[data-page-number="299"] [data-annotation-id="auto"] rect').evaluateAll(nodes=>nodes.map(el=>['x','y','width','height'].map(key=>el.getAttribute(key))));
      const initial = await rectangles();
      await page.getByRole('button',{name:'Zoom in',exact:true}).click();
      await page.locator('[data-page-number="299"] canvas').waitFor();
      assert.deepEqual(await rectangles(), initial);
      const input = page.getByRole('textbox',{name:'PDF page',exact:true});
      await input.fill('7'); await input.press('Enter');
      const p7 = page.locator('[data-page-number="7"]');
      await p7.locator('canvas').waitFor();
      await page.getByRole('button',{name:'highlight',exact:true}).click();
      const text = p7.locator('.pdf-text-layer > span').filter({hasText:'Target passage on page 7.'});
      await text.waitFor(); const textBox = await text.boundingBox();
      await page.mouse.move(textBox.x+1,textBox.y+textBox.height/2); await page.mouse.down();
      await page.mouse.move(textBox.x+textBox.width-1,textBox.y+textBox.height/2,{steps:12}); await page.mouse.up();
      await page.waitForFunction(()=>window.pdfMarks.length===2);
      assert.ok((await page.evaluate(()=>window.pdfMarks[1].excerpt)).includes('Target passage'));
      await input.fill('299'); await input.press('Enter');
      await page.locator('[data-page-number="299"] canvas').waitFor();
      await page.getByRole('button',{name:'draw',exact:true}).click();
      const box = await page.locator('[data-page-number="299"]').boundingBox();
      await page.mouse.move(box.x+box.width*.55,box.y+box.height*.5); await page.mouse.down();
      await page.mouse.move(box.x+box.width*.8,box.y+box.height*.55,{steps:10}); await page.mouse.up();
      await page.waitForFunction(()=>window.pdfMarks.length===3);
      const drawn = await page.evaluate(()=>window.pdfMarks[2].fragments[0]);
      assert.equal(drawn.pageNumber,299);
      assert.ok(Math.abs(drawn.rects[0][0]-.55)<.01);
      const marks = await page.evaluate(()=>JSON.stringify(window.pdfMarks));
      await page.setViewportSize({width:680,height:900});
      await page.locator('[data-page-number="299"] canvas').waitFor();
      assert.equal(await page.evaluate(()=>JSON.stringify(window.pdfMarks)),marks);
      await page.screenshot({path:path.join(reportDir,'candidate-rotated-annotations.png')});
      report.annotationGeometryPreserved = true;
      report.manualTextAndAreaHighlights = true;
    }
    assert.deepEqual(errors, []);
    reports.push(report);
    return targetBitmap;
  } finally { await context.close(); await new Promise(resolve=>server.close(resolve)); }
}
try {
  const candidate = await run(repo, 'candidate', true);
  if (process.argv[3]) {
    const baseline = await run(path.resolve(process.argv[3]), 'baseline', false);
    assert.equal(candidate, baseline, 'target bitmap must match pinned baseline exactly');
  }
  await writeFile(path.join(reportDir,'report.json'), JSON.stringify(reports,null,2));
  console.log(JSON.stringify(reports,null,2));
} finally { await browser.close(); }
