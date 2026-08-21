import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setBelowNormalProcessPriority, type StructurePriorityReceipt } from "../../src/lib/structureEngineClient";
import expected from "./installed-provider-baseline.json";

type Provider = "a2aj" | "courtlistener" | "journal";
type Counts = {
  attempted: number; pass: number; failure: number; source_bytes: number;
  canonical_bytes: number; modes: Record<"native" | "hybrid" | "flat", number>;
  details: Record<string, number>; elapsed_ms?: number; warmup_ms?: number;
  warmup_bytes?: number;
};
type ShardSummary = {
  baseline_commit: string;
  serializer_contract_sha256: string;
  inventory: typeof expected.inventory;
  providers: Record<Provider, Counts>;
  parts: Array<{ name: string; bytes: number; sha256: string }>;
  manifest_root_sha256: string;
  engine: { startup_ms: number; batches: number; documents: number; request_bytes: number;
    binary_sha256: string; capabilities: string[]; priority: StructurePriorityReceipt };
  harness_sha256: string; adapter_code_sha256: string; peak_rss_bytes: number;
};

const runPriority = setBelowNormalProcessPriority();
process.env.STRUCTURE_ENGINE_BELOW_NORMAL = "1";
const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) args.set(key.slice(2), "1");
  else { args.set(key.slice(2), value); index += 1; }
}
const output = path.resolve(args.get("output") ?? path.join(
  __dirname, "results", "installed-provider-freeze-candidate",
));
const workers = Number(args.get("workers") ?? 1);
if (!Number.isInteger(workers) || workers < 1 || workers > 8) {
  throw new Error("workers must be an integer from 1 through 8");
}
const requiredMib = Math.max(0, Number(args.get("require-mib-s") ?? 50));
const maxWallMs = Math.max(1, Number(args.get("max-wall-ms") ?? 600_000));
const limit = Math.max(0, Number(args.get("limit") ?? 0));
const runner = path.join(__dirname, "freezeInstalledProviders.ts");
const providers = (args.get("providers") ?? "a2aj,courtlistener,journal")
  .split(",")
  .filter((value): value is Provider =>
    ["a2aj", "courtlistener", "journal"].includes(value),
  );
if (!providers.length) throw new Error("At least one installed provider is required");
mkdirSync(output, { recursive: true });

