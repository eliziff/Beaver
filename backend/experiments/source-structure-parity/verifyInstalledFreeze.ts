import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import expected from "./installed-provider-baseline.json";

type Provider = "a2aj" | "courtlistener" | "journal";
type Row = Record<string, unknown>;
type Part = { name: string; rows: number; bytes: number; sha256: string };
type Summary = {
  scope?: { kind: string };
  inventory: typeof expected.inventory;
  serializer_contract_sha256: string;
  manifest_root_sha256: string;
  providers: Record<Provider, { attempted: number }>;
  shards?: Array<{ provider: Provider; shard: number; manifest_root_sha256: string }>;
  parts?: Part[];
  engine?: { binary_sha256: string };
  harness_sha256?: string;
  adapter_code_sha256?: string;
};
type Receipt = { root: string; summary: Summary; parallel: boolean };

const args = new Map<string, string>();
for (let at = 2; at < process.argv.length; at += 2) {
  if (!process.argv[at]?.startsWith("--") || !process.argv[at + 1]) {
    throw new Error("Expected --candidate <directory> [--baseline <directory>] [--only-id <id>] [--report <file>]");
  }
  args.set(process.argv[at].slice(2), process.argv[at + 1]);
}
const candidateRoot = path.resolve(args.get("candidate") ?? args.get("receipt") ?? "");
if (!candidateRoot) throw new Error("Candidate receipt is required");
const baselineRoot = path.resolve(args.get("baseline") ?? path.join(
  __dirname, "results", "installed-provider-freeze-full",
));
const onlyId = args.get("only-id");
const reportPath = args.get("report");
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const fail = (message: string): never => { throw new Error(message); };
const same = (left: unknown, right: unknown, label: string) => {
  if (JSON.stringify(left) !== JSON.stringify(right)) fail(`${label} drift`);
};
const hex = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

