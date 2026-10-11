import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = Number(args[index+1]);
  if (!Number.isSafeInteger(value) || value < 1) throw Error(name + ' requires a positive integer');
  args.splice(index,2);
  return value;
};
const limit = option('--limit'), maxBytes = option('--max-output-bytes');
const [captureFile, corpusHome, goldFile] = args;
if (args.length !== 3 || !/-gold\.jsonl$/u.test(goldFile))
  throw Error('Supply capture JSON/JSONL, OpenLegalData home, and *-gold.jsonl beside the capture input; optional --limit N --max-output-bytes N');
if (path.resolve(path.dirname(captureFile)) !== path.resolve(path.dirname(goldFile)))
  throw Error('Keep frozen capture rows beside their original relative evidence paths');
const manifestFile = goldFile.replace(/-gold\.jsonl$/u,'-opinions.json');
const summaryFile = goldFile.replace(/\.jsonl$/u,'-summary.json');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const within = (root, relative) => {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) throw Error('Expected a relative retained-source path');
  const resolved = path.resolve(root,relative), back = path.relative(path.resolve(root),resolved);
  if (back === '..' || back.startsWith('..'+path.sep) || path.isAbsolute(back)) throw Error('Retained-source path leaves its owner');
  return resolved;
};
const input = fs.readFileSync(captureFile), text = input.toString('utf8').replace(/^\uFEFF/u,'');
const rows = text.trimStart().startsWith('[') ? JSON.parse(text) : text.split(/\r?\n/u).filter(line => line.trim()).map(line => JSON.parse(line));
if (!Array.isArray(rows)) throw Error('Capture input must contain complete original rows');
const selected = rows.slice(0,limit ?? rows.length), captures = new Map();
for (const capture of selected) {
  if (capture.schema !== 'courtlistener.browser-capture.v1' || typeof capture.sha256 !== 'string') throw Error('Original collector capture missing');
  const previous = captures.get(capture.sha256);
  if (previous && JSON.stringify(previous) !== JSON.stringify(capture)) throw Error('Conflicting captures for one HTML SHA');
  captures.set(capture.sha256,capture);
}
if (!captures.size) throw Error('No actual captures selected');

function project(body) {
  const nodes = body.source_nodes;
  if (!Array.isArray(nodes) || !nodes.length || typeof body.innerText !== 'string'
      || !Array.isArray(body.anchors) || !Array.isArray(body.links)) throw Error('Complete saved DOM inventory missing; do not rerender or substitute native output');
  const elements = [], indexes = new Map(), active = [], chunks = [];
  let offset = 0;
  for (const [index,node] of nodes.entries()) {
    if (!Number.isInteger(node.node_type) || node.node_type < 1 || node.node_type > 12) throw Error('Invalid DOM node type');
    if (index === 0) {
      if (node.node_type !== 1 || node.parent_index !== null) throw Error('Opinion root must be the first recorded element');
    } else {
      if (!Number.isInteger(node.parent_index) || node.parent_index < 0 || node.parent_index >= index) throw Error('Invalid recorded DOM parent');
      while (active.length && active.at(-1).index !== node.parent_index) {
        const closed = active.pop();
        if (closed.element) closed.element.end = offset;
      }
      if (!active.length) throw Error('Saved nodes are not a rooted DOM preorder');
    }
    let element = null;
    if (node.node_type === 1) {
      if (typeof node.tag !== 'string' || !Object.hasOwn(node,'namespace')
          || (node.namespace !== null && typeof node.namespace !== 'string')
          || !node.attributes || Array.isArray(node.attributes) || typeof node.attributes !== 'object'
          || Object.values(node.attributes).some(value => typeof value !== 'string')) throw Error('Recorded element fields missing');
      const parent = node.parent_index === null ? null : indexes.get(node.parent_index);
      if (parent === undefined) throw Error('Recorded element parent is not an element');
      element = {source_index:elements.length,source_node_index:index,parent_index:parent,tag:node.tag,
        anchor:Object.hasOwn(node.attributes,'id') ? node.attributes.id : null,
        namespace:node.namespace,attributes:node.attributes,start:offset,end:null};
      indexes.set(index,element.source_index);
      elements.push(element);
    } else {
      if (node.value !== null && typeof node.value !== 'string') throw Error('Recorded DOM node value missing');
      if (node.node_type === 3 || node.node_type === 4) {
        if (typeof node.value !== 'string') throw Error('Recorded text node value missing');
        chunks.push(node.value); offset += node.value.length;
      }
    }
    active.push({index,element});
  }
  for (const entry of active) if (entry.element) entry.element.end = offset;
  const content = chunks.join('');
  return elements.map(({start,end,...element}) => ({...element,text_content:content.slice(start,end)}));
}

