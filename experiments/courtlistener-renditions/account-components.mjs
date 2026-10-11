// Actual persisted-corpus accounting only: no encoding, restoration or compression.
// Run: node experiments/courtlistener-renditions/account-components.mjs <corpus-root>
// Publish stdout through the existing budget.writer(), after require_bytes(length).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root = path.resolve(process.argv[2] ?? 'benchmarks/local-data/courtlistener-renditions');
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fields = ['html_with_citations', 'xml_harvard', 'html_columbia', 'html_lawbox',
  'html_anon_2020', 'html', 'plain_text', 'xml_scan'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const serialized = value => Buffer.from(JSON.stringify(value), 'utf8');
const check = (condition, message) => { if (!condition) throw Error(message); };
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const relative = file => path.relative(project, file).replaceAll('\\', '/');
const proofFile = path.join(root, 'forward-pack/proof.json');
const plainProofFile = path.join(root, 'forward-plain-text/summary.json');
const proof = readJSON(proofFile), plainProof = readJSON(plainProofFile);
check(proof.records === 24302 && plainProof.records === proof.records, 'Unexpected proof cohort');
check(proof.canonical_source_rows_sha256 === proof.canonical_reconstructed_rows_sha256 &&
  plainProof.source_rows_sha256 === proof.canonical_source_rows_sha256 &&
  plainProof.reopened_rows_sha256 === proof.canonical_source_rows_sha256 &&
  plainProof.persisted_pack_reopened && plainProof.exact_original_rows_verified === proof.records,
  'Existing reconstruction proofs are incomplete or disagree');
const sourceRows = new Map();
let sourceIDs;

function metadataFingerprint(record) {
  const opinion = {...record.opinion};
  for (const field of fields) delete opinion[field];
  const metadata = {...record, opinion};
  delete metadata.rendition_recipes;
  return hash(serialized(metadata));
}

function account(name, expectedCompressed, expectedRaw) {
  const directory = path.join(root, name), indexFile = path.join(directory, 'index.json');
  const indexBytes = fs.readFileSync(indexFile), index = JSON.parse(indexBytes);
  const packFile = path.join(directory, 'opinions.jsonl.zst');
  check(index.schema === 'courtlistener.lossless-zstd-frames.v1' && index.rows === proof.records &&
    index.compressed_bytes === expectedCompressed && index.raw_bytes === expectedRaw &&
    fs.statSync(packFile).size === index.compressed_bytes, `${name}: index/proof sizes disagree`);
  if (name === 'pack-zstd9') check(hash(indexBytes) === plainProof.source_manifest_sha256,
    'Original index differs from the independently reconstructed plain-policy proof');
  const components = {rendition_value_tokens: 0, alias_recipe_value_tokens: 0,
    insertion_payload_string_tokens: 0, insertion_offset_number_tokens: 0,
    remaining_annotation_recipe_value_bytes: 0, remaining_record_and_recipe_envelope_bytes: 0};
  const renditions = Object.fromEntries(fields.map(field => [field, {
    present_strings: 0, empty_strings: 0, nulls: 0, absent: 0, encoded_by_recipe: 0,
    decoded_utf8_text_bytes: 0, json_value_token_bytes: 0,
  }]));
  const recipes = {aliases: 0, annotation_recipes: 0, insertion_pairs: 0,
    insertion_decoded_utf8_text_bytes: 0, alias_source_name_decoded_utf8_bytes: 0,
    admitted_target_source_method_pairs: {}};
  const compressedHash = createHash('sha256'), rawHash = createHash('sha256');
  const ids = [], seen = new Set();
  let offset = 0, rawBytes = 0, records = 0, frames = 0;
  const handle = fs.openSync(packFile, 'r');
  try {
    for (const frame of index.frames) {
      check(frame.offset === offset && frame.bytes > 0 && frame.raw_bytes > 0,
        `${name}: discontinuous frame index`);
      const compressed = Buffer.alloc(frame.bytes);
      check(fs.readSync(handle, compressed, 0, compressed.length, offset) === compressed.length,
        `${name}: truncated compressed frame`);
      compressedHash.update(compressed);
      const raw = zlib.zstdDecompressSync(compressed);
      check(raw.length === frame.raw_bytes && hash(raw) === frame.sha256,
        `${name}: persisted frame digest mismatch`);
      rawHash.update(raw);
      const frameIDs = [];
      let start = 0;
      while (start < raw.length) {
        const end = raw.indexOf(10, start);
        check(end >= start, `${name}: missing JSONL delimiter`);
        const line = raw.subarray(start, end), record = JSON.parse(line.toString('utf8'));
        // Every token attribution below uses JSON.stringify only after its entire
        // record matches the literal stored bytes. No reserialization assumption.
        check(line.equals(serialized(record)), `${name}: JSON serialization differs from stored bytes`);
        const id = record.opinion?.id;
        check(typeof id === 'string' && !seen.has(id), `${name}: missing or duplicate opinion ID`);
        seen.add(id); ids.push(id); frameIDs.push(id); records++;
        const source = sourceRows.get(id);
        if (name !== 'pack-zstd9') check(source && metadataFingerprint(record) === source.metadata,
          `${name}/${id}: retained non-rendition metadata differs`);
        const current = {};
        const encoded = record.rendition_recipes ?? {};
        check(encoded && typeof encoded === 'object' && !Array.isArray(encoded), 'Invalid recipe envelope');
        for (const field of fields) {
          const stats = renditions[field];
          if (!Object.hasOwn(record.opinion, field)) {
            stats.absent++;
            if (Object.hasOwn(encoded, field)) stats.encoded_by_recipe++;
            if (source) check(Object.hasOwn(encoded, field) ? source.fields[field]?.kind === 'nonempty_string'
              : source.fields[field] === undefined, `${name}/${id}/${field}: field presence changed`);
            continue;
          }
          const value = record.opinion[field], token = serialized(value);
          check(value === null || typeof value === 'string', `${name}/${id}/${field}: unexpected value type`);
          check(!Object.hasOwn(encoded, field), `${name}/${id}/${field}: recipe shadows retained value`);
          const kind = value === null ? 'null' : value === '' ? 'empty_string' : 'nonempty_string';
          current[field] = {kind, sha256: hash(token)};
          if (source) check(source.fields[field]?.kind === kind && source.fields[field]?.sha256 === current[field].sha256,
            `${name}/${id}/${field}: retained rendition changed`);
          components.rendition_value_tokens += token.length;
          stats.json_value_token_bytes += token.length;
          if (value === null) stats.nulls++;
          else {
            stats.present_strings++;
            if (value === '') stats.empty_strings++;
            stats.decoded_utf8_text_bytes += Buffer.byteLength(value, 'utf8');
          }
        }
        for (const [target, recipe] of Object.entries(encoded)) {
          check(fields.includes(target) && fields.includes(recipe.from) &&
            typeof record.opinion[recipe.from] === 'string' && record.opinion[recipe.from] !== '' &&
            source?.fields[target]?.kind === 'nonempty_string', `${name}/${id}: invalid retained source/target`);
          const tokenBytes = serialized(recipe).length;
          let method;
          if (recipe.method === 'Alias') {
            check(Object.keys(recipe).sort().join(',') === 'from,method', 'Unknown alias field');
            check(source.fields[target].sha256 === current[recipe.from].sha256, 'Alias source differs from original target');
            recipes.aliases++;
            recipes.alias_source_name_decoded_utf8_bytes += Buffer.byteLength(recipe.from);
            components.alias_recipe_value_tokens += tokenBytes;
            method = 'alias';
          } else {
            check(recipe.method === 'CourtListener' && Object.keys(recipe).sort().join(',') === 'from,method,recipe' &&
              Object.keys(recipe.recipe).sort().join(',') === 'insertions,source_is_plain_text' &&
              typeof recipe.recipe.source_is_plain_text === 'boolean' && Array.isArray(recipe.recipe.insertions),
              'Unknown annotation recipe schema');
            recipes.annotation_recipes++;
            let payloadBytes = 0, offsetBytes = 0, previous = 0;
            for (const pair of recipe.recipe.insertions) {
              check(Array.isArray(pair) && pair.length === 2 && Number.isSafeInteger(pair[0]) && pair[0] >= previous &&
                typeof pair[1] === 'string', 'Invalid insertion pair');
              previous = pair[0]; recipes.insertion_pairs++;
              payloadBytes += serialized(pair[1]).length;
              offsetBytes += serialized(pair[0]).length;
              recipes.insertion_decoded_utf8_text_bytes += Buffer.byteLength(pair[1], 'utf8');
            }
            components.insertion_payload_string_tokens += payloadBytes;
            components.insertion_offset_number_tokens += offsetBytes;
            components.remaining_annotation_recipe_value_bytes += tokenBytes - payloadBytes - offsetBytes;
            method = recipe.recipe.source_is_plain_text ? 'plain_text_and_insertions' : 'markup_and_insertions';
          }
          const pair = `${target}<-${recipe.from}:${method}`;
          recipes.admitted_target_source_method_pairs[pair] = (recipes.admitted_target_source_method_pairs[pair] ?? 0) + 1;
        }
        if (name === 'pack-zstd9') {
          check(Object.keys(encoded).length === 0, 'Original unexpectedly has recipes');
          sourceRows.set(id, {metadata: metadataFingerprint(record), fields: current});
        }
        const accounted = Object.values(components).slice(0, -1).reduce((a, b) => a + b, 0);
        // Compute residual cumulatively: exact token partition, including this LF.
        rawBytes += line.length + 1;
        components.remaining_record_and_recipe_envelope_bytes = rawBytes - accounted;
        check(components.remaining_record_and_recipe_envelope_bytes >= 0, 'Negative envelope attribution');
        start = end + 1;
      }
      check(JSON.stringify(frameIDs) === JSON.stringify(frame.ids), `${name}: frame ID membership differs`);
      offset += frame.bytes; frames++;
    }
  } finally { fs.closeSync(handle); }
  const rawSHA = rawHash.digest('hex');
  check(offset === index.compressed_bytes && rawBytes === index.raw_bytes && records === index.rows &&
    Object.values(components).reduce((a, b) => a + b, 0) === rawBytes, `${name}: incomplete byte partition`);
  if (name === 'pack-zstd9') {
    check(rawSHA === proof.canonical_source_rows_sha256, 'Original raw rows disagree with existing independent proof');
    sourceIDs = ids;
  } else check(JSON.stringify(ids) === JSON.stringify(sourceIDs), `${name}: cohort membership/order differs`);
  if (name === 'forward-plain-text') check(recipes.aliases === plainProof.recipes.alias &&
    recipes.annotation_recipes === plainProof.recipes.plain_text_and_insertions, 'Plain-policy recipe counts differ');
  return {name, index: {path: relative(indexFile), sha256: hash(indexBytes)},
    compressed: {path: relative(packFile), bytes: offset, sha256: compressedHash.digest('hex'), level: index.level},
    raw_jsonl_bytes: rawBytes, raw_jsonl_sha256: rawSHA, records, verified_frames: frames,
    ordered_ids_sha256: hash(serialized(ids)), json_stringify_full_record_byte_matches: records,
    exact_serialized_byte_partition: components, rendition_values: renditions, recipes,
    decoded_rendition_utf8_text_bytes: Object.values(renditions).reduce((sum, item) => sum + item.decoded_utf8_text_bytes, 0)};
}

const started = performance.now();
const representations = [account('pack-zstd9', proof.original_zstd_bytes, plainProof.original_jsonl_bytes),
  account('forward-pack', proof.candidate_zstd_bytes, 518679723),
  account('forward-plain-text', plainProof.recipe_zstd_bytes, plainProof.recipe_jsonl_bytes)];
const sourceFile = relative(fileURLToPath(import.meta.url));
const report = {schema: 'courtlistener.stored-component-accounting.v1', created_utc: new Date().toISOString(),
  analysis_seconds: (performance.now() - started) / 1000, records: proof.records,
  representations, source: {path: sourceFile, sha256: hash(fs.readFileSync(sourceFile))},
  schemas: ['legal-structure/experiments/courtlistener-corpus/src/derivations.rs', 'legal-structure/src/native_markup.rs']
    .map(file => ({path: file, sha256: hash(fs.readFileSync(path.join(project, file)))})),
  existing_reconstruction_proofs: [proofFile, plainProofFile].map(file => ({path: relative(file), sha256: hash(fs.readFileSync(file))})),
  reconstruction_scope: 'Uses completed independent native reconstruction proofs; this run does not reconstruct or encode. Current original raw rows match the proved canonical SHA; plain-policy source index matches its proof. The older full-recipe proof records no candidate index SHA, so its historical candidate identity is bound only by path, cohort and compressed bytes, not a historical candidate digest. Current candidate indexes, every frame and compressed bytes are independently bound here.',
  partition_definition: {rendition_value_tokens: 'Complete JSON value tokens of the eight retained opinion fields, including quotation/escaping, null and empty strings; excludes their keys.',
    alias_recipe_value_tokens: 'Complete Alias recipe object values, including source name and punctuation; excludes target key/envelope.',
    insertion_payload_string_tokens: 'JSON string value tokens inside insertion pairs, including quotation/escaping.',
    insertion_offset_number_tokens: 'Literal JSON numeric value tokens inside insertion pairs.',
    remaining_annotation_recipe_value_bytes: 'CourtListener recipe value bytes minus payload and offset value tokens: method/from/source flag keys/values, nested arrays/objects and punctuation.',
    remaining_record_and_recipe_envelope_bytes: 'Everything else in each original stored JSONL line: non-rendition values, rendition and recipe-target keys, recipe envelope, all remaining punctuation, and one LF.'},
  limitations: ['Decoded text byte totals overlap their serialized token categories and are not additional storage.',
    'Compressed values are whole existing Zstd pack sizes. There is no additive compressed component attribution or ablation/recompression.',
    'Recipes retain annotation insertion strings and offsets; this accounting does not measure fresh citation detection/resolution or any proposed new codec.',
    'Only the completed 24,302-record corpus is measured; no full-CourtListener estimate.'],
  regeneration: {analysis_argv: ['node', sourceFile, relative(root)],
    publication: 'Capture stdout (maximum 262144 bytes); import experiments/courtlistener-renditions/budget.py; within budget.writer() require_bytes(len(stdout)), write receipt beside this corpus. Node performs the analysis; Python is mutex/publication orchestration only.'}};
const output = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
check(output.length <= 262144, 'Accounting receipt exceeds bounded publication size');
process.stdout.write(output);
