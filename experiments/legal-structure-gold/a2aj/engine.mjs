// The product's text readings the silver labels need, through the built addon (no build):
//   node engine.mjs < {"op": "citations"|"outline", "texts": [..]}   prints a JSON list, one reading per text
// citations: providerCitationsInText (citations with their lookup keys); outline: caseOutline (a
// judgment's headings with their levels, numbered paragraphs, list items and the matter around them);
// keys: citationLookupKeys, the keys of a2aj.sqlite citation_lookup.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defaultNativeAddon, nativeAddonFile } from '../../../shared/nativeAddonFile.mjs';
import { structureEngineAddon } from '../../../shared/structure-engine.mjs';

const root = path.resolve(import.meta.dirname, '../../..');
const addonRoot = path.join(root, 'native/legal-structure-node');
const binary = process.env.LEGAL_STRUCTURE_ADDON || defaultNativeAddon(addonRoot);
const module = { exports: {} };
process.dlopen(module, nativeAddonFile(binary, addonRoot));
const engine = structureEngineAddon(module.exports, { toBuffer: bytes => Buffer.from(bytes) });
const { op, texts } = JSON.parse(readFileSync(0, 'utf8'));
if (op === 'keys') { console.log(JSON.stringify(engine.citationLookupKeys(texts))); process.exit(0); }
const read = { citations: text => engine.providerCitationsInText(text), outline: text => engine.caseOutline(text) }[op];
if (!read) throw new Error(`Unknown op ${op}`);
console.log(JSON.stringify(texts.map(text => { try { return read(text); } catch (error) { return { error: String(error?.message ?? error) }; } })));
