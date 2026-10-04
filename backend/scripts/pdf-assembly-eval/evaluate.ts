/** Independently invented synthetic PDF preservation evaluator. See CONTRACT.md. */
import * as pdf from 'pdf-lib';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pdfAssembly } from 'mike/shared/runtime/pdfAssembly.mjs';
import { renderAuthoritiesBook } from '../../src/lib/authoritiesBook';
import { assembleFinalAuthoritiesPdf } from '../../src/lib/authoritiesFinalPdf';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const data = path.join(root, 'benchmarks/local-data/pdf-assembly/v1');
const sources = ['shared/contracts/pdfAssembly.mts', 'shared/contracts/authoritiesBook.mts', 'backend/src/lib/authoritiesFinalPdf.ts'];
const engine = pdfAssembly(pdf);
const N = pdf.PDFName.of;
const hash = (x: string | Uint8Array) => createHash('sha256').update(x).digest('hex');
const json = (x: unknown) => JSON.stringify(x);
const fileHash = async (x: string) => hash(await fs.readFile(x));
const fixedDate = new Date('2001-02-03T04:05:06Z');
const writeJson = async (p: string, x: unknown) => fs.writeFile(p, JSON.stringify(x, null, 2) + '\n');
const readJson = async (p: string) => JSON.parse(await fs.readFile(p, 'utf8'));
type Nav = { id: string; rect: number[]; owner?: number; target?: number; view?: unknown[]; uri?: string; remote?: string };
type Outline = { title: string; target?: number; view?: unknown[]; external?: {uri?: string;remote?:string}; children?: Outline[] };
type Page = { geometry: unknown; content: unknown; resources: unknown; links: Nav[]; label: string };
type Fixture = { id: string; filename: string; pages: Page[]; outline: Outline[] };
type Family = { id: string; fixtures: Fixture[] };
type Gate = { id: string; pass: boolean; expected?: unknown; actual?: unknown };
let gates: Gate[] = [];
let outputs = '';
async function capture(id: string, bytes: Uint8Array) { if (outputs) await fs.writeFile(path.join(outputs,id.replaceAll('/','__')+'.pdf'),bytes); }
function gate(id: string, actual: unknown, expected: unknown) {
  const pass = json(actual) === json(expected);
  gates.push({ id, pass, ...(!pass ? { expected, actual } : {}) });
}
function canonical(document: pdf.PDFDocument, item: pdf.PDFObject | undefined, seen = new Set<pdf.PDFObject>()): unknown {
  if (item === undefined) return null;
  const value = document.context.lookup(item);
  if (value === undefined) return { dangling: String(item) };
  if (value instanceof pdf.PDFNumber) return value.asNumber();
  if (value instanceof pdf.PDFString || value instanceof pdf.PDFHexString) return { string: value.decodeText() };
  if (value instanceof pdf.PDFName) return value.toString();
  if (value === pdf.PDFNull) return null;
  if (seen.has(value)) return { cycle: true };
  const next = new Set(seen).add(value);
  if (value instanceof pdf.PDFArray) return value.asArray().map(x => canonical(document, x, next));
  if (value instanceof pdf.PDFRawStream) return { dictionary: canonical(document, value.dict, next), bytes: hash(pdf.decodePDFRawStream(value).decode()) };
  if (value instanceof pdf.PDFDict) return Object.fromEntries(value.entries().filter(([key]) => !['/Length', '/Filter', '/DecodeParms'].includes(String(key)))
    .sort(([a], [b]) => String(a).localeCompare(String(b))).map(([key, value]) => [String(key), canonical(document, value, next)]));
  return String(value);
}
function destination(document: pdf.PDFDocument, dictionary: pdf.PDFDict): { target: number; view: unknown[] } | undefined {
  const action = dictionary.lookup(N('A'));
  let value = dictionary.get(N('Dest')) ?? (action instanceof pdf.PDFDict && String(action.lookup(N('S'))) === '/GoTo' ? action.get(N('D')) : undefined);
  const named = new Map<string, pdf.PDFObject>();
  const old = document.catalog.lookup(N('Dests'));
  if (old instanceof pdf.PDFDict) old.entries().forEach(([key, val]) => named.set(key.decodeText(), val));
  const visit = (node: pdf.PDFObject | undefined) => {
    const resolved = document.context.lookup(node);
    if (!(resolved instanceof pdf.PDFDict)) return;
    const names = resolved.lookup(N('Names')), kids = resolved.lookup(N('Kids'));
    if (names instanceof pdf.PDFArray) for (let i = 0; i < names.size(); i += 2) {
      const key = names.lookup(i) as pdf.PDFString | pdf.PDFHexString;
      named.set(key.decodeText(), names.get(i + 1));
    }
    if (kids instanceof pdf.PDFArray) kids.asArray().forEach(visit);
  };
  const names = document.catalog.lookup(N('Names'));
  if (names instanceof pdf.PDFDict) visit(names.get(N('Dests')));
  const seen = new Set<string>();
  while (value && !seen.has(String(value))) {
    seen.add(String(value));
    const resolved = document.context.lookup(value);
    if (resolved instanceof pdf.PDFArray) {
      const target = document.getPages().findIndex(page => String(page.ref) === String(resolved.get(0)));
      return { target, view: resolved.asArray().slice(1).map(x => {
        const operand=document.context.lookup(x);
        return operand instanceof pdf.PDFNumber || operand instanceof pdf.PDFName || operand === pdf.PDFNull
          ? canonical(document,x) : {invalidDestinationOperand:operand?.constructor.name??'missing'};
      }) };
    }
    if (resolved instanceof pdf.PDFDict) value = resolved.get(N('D'));
    else if (resolved instanceof pdf.PDFName || resolved instanceof pdf.PDFString || resolved instanceof pdf.PDFHexString) value = named.get(resolved.decodeText());
    else return;
  }
}
function readOutline(document: pdf.PDFDocument): Outline[] {
  const seen = new Set<pdf.PDFDict>();
  const walk = (node: pdf.PDFDict | undefined): Outline[] => {
    const result: Outline[] = [];
    while (node && !seen.has(node)) {
      seen.add(node);
      const title = node.lookup(N('Title')) as pdf.PDFString | pdf.PDFHexString;
      const dest = destination(document, node);
      const children = walk(node.lookupMaybe(N('First'), pdf.PDFDict));
      const action=node.lookup(N('A'));
      const kind=action instanceof pdf.PDFDict?String(action.lookup(N('S'))):'';
      const external=action instanceof pdf.PDFDict && kind==='/URI'?{uri:(action.lookup(N('URI')) as pdf.PDFString).decodeText()}:
        action instanceof pdf.PDFDict && kind==='/GoToR'?{remote:json(canonical(document,action))}:undefined;
      if (dest || external) result.push({ title: title.decodeText(), ...dest, ...(external?{external}:{}), ...(children.length ? { children } : {}) });
      else result.push(...children);
      node = node.lookupMaybe(N('Next'), pdf.PDFDict);
    }
    return result;
  };
  const outline = document.catalog.lookup(N('Outlines'));
  return outline instanceof pdf.PDFDict ? walk(outline.lookupMaybe(N('First'), pdf.PDFDict)) : [];
}
function roman(number: number) {
  let out = '';
  for (const [amount, letters] of [[1000,'M'],[900,'CM'],[500,'D'],[400,'CD'],[100,'C'],[90,'XC'],[50,'L'],[40,'XL'],[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']] as const)
    while (number >= amount) { out += letters; number -= amount; }
  return out;
}
function readLabels(document: pdf.PDFDocument): string[] {
  const ranges = new Map<number, pdf.PDFDict>();
  const visit = (value: pdf.PDFObject | undefined) => {
    const node = document.context.lookup(value);
    if (!(node instanceof pdf.PDFDict)) return;
    const nums = node.lookup(N('Nums')), kids = node.lookup(N('Kids'));
    if (nums instanceof pdf.PDFArray) for (let i = 0; i < nums.size(); i += 2)
      ranges.set(nums.lookup(i, pdf.PDFNumber).asNumber(), nums.lookup(i + 1, pdf.PDFDict));
    if (kids instanceof pdf.PDFArray) kids.asArray().forEach(visit);
  };
  visit(document.catalog.get(N('PageLabels')));
  return document.getPages().map((_, index) => {
    const start = [...ranges.keys()].filter(x => x <= index).sort((a,b) => b-a)[0];
    if (start === undefined) return String(index + 1);
    const def = ranges.get(start)!, prefix = def.lookup(N('P')) as pdf.PDFString | pdf.PDFHexString | undefined;
    const st = def.lookup(N('St')), number = (st instanceof pdf.PDFNumber ? st.asNumber() : 1) + index - start;
    const style = String(def.lookup(N('S')) ?? '');
    let suffix = '';
    if (style === '/D') suffix = String(number);
    if (style === '/R' || style === '/r') suffix = roman(number);
    if (style === '/A' || style === '/a') suffix = String.fromCharCode(65 + (number-1)%26).repeat(Math.ceil(number/26));
    if (style === '/r' || style === '/a') suffix = suffix.toLowerCase();
    return (prefix?.decodeText() ?? '') + suffix;
  });
}
function pageData(document: pdf.PDFDocument, index: number): Omit<Page, 'label'> {
  const page = document.getPage(index), contents = page.node.lookup(N('Contents'));
  const streams = contents instanceof pdf.PDFArray ? contents.asArray() : contents ? [contents] : [];
  const annotations = page.node.lookup(N('Annots'));
  const links: Nav[] = [];
  if (annotations instanceof pdf.PDFArray) annotations.asArray().forEach(ref => {
    const annotation = document.context.lookup(ref, pdf.PDFDict), action = annotation.lookup(N('A'));
    const id = annotation.lookup(N('NM')) as pdf.PDFString | pdf.PDFHexString | undefined;
    const rect = canonical(document, annotation.get(N('Rect'))) as number[];
    const parent = annotation.get(N('P'));
    const ownership = parent ? { owner: document.getPages().findIndex(p => String(p.ref) === String(parent)) } : {};
    const dest = destination(document, annotation);
    if (dest) links.push({ id: id?.decodeText() ?? '', rect, ...ownership, ...dest });
    else if (action instanceof pdf.PDFDict) {
      const kind = String(action.lookup(N('S')));
      if (kind === '/URI') links.push({ id: id?.decodeText() ?? '', rect, ...ownership, uri: (action.lookup(N('URI')) as pdf.PDFString).decodeText() });
      else if (kind === '/GoToR') links.push({ id: id?.decodeText() ?? '', rect, ...ownership, remote: json(canonical(document, action)) });
      else links.push({ id: id?.decodeText() ?? '', rect, ...ownership, remote: 'UNRESOLVED:' + json(canonical(document, annotation)) });
    } else links.push({ id: id?.decodeText() ?? '', rect, ...ownership, remote: 'UNRESOLVED:' + json(canonical(document, annotation)) });
  });
  return { geometry: { media: page.getMediaBox(), crop: page.getCropBox(), trim: page.getTrimBox(), bleed: page.getBleedBox(), art: page.getArtBox(), rotation: page.getRotation().angle },
    content: streams.map(x => hash(pdf.decodePDFRawStream(document.context.lookup(x, pdf.PDFRawStream)).decode())),
    resources: canonical(document, page.node.Resources()), links };
}
function text(document: pdf.PDFDocument, pageIndex: number): string[] {
  const contents = document.getPage(pageIndex).node.lookup(N('Contents'));
  const streams = contents instanceof pdf.PDFArray ? contents.asArray() : contents ? [contents] : [];
  return streams.flatMap(ref => {
    const source = Buffer.from(pdf.decodePDFRawStream(document.context.lookup(ref, pdf.PDFRawStream)).decode()).toString('latin1');
    return [...source.matchAll(/<([0-9A-F]+)>\s*Tj/giu)].map(match => Buffer.from(match[1], 'hex').toString('latin1').replace(/\x96/g, '–').replace(/\x97/g,'—'));
  });
}
function mappedOutline(items: Outline[], mapping: Map<number, number>): Outline[] {
  return items.flatMap(item => {
    const children = mappedOutline(item.children ?? [], mapping), target = item.target===undefined?undefined:mapping.get(item.target);
    if(item.external) return [{title:item.title,external:item.external,...(children.length?{children}:{})}];
    return target === undefined ? children : [{ title: item.title, target, view: item.view, ...(children.length ? { children } : {}) }];
  });
}
function mappedPages(fixture: Fixture, selected: number[], offset: number): Page[] {
  const mapping = new Map(selected.map((source, index) => [source, offset + index]));
  return selected.map((index,selectedIndex) => ({ ...fixture.pages[index], links: fixture.pages[index].links.flatMap(link => {
    const mapped = {...link,...(link.owner===undefined?{}:{owner:offset+selectedIndex})};
    if (link.target === undefined) return [mapped];
    const target = mapping.get(link.target);
    return target === undefined ? [] : [{ ...mapped, target }];
  }) }));
}
function comparePage(id: string, actual: Omit<Page,'label'>, expected: Omit<Page,'label'>) {
  gate(id + '/content-streams', actual.content, expected.content);
  gate(id + '/resources', actual.resources, expected.resources);
  gate(id + '/geometry', actual.geometry, expected.geometry);
  gate(id + '/links', actual.links, expected.links);
}
async function compare(id: string, bytes: Uint8Array, pages: Page[], outline: Outline[]) {
  await capture(id,bytes);
  const document = await pdf.PDFDocument.load(bytes, { updateMetadata: false });
  gate(id + '/page-count', document.getPageCount(), pages.length);
  for (let index = 0; index < pages.length; index++) {
    if (index >= document.getPageCount()) { gate(id + '/page-' + index + '/missing', false, true); continue; }
    comparePage(id + '/page-' + index, pageData(document, index), pages[index]);
  }
  gate(id + '/labels', readLabels(document), pages.map(x => x.label));
  gate(id + '/outlines', readOutline(document), outline);
  return document;
}
function authorOutline(document: pdf.PDFDocument, outlines: Outline[], destinations: Map<string,pdf.PDFObject>) {
  const root = document.context.obj({ Type: 'Outlines' }), rootRef = document.context.register(root);
  const branch = (entries: Outline[], parent: pdf.PDFRef) => {
    const nodes = entries.map((entry, index) => {
      const name = entry.title.replace(/[^A-Za-z0-9]/g,'');
      const dest = entry.target===undefined?undefined:document.context.obj([document.getPage(entry.target).ref, ...entry.view!.map(x => typeof x === 'string' && x.startsWith('/') ? N(x.slice(1)) : x)]);
      if(dest) destinations.set(name, dest);
      const external=entry.external?.uri?{S:'URI',URI:pdf.PDFString.of(entry.external.uri)}:
        entry.external?{S:'GoToR',F:pdf.PDFString.of('remote-synthetic.pdf'),D:pdf.PDFString.of('Anchor')}:undefined;
      const dict = document.context.obj({ Title: pdf.PDFHexString.fromText(entry.title), Parent: parent,
        ...(external?{A:external}:index % 2 ? { A: { S: 'GoTo', D: pdf.PDFString.of(name) } } : { Dest: dest }) });
      return { entry, dict, ref: document.context.register(dict) };
    });
    nodes.forEach((node,index) => {
      if (index) node.dict.set(N('Prev'), nodes[index-1].ref);
      if (index+1 < nodes.length) node.dict.set(N('Next'), nodes[index+1].ref);
      if (node.entry.children?.length) { const child = branch(node.entry.children, node.ref); node.dict.set(N('First'),child.first); node.dict.set(N('Last'),child.last);node.dict.set(N('Count'),pdf.PDFNumber.of(child.count)); }
    });
    return { first: nodes[0].ref, last: nodes.at(-1)!.ref, count: entries.reduce((sum,item)=>sum+1+(item.children?.length??0),0) };
  };
  const result = branch(outlines, rootRef);
  root.set(N('First'),result.first); root.set(N('Last'),result.last);root.set(N('Count'),pdf.PDFNumber.of(result.count));
  document.catalog.set(N('Outlines'),rootRef);
}
async function createFixture(id: string, variant: number, directory: string): Promise<Fixture> {
  const document = await pdf.PDFDocument.create();
  document.setCreationDate(fixedDate); document.setModificationDate(fixedDate);
  document.setTitle('Synthetic assembly fixture ' + id);
  const font = await document.embedFont(pdf.StandardFonts.Helvetica);
  const count = 4;
  for (let index = 0; index < count; index++) {
    const page = document.addPage([500 + variant*7 + index*13, 700 + variant*5 + index*17]);
    page.setCropBox(11+index, 17+index, 430+variant*3+index*11, 610+variant*3+index*13);
    page.setTrimBox(19+index,23+index,390+variant,580+variant);
    page.setRotation(pdf.degrees([0,90,180,270][(index+variant)%4]));
    page.drawText(`${id} page ${index+1}: cobalt windmill ${17+variant*11+index}`, { font, x: 40, y: 150 + index*25, size: 15 });
    page.drawRectangle({ x: 35+index*9, y: 45+index*7, width: 60+index*3, height: 25+variant, color: pdf.rgb(.1*(index+1),.2,.5), opacity: .7 });
  }
  const named = new Map<string,pdf.PDFObject>(), legacy: Record<string,pdf.PDFObject> = {};
  const expectedLinks: Nav[][] = [];
  for (let index = 0; index < count; index++) {
    const next = (index+1)%count, distant = (index+2)%count;
    const coordinate = 300+variant*11+index;
    const farName = id + '-target-' + index;
    const far = document.context.obj([document.getPage(distant).ref, 'XYZ', 20+index, coordinate+100, null]);
    named.set(farName,document.context.obj({ D: far }));
    legacy[farName] = far;
    const directView = ['/FitH', coordinate];
    const farView = ['/XYZ',20+index,coordinate+100,null];
    const scalar = variant%2 === 0 ? document.context.register(pdf.PDFNumber.of(coordinate)) : pdf.PDFNumber.of(coordinate);
    const rows = [
      { id: `${id}-${index}-direct`, fields: { Dest: document.context.obj([document.getPage(next).ref, 'FitH',scalar]) }, expected: { target: next, view: directView } },
      { id: `${id}-${index}-named`, fields: { A: { S: 'GoTo', D: variant%3===0 ? N(farName) : pdf.PDFHexString.fromText(farName) } }, expected: { target: distant, view: farView } },
      { id: `${id}-${index}-self`, fields: { Dest: document.context.obj([document.getPage(index).ref, 'Fit']) }, expected: { target: index, view: ['/Fit'] } },
      { id: `${id}-${index}-web`, fields: { A: { S: 'URI', URI: pdf.PDFString.of(`https://example.invalid/${id}/${index}`) } }, expected: { uri: `https://example.invalid/${id}/${index}` } },
      { id: `${id}-${index}-remote`, fields: { A: { S: 'GoToR', F: pdf.PDFString.of('remote-synthetic.pdf'), D: pdf.PDFString.of('Anchor') } }, expected: { remote: json({'/D': {string:'Anchor'},'/F': {string:'remote-synthetic.pdf'},'/S':'/GoToR'}) } },
    ];
    expectedLinks[index] = rows.map((row, n) => {
      const rect = [25+n*8,35+n*9,80+n*8,46+n*9];
      document.getPage(index).node.addAnnot(document.context.register(document.context.obj({Type:'Annot',Subtype:'Link',Rect:rect,NM:pdf.PDFString.of(row.id),P:document.getPage(index).ref,Border:[0,0,0],...row.fields})));
      return {id:row.id,rect,owner:index,...row.expected};
    });
  }
  const outline: Outline[] = [{ title: id+' Opening',target:0,view:['/XYZ',null,510+variant,1.25],children:[
    {title:id+' Middle',target:1,view:['/FitH',420+variant]},
    {title:id+' Detail',target:3,view:['/FitR',10,20,80+variant,90]}]},
    {title:id+' Appendix',target:2,view:['/Fit']},
    {title:id+' Web reference',external:{uri:`https://example.invalid/outline/${id}`}},
    {title:id+' Remote reference',external:{remote:json({'/D':{string:'Anchor'},'/F':{string:'remote-synthetic.pdf'},'/S':'/GoToR'})}}];
  authorOutline(document,outline,named);
  document.catalog.set(N('Dests'),document.context.obj(legacy));
  const sortedNames=[...named].sort(([a],[b])=>a<b?-1:a>b?1:0);
  const half = Math.floor(sortedNames.length/2);
  const leaves=[sortedNames.slice(0,half),sortedNames.slice(half)].map(entries=>({
    Names:entries.flatMap(([key,value])=>[pdf.PDFString.of(key),value]),
    Limits:[pdf.PDFString.of(entries[0][0]),pdf.PDFString.of(entries.at(-1)![0])]}));
  document.catalog.set(N('Names'),document.context.obj({Dests:document.context.register(document.context.obj({Kids:leaves.map(leaf=>document.context.register(document.context.obj(leaf)))}))}));
  const prefix = id + ':';
  document.catalog.set(N('PageLabels'),document.context.register(document.context.obj({Kids:[
    {Limits:[0,0],Nums:[0,{S:'r',P:pdf.PDFString.of(prefix),St:2+variant}]},
    {Limits:[2,2],Nums:[2,{S:'D',P:pdf.PDFString.of(prefix+'body-'),St:7+variant}]},
    {Limits:[3,3],Nums:[3,{P:pdf.PDFString.of(prefix+'plate')}]}].map(leaf=>document.context.register(document.context.obj(leaf)))})));
  const filename = id + '.pdf';
  const bytes = await document.save({useObjectStreams:false});
  await fs.writeFile(path.join(directory,filename),bytes);
  const loaded = await pdf.PDFDocument.load(bytes,{updateMetadata:false});
  const labels = [prefix+roman(2+variant).toLowerCase(),prefix+roman(3+variant).toLowerCase(),prefix+'body-'+(7+variant),prefix+'plate'];
  const pages = loaded.getPages().map((_,index) => ({...pageData(loaded,index),links:expectedLinks[index],label:labels[index]}));
  if (json(readLabels(loaded)) !== json(labels) || json(readOutline(loaded)) !== json(outline)) throw new Error('Fixture authoring self-check failed: '+id);
  pages.forEach((page,index) => {if(json(pageData(loaded,index).links)!==json(page.links)) throw new Error('Fixture annotation authoring self-check failed: '+id);});
  return {id,filename,pages,outline};
}
async function productionHashes() { return Object.fromEntries(await Promise.all(sources.map(async p => [p,await fileHash(path.join(root,p))]))); }
async function initialize() {
  try { await fs.access(path.join(data,'manifest.json')); throw new Error('Already initialized; fixtures are immutable.'); } catch(error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await fs.mkdir(path.join(data,'dev'),{recursive:true}); await fs.mkdir(path.join(data,'sealed'),{recursive:true});
  const manifest: any = {version:1,provenance:'Independently invented mechanical fixtures; no corpus/user data.',split:'4 development families / 1 sealed family; two independent source documents in each family',files:{},harness:{}};
  for (let familyIndex=0; familyIndex<5; familyIndex++) {
    const split=familyIndex<4?'dev':'sealed', directory=path.join(data,split), id='family-'+familyIndex;
    const family: Family={id,fixtures:[]};
    for (let source=0; source<2; source++) family.fixtures.push(await createFixture(`${id}-source-${source}`,familyIndex*2+source,directory));
    await writeJson(path.join(directory,id+'.json'),family);
    for (const file of [id+'.json',...family.fixtures.map(x=>x.filename)]) manifest.files[split+'/'+file]=await fileHash(path.join(directory,file));
  }
  for (const file of ['evaluate.ts','CONTRACT.md']) manifest.harness[file]=await fileHash(path.join(root,'backend/scripts/pdf-assembly-eval',file));
  manifest.initialProduction=await productionHashes();
  await writeJson(path.join(data,'manifest.json'),manifest);
  await fs.writeFile(path.join(data,'manifest.sha256'),await fileHash(path.join(data,'manifest.json'))+'\n');
  console.log(json({initialized:true,root:path.relative(root,data),split:manifest.split,manifestSha256:await fileHash(path.join(data,'manifest.json'))}));
}
async function verify(split: string, fixtureCheck=true) {
  const manifest=await readJson(path.join(data,'manifest.json'));
  if ((await fs.readFile(path.join(data,'manifest.sha256'),'utf8')).trim()!==await fileHash(path.join(data,'manifest.json'))) throw new Error('Manifest changed');
  for (const [file,sha] of Object.entries(manifest.harness)) if(await fileHash(path.join(root,'backend/scripts/pdf-assembly-eval',file))!==sha) throw new Error('Frozen harness changed: '+file);
  // Development runs never open or hash held-out files.
  for (const [file,sha] of Object.entries(manifest.files)) if(fixtureCheck&&file.startsWith(split+'/'))
    if(await fileHash(path.join(data,file))!==sha) throw new Error('Frozen fixture changed: '+file);
  return manifest;
}
async function checkFamily(family: Family,directory: string) {
  const loaded=await Promise.all(family.fixtures.map(async fixture=>({fixture,bytes:new Uint8Array(await fs.readFile(path.join(directory,fixture.filename)))})));
  const [a,b]=loaded;
  const scenarios=[{name:'full',parts:[{...a,selection:[0,1,2,3]},{...b,selection:[0,1,2,3]}]},
    {name:'reordered-subset',parts:[{...b,selection:[3,1,0]},{...a,selection:[2,0,3]}]}];
  for(const scenario of scenarios) {
    let pages: Page[]=[],outlines: Outline[]=[];
    for(const part of scenario.parts) {
      const offset=pages.length,mapping=new Map(part.selection.map((p,i)=>[p,offset+i]));
      pages.push(...mappedPages(part.fixture,part.selection,offset)); outlines.push(...mappedOutline(part.fixture.outline,mapping));
    }
    const id=family.id+'/'+scenario.name;
    const raw=await pdf.PDFDocument.create(); raw.setCreationDate(fixedDate);raw.setModificationDate(fixedDate);
    for(const part of scenario.parts) await engine.appendPages(raw,part.bytes,part.selection);
    const rawBytes=await raw.save({useObjectStreams:false});
    await compare(id+'/append',rawBytes,pages,outlines);
    const assembled=await engine.assemble({fonts:{},parts:scenario.parts.map(part=>({id:part.fixture.id,source:part.bytes,pageIndices:part.selection})),
      after:({document})=>{document.setCreationDate(fixedDate);document.setModificationDate(fixedDate);},saveOptions:{useObjectStreams:false}});
    await compare(id+'/assemble',assembled.bytes,pages,outlines);
    const repeated=await engine.assemble({fonts:{},parts:[{id:'assembled',source:assembled.bytes}],saveOptions:{useObjectStreams:false}});
    await compare(id+'/repeat',repeated.bytes,pages,outlines);
    const rows=scenario.parts.map((part,index)=>({key:'authority:'+part.fixture.id,name:'Synthetic '+part.fixture.id,tab:'Tab '+(index+1)}));
    const prepared={filename:'synthetic-book.pdf',subtitle:'Synthetic mechanical check',documentTitle:'Synthetic authority volume',bookTitle:'Synthetic authority volume',
      federal:false,electronic:false,court:'',cover:{courtFileNumber:'',partyGroups:[]},coverLine:null,paperCover:null,
      coverPageCount:1,customIndexPages:0,groups:[{label:'Authorities',entries:rows}],
      sources:await Promise.all(scenario.parts.map(async(part,index)=>({...rows[index],bytes:part.bytes,pageIndices:part.selection,databaseReference:null,bookmarks:[],
        outline:engine.readOutlines(await pdf.PDFDocument.load(part.bytes,{updateMetadata:false}))}))) };
    const books=await renderAuthoritiesBook(pdf,prepared as any);
    gate(id+'/book/volumes',books.length,1);
    await capture(id+'/book',books[0].bytes);
    const book=await pdf.PDFDocument.load(books[0].bytes,{updateMetadata:false});
    gate(id+'/book/page-count',book.getPageCount(),pages.length+2);
    const bookPages:Page[]=[],bookOutlines:Outline[]=[{title:prepared.documentTitle,target:0,view:['/Fit']},{title:'Table of Contents',target:1,view:['/Fit']}];
    const children:Outline[]=[]; const placements:any[]=[];const tocTargets:number[]=[];const tocRanges:string[]=[];
    let offset=2;
    for(const [index,part] of scenario.parts.entries()) {
      const mapped=mappedPages(part.fixture,part.selection,offset);
      mapped.forEach((page,index)=>{comparePage(id+'/book/page-'+(offset+index),pageData(book,offset+index),page);bookPages.push(page);});
      children.push({title:rows[index].tab+' — '+rows[index].name,target:offset,view:['/Fit'],children:mappedOutline(part.fixture.outline,new Map(part.selection.map((p,i)=>[p,offset+i])))});
      placements.push({key:rows[index].key,pageIndex:offset,sourcePageIndices:part.selection});tocTargets.push(offset);
      tocRanges.push(`${offset+1}–${offset+part.selection.length}`);offset+=part.selection.length;
    }
    bookOutlines.push({title:'Authorities',target:2,view:['/Fit'],children});
    gate(id+'/book/placements',books[0].placements,placements);
    gate(id+'/book/labels',readLabels(book),Array.from({length:pages.length+2},(_,i)=>String(i+1)));
    gate(id+'/book/outlines',readOutline(book),bookOutlines);
    gate(id+'/book/toc-targets',pageData(book,1).links.map(link=>link.target),tocTargets);
    const tocText=text(book,1);
    gate(id+'/book/toc-rows',tocText,['Table of Contents','AUTHORITIES',...rows.flatMap((row,i)=>[row.tab,row.name,tocRanges[i]]),'2']);
    gate(id+'/book/cover-title',text(book,0).includes(prepared.documentTitle),true);
    gate(id+'/book/front-matter-size',[book.getPage(0).getSize(),book.getPage(1).getSize()],[{width:612,height:792},{width:612,height:792}]);
    const fallback=await renderAuthoritiesBook(pdf,{...prepared,sources:prepared.sources.map(({outline,...source})=>source)} as any);
    await capture(id+'/book-native-outline',fallback[0].bytes);
    const fallbackDoc=await pdf.PDFDocument.load(fallback[0].bytes,{updateMetadata:false});
    gate(id+'/book-native-outline/outlines',readOutline(fallbackDoc),bookOutlines);
    for(let index=0;index<bookPages.length;index++) comparePage(id+'/book-native-outline/page-'+(index+2),pageData(fallbackDoc,index+2),bookPages[index]);
    gate(id+'/book-native-outline/labels',readLabels(fallbackDoc),Array.from({length:bookPages.length+2},(_,i)=>String(i+1)));
    const custom=await renderAuthoritiesBook(pdf,{...prepared,customCover:a.bytes,customIndex:b.bytes,coverPageCount:4,customIndexPages:4} as any);
    await capture(id+'/book-custom-front',custom[0].bytes);
    const customDoc=await pdf.PDFDocument.load(custom[0].bytes,{updateMetadata:false});
    const customPages=[...mappedPages(a.fixture,[0,1,2,3],0),...mappedPages(b.fixture,[0,1,2,3],4),
      ...bookPages.map(page=>({...page,links:page.links.map(link=>({...link,...(link.target===undefined?{}:{target:link.target+6}),...(link.owner===undefined?{}:{owner:link.owner+6})}))}))];
    customPages.forEach((page,index)=>comparePage(id+'/book-custom-front/page-'+index,pageData(customDoc,index),page));
    gate(id+'/book-custom-front/page-count',customDoc.getPageCount(),customPages.length);
    gate(id+'/book-custom-front/labels',readLabels(customDoc),customPages.map((_,i)=>String(i+1)));
    const shiftedBook=mappedOutline(bookOutlines,new Map(Array.from({length:book.getPageCount()},(_,i)=>[i,i+6])));
    const customOutline:Outline[]=[{title:prepared.documentTitle,target:0,view:['/Fit'],children:a.fixture.outline},
      {title:'Table of Contents',target:4,view:['/Fit'],children:mappedOutline(b.fixture.outline,new Map([0,1,2,3].map(i=>[i,i+4])))},shiftedBook[2]];
    gate(id+'/book-custom-front/outlines',readOutline(customDoc),customOutline);
    const draft={import:{kind:'manual'},authorityOrder:[],authorities:{},occurrences:{},units:[],settings:{linkTabs:false,linkPinpoints:false}};
    const final=await assembleFinalAuthoritiesPdf({draft,title:'Synthetic final',workProduct:{id:'synthetic',revision:1}} as any,a.bytes,
      books.map(book=>({role:book.role,bytes:Buffer.from(book.bytes),bookPlacements:book.placements})));
    await capture(id+'/final',final.bytes);
    const finalDoc=await pdf.PDFDocument.load(final.bytes,{updateMetadata:false}),briefCount=a.fixture.pages.length;
    gate(id+'/final/page-count',finalDoc.getPageCount(),briefCount+book.getPageCount());
    for(let index=0;index<briefCount;index++) comparePage(id+'/final/brief-'+index,pageData(finalDoc,index),a.fixture.pages[index]);
    for(let index=0;index<book.getPageCount();index++) {
      const expectedBookPage=index<2?pageData(book,index):bookPages[index-2];
      const expected={...expectedBookPage,links:expectedBookPage.links.map(link=>({...link,...(link.target===undefined?{}:{target:link.target+briefCount}),...(link.owner===undefined?{}:{owner:link.owner+briefCount})}))};
      comparePage(id+'/final/book-'+index,pageData(finalDoc,briefCount+index),expected);
    }
    const finalOutlines:Outline[]=[{title:'Brief',target:0,view:['/Fit'],children:a.fixture.outline},
      {title:'Book of authorities',target:briefCount,view:['/Fit'],children:mappedOutline(bookOutlines,new Map(Array.from({length:book.getPageCount()},(_,i)=>[i,i+briefCount])))}];
    gate(id+'/final/outlines',readOutline(finalDoc),finalOutlines);
    gate(id+'/final/labels',readLabels(finalDoc),[...a.fixture.pages.map(page=>page.label),...Array.from({length:book.getPageCount()},(_,i)=>String(i+1))]);
    gate(id+'/final/warnings',final.warnings,[]);
    // A second export with the same source bytes must produce the same semantic signature.
    const again=await renderAuthoritiesBook(pdf,prepared as any);
    gate(id+'/book/repeated-bytes',hash(again[0].bytes),hash(books[0].bytes));
    for(const part of scenario.parts) gate(id+'/source-unchanged/'+part.fixture.id,await fileHash(path.join(directory,part.fixture.filename)),hash(part.bytes));
  }
}
async function run(split:string,name:string,replace=false) {
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(name)||name.includes('..')) throw new Error('Run name must be one path component');
  const receipt=path.join(data,name+'.json');
  if(!replace && await fs.access(receipt).then(()=>true,()=>false)) throw new Error('Named receipt already exists: '+name);
  const manifest=await verify(split,false),production=await productionHashes();
  if(split==='sealed') {
    const finalHash=process.argv.find(x=>x.startsWith('--final-incumbent='))?.slice('--final-incumbent='.length);
    if(finalHash!==hash(json(production))) throw new Error('Holdout requires --final-incumbent='+hash(json(production))+' after incumbent selection');
    await fs.writeFile(path.join(data,'SEALED-OPENED.json'),JSON.stringify({openedAt:new Date().toISOString(),production,finalHash})+'\n',{flag:'wx'});
  }
  await verify(split);
  const outputRoot=path.resolve(data,'outputs');outputs=path.resolve(outputRoot,name);
  if(path.dirname(outputs)!==outputRoot) throw new Error('Output must stay in the evaluator output directory');
  if(replace) await fs.rm(outputs,{recursive:true,force:true});
  await fs.mkdir(outputs,{recursive:true});
  const directory=path.join(data,split);
  const families=(await fs.readdir(directory)).filter(file=>file.endsWith('.json')).sort();
  for(const file of families) { const family=await readJson(path.join(directory,file));try {await checkFamily(family,directory);} catch(error) {gate(family.id+'/execution',String((error as Error).stack), 'completed');} }
  const passed=gates.filter(gate=>gate.pass).length,failed=gates.length-passed;
  const baselinePath=path.join(data,'baseline-dev.json');
  let regressions:string[]=[],gateSetStable=true;
  try {
    const baseline=await readJson(baselinePath),current=new Map(gates.map(gate=>[gate.id,gate.pass]));
    if(split==='dev') {gateSetStable=json(gates.map(gate=>gate.id).sort())===json(baseline.gates.map((gate:Gate)=>gate.id).sort());regressions=baseline.gates.filter((gate:Gate)=>gate.pass && current.get(gate.id)!==true).map((gate:Gate)=>gate.id);}
  } catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;}
  const result={version:1,machine_test:true,runId:name,split,startedAt:new Date().toISOString(),manifestSha256:await fileHash(path.join(data,'manifest.json')),
    production,productionSha256:hash(json(production)),score:{passed,total:gates.length,failed},constraints:{noBaselineRegression:regressions.length===0,gateSetStable,completed:gates.every(gate=>!gate.id.endsWith('/execution')),regressions},gates};
  await fs.writeFile(receipt,JSON.stringify(result,null,2)+'\n',{flag:replace?'w':'wx'});
  if(name==='baseline-dev' && split!=='dev') throw new Error('Baseline must be development');
  if(!replace) await fs.appendFile(path.join(data,'attempts.jsonl'),JSON.stringify({...result,gates:undefined,receipt:path.relative(root,receipt),receiptSha256:await fileHash(receipt)})+'\n');
  console.log(json({receipt:path.relative(root,receipt),score:result.score,constraints:result.constraints,productionSha256:result.productionSha256,failures:gates.filter(gate=>!gate.pass).map(gate=>gate.id)}));
  if(regressions.length||!gateSetStable||gates.some(gate=>gate.id.endsWith('/execution'))) process.exitCode=2;
}
async function main(){const [command,name]=process.argv.slice(2);if(command==='init') await initialize();else if(command==='dev'||command==='sealed') await run(command,name??'latest-'+command,name===undefined);else if(command==='hash') console.log(hash(json(await productionHashes())));else throw new Error('Usage: evaluate.ts init | dev NAME | hash | sealed NAME --final-incumbent=HASH');}
main().catch(error=>{console.error(error);process.exitCode=1;});