const capabilities = {element_preorder:true,element_direct_parents:true,element_attributes:true,element_text_content:true,
  body_inner_text:true,anchor_observations:true,link_observations:true,raw_namespaces:true,
  element_inner_text:false,element_visibility:false,browser_table_spans:false,outside_ancestors:false,native_namespace_comparison:false};
const owned = [], goldHash = createHash('sha256');
let outputBytes = 0, goldBytes = 0, bodies = 0, elements = 0, nodes = 0, handle;
const write = (fd,bytes) => {
  if (maxBytes !== null && outputBytes + bytes.length > maxBytes) throw Error('Projected artifacts exceed --max-output-bytes');
  fs.writeFileSync(fd,bytes); outputBytes += bytes.length;
};
try {
  for (const file of [goldFile,manifestFile,summaryFile]) if (fs.existsSync(file)) throw Error('Keep independent gold frozen; output already exists: '+file);
  handle = fs.openSync(goldFile,'wx'); owned.push(goldFile);
  for (const capture of captures.values()) {
    const raw = fs.readFileSync(within(corpusHome,capture.corpus_path));
    if (digest(raw) !== capture.sha256 || raw.length !== capture.bytes) throw Error('Original canonical HTML bytes changed');
    const evidenceBytes = fs.readFileSync(within(path.dirname(captureFile),capture.browser_evidence_path));
    if (digest(evidenceBytes) !== capture.browser_evidence_sha256) throw Error('Original DOM evidence bytes changed');
    const evidence = JSON.parse(evidenceBytes);
    if (evidence.schema !== 'courtlistener.browser-evidence.v1' || evidence.html_sha256 !== capture.sha256
        || evidence.url !== capture.final_url || !Array.isArray(evidence.bodies) || evidence.bodies.length !== capture.body_count)
      throw Error('Original DOM evidence does not identify the captured opinion bodies');
    for (const [bodyIndex,body] of evidence.bodies.entries()) {
      const projected = project(body);
      const row = {schema:'courtlistener.captured-source-body.v1',html_sha256:capture.sha256,body_index:bodyIndex,
        browser_evidence_path:capture.browser_evidence_path,browser_evidence_sha256:capture.browser_evidence_sha256,
        body_evidence_sha256:digest(JSON.stringify(body)),source_nodes_sha256:digest(JSON.stringify(body.source_nodes)),elements:projected};
      const bytes = Buffer.from(JSON.stringify(row)+'\n');
      write(handle,bytes); goldHash.update(bytes); goldBytes += bytes.length;
      bodies++; elements += projected.length; nodes += body.source_nodes.length;
    }
  }
  fs.closeSync(handle); handle = undefined;
  const manifestBytes = Buffer.from(JSON.stringify([...captures.values()],null,2)+'\n');
  const manifestHandle = fs.openSync(manifestFile,'wx'); owned.push(manifestFile);
  try { write(manifestHandle,manifestBytes); } finally { fs.closeSync(manifestHandle); }
  const summary = {schema:'courtlistener.captured-source-gold.v1',pages:captures.size,bodies,elements,source_nodes:nodes,
    selected_capture_rows:selected.length,all_elements:true,include_root:true,visible_text:false,capabilities,
    capture_input_sha256:digest(input),capture_manifest:path.basename(manifestFile),capture_manifest_sha256:digest(manifestBytes),
    gold_sha256:goldHash.digest('hex'),gold_bytes:goldBytes,manifest_bytes:manifestBytes.length,
    projector_sha256:digest(fs.readFileSync(fileURLToPath(import.meta.url))),max_output_bytes:maxBytes,
    scope:'Frozen original acquisition DOM preorder and text-node-derived textContent, bound to complete original body evidence retained by path/SHA and unchanged capture metadata. Per-element innerText/visibility, browser reflected table spans and outside ancestors were not recorded; raw namespaces remain preserved but unsupported by the native model. No browser rerender, native-derived gold or live-navigation claim'};
  const summaryHandle = fs.openSync(summaryFile,'wx'); owned.push(summaryFile);
  try { write(summaryHandle,Buffer.from(JSON.stringify(summary,null,2)+'\n')); } finally { fs.closeSync(summaryHandle); }
  console.log(JSON.stringify({...summary,output_bytes:outputBytes}));
} catch (error) {
  if (handle !== undefined) fs.closeSync(handle);
  for (const file of owned) fs.unlinkSync(file);
  throw error;
}