function summaryFile(filename: string) {
  const bytes = readFileSync(filename);
  if (bytes.length > 64 * 1024 || bytes.toString("utf8").match(/[A-Za-z]:[\\/]|\/Users\/|\/home\//u)) {
    fail(`Invalid or path-bearing summary: ${path.basename(path.dirname(filename))}`);
  }
  return JSON.parse(bytes.toString("utf8")) as Summary;
}
function receipt(root: string): Receipt {
  const summary = summaryFile(path.join(root, "summary.json"));
  const parallel = Array.isArray(summary.shards);
  if (parallel ? !summary.shards!.length : !summary.parts?.length) fail("Receipt has no parts");
  same(hash(JSON.stringify(parallel
    ? summary.shards!.map(({ manifest_root_sha256 }) => manifest_root_sha256)
    : summary.parts)), summary.manifest_root_sha256, "receipt root manifest");
  return { root, summary, parallel };
}
const receipts = { baseline: receipt(baselineRoot), candidate: receipt(candidateRoot) };
if (candidateRoot !== baselineRoot && (!receipts.candidate.summary.engine ||
    !receipts.candidate.summary.harness_sha256 || !receipts.candidate.summary.adapter_code_sha256)) {
  fail("Candidate provenance is incomplete");
}
for (const value of Object.values(receipts)) {
  same(value.summary.serializer_contract_sha256,
    expected.serializer_contract_sha256, "serializer contract");
}
if (receipts.baseline.summary.scope?.kind !== "full") fail("Authoritative full baseline required");
same(receipts.baseline.summary.inventory, expected.inventory, "frozen inventory");
same(receipts.baseline.summary.manifest_root_sha256,
  expected.manifest_root_sha256, "frozen manifest root");

function partRows(directory: string, parts: Part[], provider?: Provider) {
  return function* () {
    same(readdirSync(path.join(directory, "parts")).sort(),
      parts.map(({ name }) => name).sort(), "declared part inventory");
    for (const part of parts) {
      const compressed = readFileSync(path.join(directory, "parts", part.name));
      if (compressed.length !== part.bytes || hash(compressed) !== part.sha256) {
        fail(`Corrupt part ${part.name}`);
      }
      const lines = gunzipSync(compressed).toString("utf8").trim()
        .split(/\r?\n/gu).filter(Boolean);
      if (lines.length !== part.rows) fail(`Row count drift in ${part.name}`);
      for (const line of lines) {
        const row = JSON.parse(line) as Row;
        const rowProvider = row.provider === "journal-final-contract" ? "journal" : row.provider;
        if (!/^[0-9]+$/u.test(String(row.source_id)) || !hex(row.source_sha256) ||
            !Number.isSafeInteger(row.source_bytes) ||
            Object.keys(row).some((key) => /(?:text|markup|path|dir|file|url)/iu.test(key))) {
          fail(`Invalid or raw/path-bearing row in ${part.name}`);
        }
        if (row.status === "pass" ? (!hex(row.canonical_sha256) ||
            !Number.isSafeInteger(row.canonical_bytes) || !Number.isSafeInteger(row.blocks) ||
            !["native", "hybrid", "flat"].includes(String(row.mode)))
          : row.status !== "failure" || typeof row.failure !== "string" || !hex(row.error_sha256)) {
          fail(`Invalid public-output proof in ${part.name}`);
        }
        if ((!provider || rowProvider === provider) && (!onlyId || String(row.source_id) === onlyId)) {
          yield row;
        }
      }
    }
  };
}
function rows(value: Receipt, provider: Provider) {
  if (!value.parallel) {
    same(hash(JSON.stringify(value.summary.parts)), value.summary.manifest_root_sha256,
      "single receipt manifest");
    return partRows(value.root, value.summary.parts!, provider)();
  }
  return (function* () {
    for (const shard of value.summary.shards!.filter((item) => item.provider === provider)
      .sort((left, right) => left.shard - right.shard)) {
      const directory = path.join(value.root, provider, String(shard.shard));
      const child = summaryFile(path.join(directory, "summary.json"));
      same(hash(JSON.stringify(child.parts)), child.manifest_root_sha256, `${provider} shard manifest`);
      same(child.manifest_root_sha256, shard.manifest_root_sha256, `${provider} declared shard`);
      if (value.summary.engine) {
        same(child.engine?.binary_sha256, value.summary.engine.binary_sha256, `${provider} engine`);
        same(child.harness_sha256, value.summary.harness_sha256, `${provider} harness`);
        same(child.adapter_code_sha256, value.summary.adapter_code_sha256, `${provider} adapter`);
      }
      yield* partRows(directory, child.parts!, provider)();
    }
  })();
}

const SIGNATURES: Record<Provider, Array<keyof typeof expected.inventory.signatures>> = {
  a2aj: ["a2aj", "a2aj-search"],
  courtlistener: ["courtlistener"],
  journal: ["journal", "journal-final"],
};
const PUBLIC = ["source_kind", "status", "mode", "canonical_bytes", "canonical_sha256",
  "blocks", "failure", "error_sha256"] as const;
const CONTRACT = ["final_contract", "contract_validation", "contract_source_bytes",
  "contract_source_sha256", "contract_pages", "contract_alias"] as const;
const QUALITY_INPUT = ["source_bytes", "source_sha256", "page_rows", ...CONTRACT] as const;
const JOURNAL_1_DELTA = {
  input: { source_bytes: 3815977,
    source_sha256: "1cd4839a3661e386073e851eb5160f58ba794fcc2134048772d574b0a3d32f6d",
    page_rows: 0, final_contract: "applicable", contract_validation: "applicable",
    contract_source_bytes: 3814595,
    contract_source_sha256: "c69c8e5617e00e2848d7d52b6c88bf3e7d2106bf16375886dd184debd4066141",
    contract_pages: 47, contract_alias: true },
  baseline: { source_kind: "article", status: "failure", mode: null,
    canonical_bytes: null, canonical_sha256: null, blocks: null,
    failure: "provider_unavailable",
    error_sha256: "d50357833a0f823e13823ab71f960a6a6ae5a2106c811f17abf7b2d97fecf230" },
  current: { source_kind: "article", status: "pass", mode: "native",
    canonical_bytes: 192341,
    canonical_sha256: "fbec8880572e202af50cd6ac35c006e6bb69be4fa46a19d641b8965ea1b596e7",
    blocks: 840, failure: null, error_sha256: null },
  structure_input_sha256: "1585a58b61715e6e3e0faa181d237b80804fb4de5161b4849c70a0e51062e8b5",
} as const;
const selected = (Object.keys(receipts.candidate.summary.providers) as Provider[])
  .filter((provider) => receipts.candidate.summary.providers[provider].attempted > 0);
if (!selected.length) fail("Candidate has no provider rows");
const counters = { compared: 0, exact_input: 0, raw_proof_contract_mismatch: 0,
  structure_input_proof_unpaired: 0, structure_input_drift: 0,
  authorized_quality_delta: 0 };
const drift: Array<{ provider: Provider; source_id: string; old_sha256: string | null;
  new_sha256: string | null }> = [];
type PublicDrift = {
  provider: Provider;
  source_id: string;
  source_kind: string;
  source_proof_equal: boolean;
  structure_input_proof_equal: boolean | null;
  structure_delta: null | { baseline_count: number; candidate_count: number;
    first_index: number; baseline: unknown; candidate: unknown };
  changes: Record<string, { baseline: unknown; candidate: unknown }>;
};
const publicDrifts: PublicDrift[] = [];

function fields(row: Row, names: readonly string[]) {
  return Object.fromEntries(names.map((name) => [name, row[name] ?? null]));
}
function exactPublic(provider: Provider, id: string, old: Row, fresh: Row) {
  for (const name of PUBLIC) same(old[name] ?? null, fresh[name] ?? null,
    `${provider}/${id} public ${name}`);
}
function publicChanges(old: Row, fresh: Row) {
  return Object.fromEntries(PUBLIC.flatMap((name) => {
    const baseline = old[name] ?? null, candidate = fresh[name] ?? null;
    return JSON.stringify(baseline) === JSON.stringify(candidate)
      ? [] : [[name, { baseline, candidate }]];
  }));
}
function recordPublicDrift(provider: Provider, id: string, old: Row, fresh: Row,
  changes: PublicDrift["changes"], pairedStructureProof: boolean) {
  const baseline = Array.isArray(old.structure) ? old.structure : null;
  const candidate = Array.isArray(fresh.structure) ? fresh.structure : null;
  const first = baseline && candidate ? Array.from(
    { length: Math.max(baseline.length, candidate.length) }, (_, index) => index,
  ).find((index) => JSON.stringify(baseline[index]) !== JSON.stringify(candidate[index])) : undefined;
  publicDrifts.push({ provider, source_id: id, source_kind: String(fresh.source_kind),
    source_proof_equal: old.source_bytes === fresh.source_bytes &&
      old.source_sha256 === fresh.source_sha256,
    structure_input_proof_equal: pairedStructureProof
      ? old.structure_input_sha256 === fresh.structure_input_sha256 : null,
    structure_delta: baseline && candidate && first !== undefined ? {
      baseline_count: baseline.length, candidate_count: candidate.length, first_index: first,
      baseline: baseline[first] ?? null, candidate: candidate[first] ?? null,
    } : null,
    changes });
}
function journal1QualityDelta(id: string, old: Row, fresh: Row) {
  if (id !== "1") return false;
  return JSON.stringify(fields(old, QUALITY_INPUT)) === JSON.stringify(JOURNAL_1_DELTA.input) &&
    JSON.stringify(fields(fresh, QUALITY_INPUT)) === JSON.stringify(JOURNAL_1_DELTA.input) &&
    JSON.stringify(fields(old, PUBLIC)) === JSON.stringify(JOURNAL_1_DELTA.baseline) &&
    JSON.stringify(fields(fresh, PUBLIC)) === JSON.stringify(JOURNAL_1_DELTA.current) &&
    fresh.structure_input_sha256 === JOURNAL_1_DELTA.structure_input_sha256;
}
for (const provider of selected) {
  for (const signature of SIGNATURES[provider]) {
    same(receipts.baseline.summary.inventory.signatures[signature],
      receipts.candidate.summary.inventory.signatures[signature], `${provider} inventory ${signature}`);
  }
  if (candidateRoot === baselineRoot) {
    let count = 0;
    for (const _row of rows(receipts.candidate, provider)) count += 1;
    same(count, expected.providers[provider].attempted, `${provider} full denominator`);
    counters.compared += count; counters.exact_input += count;
    continue;
  }
  const oldRows = rows(receipts.baseline, provider), freshRows = rows(receipts.candidate, provider);
  let providerCount = 0;
  for (let old = oldRows.next(), fresh = freshRows.next(); ;
    old = oldRows.next(), fresh = freshRows.next()) {
    if (fresh.done) {
      if (receipts.candidate.summary.scope?.kind === "full" && !old.done) {
        fail(`${provider} denominator mismatch`);
      }
      break;
    }
    if (old.done) fail(`${provider} candidate exceeds baseline denominator`);
    const a = old.value as Row, b = fresh.value as Row;
    const id = String(a.source_id);
    if (`${a.provider}\0${id}` !== `${b.provider}\0${String(b.source_id)}`) {
      fail(`${provider} identity mismatch at ${id}`);
    }
    if (a.source_bytes !== b.source_bytes || a.source_sha256 !== b.source_sha256) {
      counters.raw_proof_contract_mismatch += 1;
    }
    const pairedStructureProof = a.structure_input_sha256 !== undefined &&
      b.structure_input_sha256 !== undefined;
    if (!pairedStructureProof && a.structure_input_sha256 !== b.structure_input_sha256) {
      counters.structure_input_proof_unpaired += 1;
    }
    if (provider !== "journal") {
      const changes = publicChanges(a, b);
      if (pairedStructureProof && a.structure_input_sha256 !== b.structure_input_sha256) {
        changes.structure_input_sha256 = {
          baseline: a.structure_input_sha256, candidate: b.structure_input_sha256,
        };
      }
      if (Object.keys(changes).length) {
        if (!reportPath) exactPublic(provider, id, a, b);
        recordPublicDrift(provider, id, a, b, changes, pairedStructureProof);
      } else counters.exact_input += 1;
    } else {
      same(a.page_rows ?? null, b.page_rows ?? null, `journal/${id} page rows`);
      const oldContract = fields(a, CONTRACT), newContract = fields(b, CONTRACT);
      const exactContract = JSON.stringify(oldContract) === JSON.stringify(newContract);
      if (exactContract) {
        if (journal1QualityDelta(id, a, b)) counters.authorized_quality_delta += 1;
        else {
          const changes = publicChanges(a, b);
          if (pairedStructureProof && a.structure_input_sha256 !== b.structure_input_sha256) {
            changes.structure_input_sha256 = {
              baseline: a.structure_input_sha256, candidate: b.structure_input_sha256,
            };
          }
          if (Object.keys(changes).length) {
            if (!reportPath) exactPublic(provider, id, a, b);
            recordPublicDrift(provider, id, a, b, changes, pairedStructureProof);
          } else counters.exact_input += 1;
        }
      } else {
        counters.structure_input_drift += 1;
        drift.push({ provider, source_id: id,
          old_sha256: typeof a.contract_source_sha256 === "string" ? a.contract_source_sha256 : null,
          new_sha256: typeof b.contract_source_sha256 === "string" ? b.contract_source_sha256 : null });
      }
    }
    providerCount += 1; counters.compared += 1;
  }
  same(providerCount, onlyId ? 1 : receipts.candidate.summary.providers[provider].attempted,
    `${provider} candidate denominator`);
  if (!onlyId && receipts.candidate.summary.scope?.kind === "full") {
    same(providerCount, expected.providers[provider].attempted, `${provider} full denominator`);
  }
}
if (readdirSync(candidateRoot).some((name) => name.endsWith(".tmp")) ||
    statSync(path.join(candidateRoot, "summary.json")).size > 64 * 1024) {
  fail("Incomplete atomic receipt");
}
if (publicDrifts.length) {
  const grouped = new Map<string, { count: number; ids: string[]; shape: unknown }>();
  for (const item of publicDrifts) {
    const blocks = item.changes.blocks;
    const bytes = item.changes.canonical_bytes;
    const shape = {
      provider: item.provider,
      source_kind: item.source_kind,
      changed_fields: Object.keys(item.changes).sort(),
      status: item.changes.status ?? null,
      mode: item.changes.mode ?? null,
      failure: item.changes.failure ?? null,
      blocks_delta: blocks && typeof blocks.baseline === "number" &&
        typeof blocks.candidate === "number" ? blocks.candidate - blocks.baseline : null,
      canonical_bytes_delta: bytes && typeof bytes.baseline === "number" &&
        typeof bytes.candidate === "number" ? bytes.candidate - bytes.baseline : null,
      source_proof_equal: item.source_proof_equal,
      structure_input_proof_equal: item.structure_input_proof_equal,
    };
    const key = JSON.stringify(shape);
    const group = grouped.get(key) ?? { count: 0, ids: [], shape };
    group.count += 1;
    if (group.ids.length < 25) group.ids.push(item.source_id);
    grouped.set(key, group);
  }
  const report = {
    schema_version: "source-structure-parity-diagnostics.v1",
    baseline_manifest_sha256: receipts.baseline.summary.manifest_root_sha256,
    candidate_manifest_sha256: receipts.candidate.summary.manifest_root_sha256,
    mismatches: publicDrifts.length,
    groups: [...grouped.values()].sort((left, right) => right.count - left.count),
    rows: publicDrifts,
  };
  if (reportPath) {
    const filename = path.resolve(reportPath);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, `${JSON.stringify(report)}\n`);
    fail(`${publicDrifts.length} public-output mismatches; diagnostics written to ${filename}`);
  }
  fail(`${publicDrifts.length} public-output mismatches`);
}
console.log(JSON.stringify({ ok: true, ...counters,
  provider_counts: Object.fromEntries(selected.map((provider) =>
    [provider, onlyId ? 1 : receipts.candidate.summary.providers[provider].attempted])),
  raw_proof_taxonomy: "different framing is diagnostic only after exact installed inventory proof",
  structure_input_drift_rows: drift.slice(0, 25),
  structure_input_drift_sha256: hash(JSON.stringify(drift)),
  structure_input_drift_truncated: Math.max(0, drift.length - 25),
  candidate_manifest_sha256: receipts.candidate.summary.manifest_root_sha256,
}));
