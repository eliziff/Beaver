import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const option = (name: string, fallback: number) => Number(process.argv.find((value) =>
  value.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
const passages = option("passages", 10_000), samples = option("samples", 5),
  passagesPerSource = option("passages-per-source", 100);
if (![passages, samples, passagesPerSource].every(Number.isInteger) || passages < 1 ||
    passages > 100_000 || samples < 1 || passagesPerSource < 1 ||
    Math.ceil(passages / passagesPerSource) > 10_000)
  throw new Error("Invalid benchmark options.");
const round = (value: number) => Number(value.toFixed(3));
const measure = async (count: number, operation: (index: number) => Promise<void>) => {
  const values = [];
  for (let index = 0; index < count; index++) { const start = performance.now();
    await operation(index); values.push(performance.now() - start); }
  values.sort((a, b) => a - b);
  return { medianMs: round(values[Math.floor(count / 2)]), p95Ms: round(values[Math.ceil(count * .95) - 1]) };
};

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), "beaver-research-scale-"));
  process.env.AUTH_MODE = "local"; process.env.MIKE_LOCAL_DATA_DIR = root;
  const output = path.join(__dirname, "results", `research-${passages}-${passagesPerSource}.json`),
    result: Record<string, unknown> = { runtime: { node: process.version, platform: process.platform },
      passages, passagesPerSource, samples }, memory = () => round(process.resourceUsage().maxRSS / 1024);
  const persist = async (phase: string, values: Record<string, unknown> = {}) => {
    Object.assign(result, values, { phase }); await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
    console.error(`[${phase}] ${values.generatedPassages ?? passages}/${passages}`);
  };
  const [{ createDocumentApplication }, { documentRepository }, { filesystemDocumentObjects },
    research, evidence, database, storage] = await Promise.all([
      import("../../backend/src/lib/documentApplication"),
      import("../../backend/src/lib/relationalDocumentRepository"),
      import("../../backend/src/lib/filesystemObjectStorage"),
      import("../../backend/src/lib/researchFile"),
      import("../../backend/src/lib/chat/legalEvidence"),
      import("../../backend/src/lib/relationalDatabase"),
      import("../../backend/src/lib/storage"),
    ]);
  try {
    const documents = createDocumentApplication(documentRepository, filesystemDocumentObjects()),
      scope = { userId: "research-scale" }, sources = Math.ceil(passages / passagesPerSource),
      state = research.createResearchFileState(), sourceLabels: string[] = [],
      passageLabels: string[] = [];
    for (let index = 0; index < 12; index++) { const id = randomUUID(); sourceLabels.push(id);
      state.labels[id] = { id, name: `Issue ${index + 1}`, parentId: null,
        color: "#336699", order: index, scope: "source" }; }
    for (let index = 0; index < 12; index++) { const id = randomUUID(); passageLabels.push(id);
      state.labels[id] = { id, name: `Passage ${index + 1}`, parentId: null,
        color: "#996633", order: index, scope: "highlight" }; }
    for (let index = 0; index < sources; index++) { const id = randomUUID(); state.sources[id] = {
      id, reference: { provider: "a2aj", id: `2026 SCC ${index + 1}`,
        kind: "case", citation: `2026 SCC ${index + 1}`, collection: "scc", language: "en" },
      labelIds: [sourceLabels[index % 12]], badge: "", badgeColor: "#666666",
      note: `Treatment note for 2026 SCC ${index + 1}.`,
      passages: null }; }
    const created = await documents.create(scope, { filename: "Scale.research.md", fileType: "md",
      bytes: Buffer.from(research.researchFileMarkdown("Scale", state)) });
    let current = (await research.readResearchFile(documents, scope, created.id))!;
    let firstEvidenceId = "";
    for (let start = 0; start < passages; start += 5_000) {
      const receipts = Array.from({ length: Math.min(5_000, passages - start) }, (_, offset) => {
        const index = start + offset, source = Math.floor(index / passagesPerSource) + 1;
        return evidence.createA2AJPassageEvidence({ citation: `2026 SCC ${source}`,
          name: `Case ${source}`, dataset: "scc", language: "en",
          sourceSha256: `sha256:${source.toString(16).padStart(64, "0")}`,
          spanText: `The court applies the governing legal test to material fact ${index + 1}.`,
          start: index * 80, end: index * 80 + 70, externalUrl: null, sourceClass: "case",
          sourceReference: { id: `2026 SCC ${source}` }, blockId: `par${index + 1}`,
          locator: { kind: "paragraph", label: String(index + 1) } }); });
      firstEvidenceId ||= receipts[0].evidence_id;
      const began = performance.now(), saved = await research.saveResearchFile(documents, scope,
        created.id, current.versionId, current.workingRevision, { type: "merge", evidence: receipts,
          labels: Object.fromEntries(receipts.map((receipt, index) =>
            [receipt.evidence_id, [passageLabels[(start + index) % 12]]])) });
      if (!saved) throw new Error("Passage merge failed."); current = saved;
      await persist("populating", { sources, generatedPassages: Math.min(start + 5_000, passages),
        lastBatchMs: round(performance.now() - began), peakRssMiB: memory() });
    }
    const databaseHandle = await database.relationalDatabase(), rootFile = await documents.read(
      scope, created.id, null, false), partStats = (await databaseHandle.query<{
        parts: number; bytes: number; largest: number }>(database.sql`SELECT COUNT(*) parts,
          COALESCE(SUM(size_bytes),0) bytes,COALESCE(MAX(size_bytes),0) largest
          FROM document_version_parts WHERE document_id=${created.id}
            AND version_id=${current.versionId}`)).rows[0];
    const noteMutation = await measure(samples, async (index) => { const saved =
      await research.saveResearchFile(documents, scope, created.id, current.versionId,
        current.workingRevision, { type: "note", markdown: `Human working note ${index}.` });
      if (!saved) throw new Error("Note mutation failed."); current = saved; });
    const firstSourceId = Object.keys(current.state.sources)[0], passageMutation = await measure(
      samples, async (index) => { const saved = await research.saveResearchFile(documents, scope,
        created.id, current.versionId, current.workingRevision, { type: "annotate",
          kind: "evidence", id: firstEvidenceId, sourceId: firstSourceId,
          note: `Passage note ${index}.` });
        if (!saved) throw new Error("Passage mutation failed."); current = saved; });
    const readStart = performance.now(); await research.readResearchFile(documents, scope, created.id);
    const readIndexMs = round(performance.now() - readStart), pageRssBefore = process.memoryUsage().rss;
    let pageItems = 0; const pageRead = await measure(samples, async () => { pageItems =
      (await research.pageResearchItems(documents, scope, current, "passages", 0, 50)).items.length; });
    const pageRssAfter = process.memoryUsage().rss, pageMemory = {
      beforeMiB: round(pageRssBefore / 1024 / 1024), afterMiB: round(pageRssAfter / 1024 / 1024),
      retainedGrowthMiB: round(Math.max(0, pageRssAfter - pageRssBefore) / 1024 / 1024) },
      checkpointStart = performance.now(),
      checkpoint = await documents.checkpointVersion(scope, created.id, current.versionId,
        current.workingRevision), checkpointMs = round(performance.now() - checkpointStart);
    if (checkpoint.status !== "created" || pageItems !== Math.min(50, passages) ||
        partStats.largest >= storage.MAX_OBJECT_SIZE_BYTES)
      throw new Error("Paged read or checkpoint failed.");
    const references = (await databaseHandle.query<{ rows: number; blobs: number }>(database.sql`
      SELECT COUNT(*) rows,COUNT(DISTINCT storage_path) blobs FROM document_version_parts
      WHERE document_id=${created.id}`)).rows[0];
    await persist("complete", { rootBytes: rootFile?.bytes.byteLength, partStats,
      objectCapBytes: storage.MAX_OBJECT_SIZE_BYTES,
      largestPartCapPercent: round(partStats.largest / storage.MAX_OBJECT_SIZE_BYTES * 100), noteMutation,
      passageMutation, readIndexMs, pageRead, pageMemory, checkpointMs, checkpointReferences: references,
      peakRssMiB: memory() });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    await persist("failed", { error: error instanceof Error ? error.message : String(error) }); throw error;
  } finally {
    await database.closeRelationalDatabase(); await rm(root, { recursive: true, force: true });
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
