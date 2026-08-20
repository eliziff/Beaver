import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import expected from "./installed-provider-baseline.json";

type Provider = "a2aj" | "courtlistener" | "journal";
type Count = {
  attempted: number; pass: number; failure: number; source_bytes: number;
  canonical_bytes: number; modes: Record<"native" | "hybrid" | "flat", number>;
};
type RecordRow = Record<string, unknown>;
type Summary = typeof expected & {
  scope: { kind: string };
  shards: Array<{ provider: Provider; shard: number; manifest_root_sha256: string }>;
  providers: Record<Provider, Count & { details: Record<string, number> }>;
};

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  if (!process.argv[index]?.startsWith("--") || !process.argv[index + 1]) {
    throw new Error("Expected --receipt <directory>");
  }
  args.set(process.argv[index].slice(2), process.argv[index + 1]);
}
const receipt = path.resolve(args.get("receipt") ?? path.join(
  __dirname, "results", "installed-provider-freeze-full",
));
const hash = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
const hex = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const allowed = new Set([
  "v", "provider", "source_id", "source_kind", "source_bytes", "source_sha256",
  "status", "mode", "canonical_bytes", "canonical_sha256", "blocks", "failure",
  "error_sha256", "final_contract", "contract_validation", "contract_source_bytes",
  "contract_source_sha256", "contract_pages", "contract_alias", "page_rows",
]);
const empty = (): Count => ({
  attempted: 0, pass: 0, failure: 0, source_bytes: 0, canonical_bytes: 0,
  modes: { native: 0, hybrid: 0, flat: 0 },
});
const fail = (message: string): never => { throw new Error(message); };
const same = (left: unknown, right: unknown, label: string) => {
  if (JSON.stringify(left) !== JSON.stringify(right)) fail(`${label} drift`);
};

const summaryFile = path.join(receipt, "summary.json");
for (const [name, digest] of Object.entries(expected.reproduction_harness_sha256)) {
  same(hash(readFileSync(path.join(__dirname, name))), digest, `reproduction harness ${name}`);
}
const summaryBytes = readFileSync(summaryFile);
if (summaryBytes.length > 64 * 1024) fail("Phase summary exceeds 64 KiB");
const summary = JSON.parse(summaryBytes.toString("utf8")) as Summary;
for (const key of [
  "baseline_commit", "serializer_contract_sha256", "manifest_root_sha256",
  "artifact_bytes", "wall_ms", "processing_wall_ms", "measured_mib_s_x1000",
] as const) same(summary[key], expected[key], key);
same(summary.inventory, expected.inventory, "inventory");
if (summary.scope?.kind !== "full") fail("Receipt is not a full run");
if (summaryBytes.toString("utf8").match(/[A-Za-z]:[\\/]|\/Users\/|\/home\//u)) {
  fail("Private path leaked into phase summary");
}

const observed: Record<Provider, Count> = {
  a2aj: empty(), courtlistener: empty(), journal: empty(),
};
let artifactBytes = 0;
const shardRoots: string[] = [];
for (const shard of summary.shards) {
  const directory = path.join(receipt, shard.provider, String(shard.shard));
  const shardSummary = JSON.parse(readFileSync(path.join(directory, "summary.json"), "utf8")) as {
    baseline_commit: string; serializer_contract_sha256: string;
    manifest_root_sha256: string;
    parts: Array<{ name: string; rows: number; bytes: number; sha256: string }>;
  };
  same(shardSummary.baseline_commit, expected.baseline_commit, "shard baseline");
  same(shardSummary.serializer_contract_sha256, expected.serializer_contract_sha256,
    "shard serializer");
  same(hash(JSON.stringify(shardSummary.parts)), shardSummary.manifest_root_sha256,
    "shard manifest root");
  same(shardSummary.manifest_root_sha256, shard.manifest_root_sha256,
    "declared shard root");
  shardRoots.push(shardSummary.manifest_root_sha256);
  same(readdirSync(path.join(directory, "parts")).sort(),
    shardSummary.parts.map(({ name }) => name).sort(), "declared part inventory");
  for (const part of shardSummary.parts) {
    const filename = path.join(directory, "parts", part.name);
    const compressed = readFileSync(filename);
    if (compressed.length !== part.bytes || hash(compressed) !== part.sha256) {
      fail(`Corrupt part ${shard.provider}/${shard.shard}/${part.name}`);
    }
    artifactBytes += compressed.length;
    const lines = gunzipSync(compressed).toString("utf8").trim().split(/\r?\n/gu).filter(Boolean);
    if (lines.length !== part.rows) fail(`Row count drift in ${part.name}`);
    for (const line of lines) {
      const row = JSON.parse(line) as RecordRow;
      const keys = Object.keys(row);
      if (keys.some((key) => !allowed.has(key))) fail(`Unexpected manifest field in ${part.name}`);
      if (keys.some((key) => /(?:text|markup|path|dir|file|url)/iu.test(key))) {
        fail(`Raw or path-bearing field in ${part.name}`);
      }
      const recordProvider = row.provider === "journal-final-contract" ? "journal" : row.provider;
      if (recordProvider !== shard.provider || !/^\d+$/u.test(String(row.source_id)) ||
        !hex(row.source_sha256) || !Number.isSafeInteger(row.source_bytes)) {
        fail(`Invalid identity/source proof in ${part.name}`);
      }
      const state = observed[shard.provider];
      state.attempted += 1;
      state.source_bytes += Number(row.source_bytes);
      if (row.status === "pass") {
        if (!hex(row.canonical_sha256) || !Number.isSafeInteger(row.canonical_bytes) ||
          !["native", "hybrid", "flat"].includes(String(row.mode))) {
          fail(`Invalid public-output proof in ${part.name}`);
        }
        state.pass += 1;
        state.canonical_bytes += Number(row.canonical_bytes);
        const mode = row.mode as keyof Count["modes"];
        state.modes[mode] += 1;
      } else if (row.status === "failure" && typeof row.failure === "string" &&
        hex(row.error_sha256)) state.failure += 1;
      else fail(`Invalid status proof in ${part.name}`);
    }
  }
}
same(hash(JSON.stringify(shardRoots)), expected.manifest_root_sha256, "root manifest");
same(artifactBytes, expected.artifact_bytes, "artifact bytes");
if (artifactBytes > 40 * 1024 * 1024) fail("Manifest exceeds 40 MiB");
for (const provider of Object.keys(observed) as Provider[]) {
  const state = observed[provider];
  if (state.attempted !== state.pass + state.failure ||
    state.pass !== state.modes.native + state.modes.hybrid + state.modes.flat) {
    fail(`${provider} denominator equation failed`);
  }
  same(state, expected.providers[provider], `${provider} frozen totals`);
  same(summary.providers[provider].details.measured_mib_s_x1000,
    provider === "a2aj" ? 26210 : provider === "courtlistener" ? 19980 : 106558,
    `${provider} throughput`);
}
for (const [key, value] of Object.entries(expected.journal_proof)) {
  same(summary.providers.journal.details[key], value, `journal ${key}`);
}
if (readdirSync(receipt).some((name) => name.endsWith(".tmp")) ||
  statSync(summaryFile).size !== summaryBytes.length) fail("Incomplete atomic receipt");
console.log(JSON.stringify({
  ok: true, manifest_root_sha256: expected.manifest_root_sha256,
  attempted: Object.values(observed).reduce((sum, state) => sum + state.attempted, 0),
  artifact_bytes: artifactBytes,
}));