function atomicJson(filename: string, value: unknown) {
  const temporary = `${filename}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, filename);
}
function hash(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}
function inventoryProof(value: typeof expected.inventory) {
  return providers.map((provider) => provider === "a2aj"
    ? [provider, value.a2aj, value.signatures.a2aj, value.signatures["a2aj-search"]]
    : provider === "courtlistener"
      ? [provider, value.courtlistener, value.signatures.courtlistener]
      : [provider, value.journal, value.signatures.journal, value.signatures["journal-final"]]);
}
function forwarded(provider: Provider) {
  return ["a2aj-db", "courtlistener-db", "journal-db", "journal-final-db",
    "journal-contract-root", "limit"]
    .flatMap((key) => args.has(key) ? [`--${key}`, args.get(key)!] : [])
    .concat(["--batch", args.get(`${provider}-batch`) ?? args.get("batch") ??
      (provider === "journal" ? "25" : "1000")])
    .concat(args.has("retain-structure") ? ["--retain-structure"] : []);
}
function child(provider: Provider, shard: number) {
  const shardOutput = path.join(output, provider, String(shard));
  const childArgs = [
    "--import", "tsx", runner,
    "--providers", provider,
    "--shard-count", String(workers),
    "--shard-index", String(shard),
    "--warmup-rows", String(Number(args.get("warmup-rows") ?? 25)),
    "--output", shardOutput,
    ...forwarded(provider),
  ];
  return new Promise<void>((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, childArgs, {
      cwd: path.resolve(__dirname, "../.."), windowsHide: true,
      env: { ...globalThis.process.env, STRUCTURE_ENGINE_BELOW_NORMAL: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    process.stdout.setEncoding("utf8");
    process.stderr.setEncoding("utf8");
    process.stdout.on("data", (chunk: string) => {
      for (const line of chunk.trim().split(/\r?\n/gu).filter(Boolean)) {
        if (/^(?:a2aj|courtlistener|journal) \d+\//u.test(line)) {
          console.log(`${provider}[${shard}] ${line}`);
        }
      }
    });
    process.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
    process.on("error", reject);
    process.on("exit", (code) => code === 0 ? resolve() : reject(new Error(
      `${provider}[${shard}] exited ${code}: ${stderr.slice(-2_000)}`,
    )));
  });
}

async function main() {
const wallMs: Record<Provider, number> = { a2aj: 0, courtlistener: 0, journal: 0 };
const runStarted = performance.now();
for (const provider of providers) {
  const started = performance.now();
  await Promise.all(Array.from({ length: workers }, (_value, shard) => child(provider, shard)));
  wallMs[provider] = performance.now() - started;
}
const summaries = providers.flatMap((provider) =>
  Array.from({ length: workers }, (_value, shard) => {
    const directory = path.join(output, provider, String(shard));
    const summary = JSON.parse(readFileSync(path.join(directory, "summary.json"), "utf8")) as ShardSummary;
    for (const part of summary.parts) {
      const actual = hash(readFileSync(path.join(directory, "parts", part.name)));
      if (actual !== part.sha256) throw new Error(`${provider}[${shard}] corrupt part ${part.name}`);
    }
    return { provider, shard, directory, summary };
  }),
);
const first = summaries[0].summary;
if (summaries.some(({ summary }) => summary.engine.priority.class !== "BELOW_NORMAL" ||
    summary.engine.priority.parent_priority !== runPriority.priority ||
    summary.engine.priority.child_priority !== runPriority.priority)) {
  throw new Error("A provider sidecar did not prove BELOW_NORMAL priority");
}
if (hash(JSON.stringify(inventoryProof(first.inventory))) !==
    hash(JSON.stringify(inventoryProof(expected.inventory)))) {
  throw new Error("Installed corpus inventory differs from the frozen baseline");
}
const processingMs: Record<Provider, number> = { a2aj: 0, courtlistener: 0, journal: 0 };
const measuredSourceBytes: Record<Provider, number> = { a2aj: 0, courtlistener: 0, journal: 0 };
const aggregate = Object.fromEntries(providers.map((provider) => {
  const state: Counts = {
    attempted: 0, pass: 0, failure: 0, source_bytes: 0, canonical_bytes: 0,
    modes: { native: 0, hybrid: 0, flat: 0 }, details: {},
  };
  for (const item of summaries.filter((summary) => summary.provider === provider)) {
    if (item.summary.baseline_commit !== first.baseline_commit ||
      item.summary.serializer_contract_sha256 !== first.serializer_contract_sha256 ||
      item.summary.engine.binary_sha256 !== first.engine.binary_sha256 ||
      item.summary.harness_sha256 !== first.harness_sha256 ||
      item.summary.adapter_code_sha256 !== first.adapter_code_sha256 ||
      hash(JSON.stringify(inventoryProof(item.summary.inventory))) !==
        hash(JSON.stringify(inventoryProof(first.inventory)))) {
      throw new Error(`${provider}[${item.shard}] contract or inventory drift`);
    }
    const shard = item.summary.providers[provider];
    processingMs[provider] = Math.max(
      processingMs[provider], (shard.elapsed_ms ?? 0) - (shard.warmup_ms ?? 0),
    );
    measuredSourceBytes[provider] += shard.source_bytes - (shard.warmup_bytes ?? 0);
    if (shard.attempted !== shard.pass + shard.failure) {
      throw new Error(`${provider}[${item.shard}] attempted != pass + failure`);
    }
    if (shard.pass !== shard.modes.native + shard.modes.hybrid + shard.modes.flat) {
      throw new Error(`${provider}[${item.shard}] pass != native + hybrid + flat`);
    }
    for (const key of ["attempted", "pass", "failure", "source_bytes", "canonical_bytes"] as const) {
      state[key] += shard[key];
    }
    for (const mode of ["native", "hybrid", "flat"] as const) state.modes[mode] += shard.modes[mode];
    for (const [key, value] of Object.entries(shard.details)) {
      if (key !== "measured_mib_s_x1000") state.details[key] = (state.details[key] ?? 0) + value;
    }
  }
  const fullExpected = provider === "a2aj" ? first.inventory.a2aj.total
    : provider === "courtlistener" ? first.inventory.courtlistener.opinions
      : first.inventory.journal.articles + first.inventory.journal.orphan_final_contracts;
  const expected = limit ? Math.min(fullExpected, limit * workers) : fullExpected;
  if (state.attempted !== expected) throw new Error(`${provider} incomplete ${state.attempted}/${expected}`);
  if (state.pass !== state.modes.native + state.modes.hybrid + state.modes.flat) {
    throw new Error(`${provider} pass != native + hybrid + flat`);
  }
  const mib = measuredSourceBytes[provider] / 1048576 / (processingMs[provider] / 1_000);
  state.details.cold_wall_ms = Math.round(wallMs[provider]);
  state.details.processing_wall_ms = Math.round(processingMs[provider]);
  state.details.measured_mib_s_x1000 = Math.round(mib * 1_000);
  return [provider, state];
})) as Record<Provider, Counts>;
const artifactBytes = summaries.reduce((sum, item) =>
  sum + item.summary.parts.reduce((partSum, part) => partSum + part.bytes, 0), 0);
if (!limit && providers.includes("journal")) {
  const journal = aggregate.journal;
  const matchedContracts = first.inventory.journal.final_contracts -
    first.inventory.journal.orphan_final_contracts;
  const contractStates = (journal.details.contract_applicable ?? 0) +
    (journal.details.contract_invalid ?? 0) +
    (journal.details.contract_unresolved ?? 0);
  const providerFinalStates = (journal.details.final_none ?? 0) +
    (journal.details.final_applicable ?? 0) +
    (journal.details.final_invalid ?? 0) +
    (journal.details.final_unresolved ?? 0);
  if (journal.details.contract_proofs !== first.inventory.journal.final_contracts ||
    contractStates !== first.inventory.journal.final_contracts ||
    journal.details.contract_aliases !== matchedContracts ||
    journal.details.contract_standalone !== first.inventory.journal.orphan_final_contracts ||
    providerFinalStates !== journal.attempted) {
    throw new Error("Journal native-contract proof denominator is incomplete");
  }
}
const totalSourceBytes = providers.reduce((sum, provider) => sum + measuredSourceBytes[provider], 0);
const totalWallMs = performance.now() - runStarted;
const totalProcessingMs = Math.max(...providers.map((provider) => processingMs[provider]));
const projectedWallMs = Math.max(...providers.map((provider) =>
  expected.providers[provider].source_bytes / 1048576 /
  (aggregate[provider].details.measured_mib_s_x1000 / 1_000) * 1_000));
const projectedMib = providers
  .reduce((sum, provider) => sum + expected.providers[provider].source_bytes, 0) / 1048576 /
  (projectedWallMs / 1_000);
const summary = {
  schema_version: "source-structure-installed-freeze.parallel.v1",
  baseline_commit: first.baseline_commit,
  serializer_contract_sha256: first.serializer_contract_sha256,
  inventory: first.inventory,
  scope: limit ? { kind: "cross-shard-sample", rows_per_shard: limit } : { kind: "full" },
  workers,
  providers: aggregate,
  shards: summaries.map(({ provider, shard, summary }) => ({
    provider, shard, manifest_root_sha256: summary.manifest_root_sha256,
  })),
  manifest_root_sha256: hash(JSON.stringify(summaries.map(({ summary }) =>
    summary.manifest_root_sha256))),
  artifact_bytes: artifactBytes,
  wall_ms: Math.round(totalWallMs),
  processing_wall_ms: Math.round(totalProcessingMs),
  projected_full_wall_ms: Math.round(projectedWallMs),
  projected_full_mib_s_x1000: Math.round(projectedMib * 1_000),
  engine: {
    binary_sha256: first.engine.binary_sha256,
    capabilities: first.engine.capabilities,
    priority: { orchestrator: runPriority,
      sidecars: summaries.map(({ provider, shard, summary }) =>
        ({ provider, shard, ...summary.engine.priority })) },
    sidecars: summaries.length,
    startup_ms_max: Math.max(...summaries.map(({ summary }) => summary.engine.startup_ms)),
    batches: summaries.reduce((sum, { summary }) => sum + summary.engine.batches, 0),
    documents: summaries.reduce((sum, { summary }) => sum + summary.engine.documents, 0),
    request_bytes: summaries.reduce((sum, { summary }) => sum + summary.engine.request_bytes, 0),
    peak_rss_bytes_upper_bound: summaries.reduce((sum, { summary }) =>
      sum + summary.peak_rss_bytes, 0),
  },
  harness_sha256: first.harness_sha256,
  adapter_code_sha256: first.adapter_code_sha256,
  measured_mib_s_x1000: Math.round(
    totalSourceBytes / 1048576 / (totalProcessingMs / 1_000) * 1_000,
  ),
};
const summaryBytes = Buffer.byteLength(JSON.stringify(summary));
if (summaryBytes > 64 * 1024) {
  throw new Error(`Phase summary exceeds 64 KiB: ${summaryBytes}`);
}
atomicJson(path.join(output, "summary.json"), summary);
console.log(JSON.stringify(summary, null, 2));
if (artifactBytes > 40 * 1024 * 1024) {
  throw new Error(`Compressed row manifest exceeds 40 MiB: ${artifactBytes}`);
}
const gatedMib = limit ? summary.projected_full_mib_s_x1000 : summary.measured_mib_s_x1000;
if (gatedMib < requiredMib * 1_000) {
  throw new Error(`Aggregate throughput below ${requiredMib} MiB/s`);
}
const gatedWall = limit ? projectedWallMs : totalWallMs;
if (gatedWall > maxWallMs) {
  throw new Error(`Freeze wall/projection ${Math.round(gatedWall)}ms exceeds ${maxWallMs}ms`);
}
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
