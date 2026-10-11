// Invoke under budget.writer() after require_bytes(16 MiB), as the acquisition owner.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';

const base = process.argv[2] || 'benchmarks/local-data/courtlistener-renditions/broad';
const receiptPath = path.join(base, 'continuation-receipt.json');
const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
const boundary = receipt.execution_boundaries.at(-1);
const source = JSON.parse(fs.readFileSync(path.join(base, 'source.json'), 'utf8'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function requireValue(condition, message) {
  if (!condition) throw Error(message);
}

const requestedOrdinal = process.argv[3] === undefined ? undefined : Number(process.argv[3]);
const ordinal = requestedOrdinal ?? boundary.first_possible_new_part_count - 1;
const part = source.parts.find(value => value.ordinal === ordinal);
const producer = boundary.producer_phases?.at(-1) ?? boundary;
requireValue(Number.isSafeInteger(ordinal) && part && ordinal >= boundary.first_possible_new_part_count - 1
  && source.parts.length >= boundary.first_possible_new_part_count
  && (requestedOrdinal !== undefined || source.parts.length === boundary.first_possible_new_part_count),
  'Requested committed source boundary differs');
const frozenBytes = fs.readFileSync(boundary.source_manifest_before_path ?? path.join(base, 'checkpoint-source.json'));
const frozen = JSON.parse(frozenBytes);
requireValue(hash(frozenBytes) === boundary.source_manifest_before_sha256, 'Verified source prefix identity differs');
requireValue(frozen.parts.length === boundary.first_possible_new_part_count - 1
  && JSON.stringify(source.parts.slice(0, frozen.parts.length)) === JSON.stringify(frozen.parts), 'Verified source parts changed');
requireValue(JSON.stringify(source.exclusions) === JSON.stringify(frozen.exclusions), 'Retained source exclusions changed');
if (producer.first_part_ordinal !== undefined) {
  const phaseBytes = fs.readFileSync(producer.source_manifest_before_path);
  const phasePrefix = JSON.parse(phaseBytes);
  requireValue(ordinal >= producer.first_part_ordinal
    && hash(phaseBytes) === producer.source_manifest_before_sha256
    && phasePrefix.parts.length === producer.first_part_ordinal
    && JSON.stringify(source.parts.slice(0, phasePrefix.parts.length)) === JSON.stringify(phasePrefix.parts),
    'Active compiled producer prefix differs');
}
const directory = path.join(base, part.path);
const indexBytes = fs.readFileSync(path.join(directory, 'index.json'));
const index = JSON.parse(indexBytes);
const indexHash = hash(indexBytes);
requireValue(indexHash === part.index_sha256, 'Part index SHA mismatch');
const cacheBytes = fs.readFileSync(path.join(directory, 'cluster-membership.json'));
const cache = JSON.parse(cacheBytes);
requireValue(cache.schema === 'courtlistener.cluster-membership.v1'
  && cache.index_sha256 === indexHash && cache.rows === index.rows, 'Membership cache identity differs');
const acquired = part.acquired_source_jsonl;
requireValue(acquired && acquired.rows === index.rows && acquired.bytes === index.raw_bytes
  && acquired.source_fields_per_row === source.source.columns.length, 'Original acquired JSONL receipt differs');
requireValue(hash(fs.readFileSync(boundary.executable)) === producer.executable_sha256, 'Packer executable identity differs');
const expectedIds = new Set(index.frames.flatMap(frame => frame.ids));
const ids = new Set(), clusterIds = new Set(), missing = [];
const decodedHash = crypto.createHash('sha256');
let decodedBytes = 0, rows = 0, offset = 0;
const packedPath = path.join(directory, 'opinions.jsonl.zst');
requireValue(fs.statSync(packedPath).size === index.compressed_bytes, 'Persisted compressed byte count differs');
const handle = fs.openSync(packedPath, 'r');
try {
  // Reuse account-components.mjs's bounded, independently verified frame reader.
  for (const frame of index.frames) {
    requireValue(frame.offset === offset && frame.bytes > 0 && frame.raw_bytes > 0, 'Frame index is discontinuous');
    const compressed = Buffer.alloc(frame.bytes);
    requireValue(fs.readSync(handle, compressed, 0, compressed.length, offset) === compressed.length, 'Compressed frame is truncated');
    const raw = zstdDecompressSync(compressed);
    requireValue(raw.length === frame.raw_bytes && hash(raw) === frame.sha256, 'Reopened frame bytes/digest differ');
    decodedHash.update(raw); decodedBytes += raw.length;
    let start = 0, frameRows = 0;
    while (start < raw.length) {
      const end = raw.indexOf(10, start);
      requireValue(end >= start, 'Original JSONL delimiter is missing');
      const record = JSON.parse(raw.subarray(start, end).toString('utf8')), opinion = record.opinion;
      requireValue(record.range_index === part.ordinal, 'Source range identity differs');
      const keys = Object.keys(opinion);
      requireValue(keys.length === source.source.columns.length
        && source.source.columns.every(column => Object.hasOwn(opinion, column)), 'Source field keys changed');
      requireValue(source.source.columns.every(column => opinion[column] === null
        || typeof opinion[column] === 'string'), 'Original field scalar types changed');
      requireValue(typeof opinion.id === 'string' && expectedIds.has(opinion.id)
        && !ids.has(opinion.id), 'Restored opinion identity differs');
      requireValue(opinion.id === frame.ids[frameRows], 'Ordered frame ID membership differs');
      ids.add(opinion.id); rows++;
      if (typeof opinion.cluster_id === 'string' && opinion.cluster_id.length) clusterIds.add(opinion.cluster_id);
      else missing.push(opinion.id);
      start = end + 1; frameRows++;
    }
    requireValue(frameRows === frame.ids.length, 'Frame ID count differs');
    offset += frame.bytes;
  }
} finally {
  fs.closeSync(handle);
}
requireValue(offset === index.compressed_bytes, 'Frame index does not cover the complete persisted pack');
const reopenedHash = decodedHash.digest('hex');
requireValue(decodedBytes === acquired.bytes && reopenedHash === acquired.sha256,
  'Reopened source bytes differ from independently submitted original CSV-derived values');
requireValue(rows === part.rows && rows === index.rows && ids.size === expectedIds.size, 'Restored source membership differs');
missing.sort();
requireValue(JSON.stringify([...clusterIds].sort()) === JSON.stringify(cache.cluster_ids)
  && JSON.stringify(missing) === JSON.stringify(cache.opinions_missing_cluster_id), 'Cache membership differs from original values');
const logBytes = fs.readFileSync(path.join(base, boundary.stdout_log));
const log = logBytes.toString(logBytes[0] === 255 && logBytes[1] === 254 ? 'utf16le' : 'utf8');
const byteProof = log.split(/\r?\n/).filter(line => line.startsWith('{')).some(line => {
  try {
    const value = JSON.parse(line);
    return value.rows === rows && value.raw_bytes === index.raw_bytes
      && value.compressed_bytes === index.compressed_bytes && value.every_source_byte_verified === true;
  } catch { return false; }
});
requireValue(byteProof, 'Packer source byte proof is missing');
const allocations = source.budget_allocations, expected = boundary.budget_allocations;
requireValue(source.disk_cap_bytes === 45_000_000_000 && allocations.physical_free_space_protected === true,
  'Guarded physical/shared cap differs');
requireValue(expected && ['working_reserve_bytes', 'minimum_available_bytes', 'outstanding_browser_bytes',
  'outstanding_output_bytes'].every(key => allocations[key] === expected[key]), 'Reviewed allocation differs');
const budget = part.budget;
const reserved = allocations.working_reserve_bytes + allocations.outstanding_browser_bytes + allocations.outstanding_output_bytes;
requireValue(budget.logical_available_bytes === source.disk_cap_bytes - budget.pre_pack_occupied_bytes
  - budget.metadata_growth_bytes - reserved, 'Logical admission arithmetic differs');
requireValue(budget.physical_available_bytes === budget.physical_free_bytes - budget.metadata_growth_bytes - reserved,
  'Physical admission arithmetic differs');
requireValue(budget.available_bytes === Math.min(budget.logical_available_bytes, budget.physical_available_bytes)
  && budget.limiting_budget === (budget.physical_available_bytes < budget.logical_available_bytes ? 'physical_disk' : 'shared_cap'),
  'Effective physical/logical allowance differs');
requireValue(budget.native_maximum_bytes === budget.available_bytes - Math.max(0, budget.sidecar_allowance_bytes - 16 * 1024 * 1024)
  && budget.native_maximum_bytes >= allocations.minimum_available_bytes, 'Prewrite sidecar/admission allowance differs');
const artifactBytes = fs.readdirSync(directory).reduce((sum, name) => {
  const stats = fs.statSync(path.join(directory, name)); return sum + (stats.isFile() ? stats.size : 0);
}, 0);
requireValue(artifactBytes === budget.part_artifact_bytes && budget.actual_sidecar_bytes === artifactBytes - index.compressed_bytes
  && budget.actual_sidecar_bytes <= budget.sidecar_allowance_bytes && artifactBytes <= budget.available_bytes,
  'Actual native artifact bounds differ');
const proof = {
  part: part.path, ordinal: part.ordinal, rows, source_fields_per_row: source.source.columns.length,
  source_field_values: rows * source.source.columns.length, original_acquired_jsonl: acquired,
  reopened_jsonl: { sha256: reopenedHash, bytes: decodedBytes },
  every_original_field_value_preserved_by_exact_byte_comparison: true,
  every_indexed_frame_bytes_digest_and_ordered_ids_verified: true, verified_frames: index.frames.length,
  comparison_scope: 'Acquired original CSV-derived input versus reopened new native pack; no CSV re-download or old-prefix inflation',
  verified_prefix_parts_reused: frozen.parts.length, verified_prefix_manifest_sha256: hash(frozenBytes),
  original_exclusions_unchanged: true, index_sha256: indexHash, cache_sha256: hash(cacheBytes),
  cache_membership_independently_matches_restored_source: true, unique_cluster_ids: clusterIds.size,
  opinions_missing_cluster_id: missing.length, native_pack_log_reports_every_source_byte_verified: true,
  budget: { cap_bytes: source.disk_cap_bytes, allocations, actual_pre_pack_budget: budget,
    artifact_bytes_independently_counted: artifactBytes, prewrite_sidecar_allowance_verified: true,
    physical_and_logical_admission_verified: true },
  verifier_source_sha256: hash(fs.readFileSync(new URL(import.meta.url))), completed_at: new Date().toISOString()
};
proof.compiled_producer = { phase: producer.phase ?? 'launch', executable: boundary.executable,
  executable_sha256: producer.executable_sha256,
  compiled_source: producer.compiled_source ?? { query_source_sha256: boundary.root_named_query_source_sha256 },
  compiled_source_summary: producer.compiled_source_summary ?? boundary.root_actual_source_query_proofs };
if (ordinal === boundary.first_possible_new_part_count - 1) boundary.first_new_part_verification = proof;
boundary.verified_new_parts ??= [];
requireValue(!boundary.verified_new_parts.some(value => value.ordinal === ordinal), 'Source part was already independently verified');
boundary.verified_new_parts.push(proof); receipt.last_progress_at = proof.completed_at;
const data = JSON.stringify(receipt, null, 2) + '\n';
requireValue(Buffer.byteLength(data) <= 16 * 1024 * 1024, 'Receipt exceeds guarded publication allowance');
const pending = receiptPath + '.pending', fd = fs.openSync(pending, 'wx');
try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
fs.renameSync(pending, receiptPath);
process.stdout.write(JSON.stringify(proof) + '\n');
