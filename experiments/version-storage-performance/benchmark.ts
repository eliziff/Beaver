import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const option = (name: string, fallback: number) => Number(process.argv.find((value) =>
  value.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
const SOURCE_COUNT = option("sources", 200), WRITES = option("writes", 100),
  CHECKPOINTS = option("checkpoints", 500), ADDS = option("adds", 250);

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), "beaver-version-perf-"));
  process.env.AUTH_MODE = "local";
  process.env.MIKE_LOCAL_DATA_DIR = root;

  const [{ createDocumentApplication }, { documentRepository }, { filesystemDocumentObjects },
    { projectRepository }, research, database] = await Promise.all([
      import("../../backend/src/lib/documentApplication"),
      import("../../backend/src/lib/relationalDocumentRepository"),
      import("../../backend/src/lib/filesystemObjectStorage"),
      import("../../backend/src/lib/relationalProjectRepository"),
      import("../../backend/src/lib/researchFile"),
      import("../../backend/src/lib/relationalDatabase"),
    ]);
  const documents = createDocumentApplication(documentRepository, filesystemDocumentObjects());
  const scope = { userId: "performance-user" };
  const round = (value: number) => Number(value.toFixed(3));
  const summary = (samples: number[]) => {
    const sorted = [...samples].sort((a, b) => a - b);
    const at = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1];
    return { count: samples.length, medianMs: round(at(0.5)), p95Ms: round(at(0.95)),
      maxMs: round(sorted.at(-1)!), meanMs: round(samples.reduce((a, b) => a + b, 0) / samples.length) };
  };
  async function measure(count: number, operation: (index: number) => Promise<void>) {
    const samples: number[] = [];
    for (let index = 0; index < count; index++) {
      const started = performance.now();
      await operation(index);
      samples.push(performance.now() - started);
    }
    return summary(samples);
  }
  const elapsed = async (operation: () => Promise<unknown>) => {
    const started = performance.now(); await operation(); return round(performance.now() - started);
  };
  const required = <T>(value: T | null | undefined, message: string): T => {
    if (value == null) throw new Error(message);
    return value;
  };

  try {
  const state = research.createResearchFileState();
  for (let index = 0; index < 24; index++) { const id = randomUUID(); state.labels[id] = {
    id, name: `Topic ${index + 1}`, parentId: null, order: index,
    color: `#${(index * 456791 + 0x345678).toString(16).slice(-6).padStart(6, "0")}`,
    scope: "source" }; }
  const labels = Object.keys(state.labels);
  for (let index = 0; index < SOURCE_COUNT; index++) { const id = randomUUID(); state.sources[id] = {
    id, reference: { provider: "a2aj", id: `2026 SCC ${index + 1}`,
      kind: "case", citation: `2026 SCC ${index + 1}` }, labelIds: [labels[index % labels.length]],
    badge: "", badgeColor: "#666666", passages: null,
    note: `Representative source note ${index + 1}. ${"Relevant passage. ".repeat(5)}` }; }
  const researchBytes = Buffer.from(research.researchFileMarkdown("Performance", state));
  const researchDecode = await measure(250, async () => {
    required(research.parseResearchFile(researchBytes), "research parse failed");
  });
  const researchEncode = await measure(250, async () => {
    research.researchFileMarkdown("Performance", state);
  });
  const created = await documents.create(scope, { filename: "Performance.research.md",
    fileType: "md", bytes: researchBytes });
  let versionId = created.current_version_id, workingRevision = created.current_working_revision;
  const autosave = async (index: number) => {
    const saved = required(await research.saveResearchFile(documents, scope, created.id,
      versionId, workingRevision, { type: "note", markdown: `Working note ${index}.` }),
    "research autosave conflicted");
    versionId = saved.versionId; workingRevision = saved.workingRevision;
  };
  for (let index = 0; index < 10; index++) await autosave(-index);
  const researchAutosave = await measure(WRITES, autosave);

  const checkpoint = async () => {
    const saved = await documents.checkpointVersion(scope, created.id,
      versionId, workingRevision, "Performance checkpoint");
    if (saved.status !== "created") throw new Error(`checkpoint: ${saved.status}`);
    versionId = saved.version.id; workingRevision = saved.version.working_revision;
  };
  for (let index = 0; index < 5; index++) await checkpoint();
  const checkpoints = await measure(CHECKPOINTS, checkpoint);
  const deepHistory = await documents.versions(scope, created.id);
  const historyListing = await measure(50, async () => {
    required(await documents.versions(scope, created.id), "history missing");
  });
  const researchRead = await measure(100, async () => {
    required(await research.readResearchFile(documents, scope, created.id), "research read missing");
  });
  const deepHistoryAutosave = await measure(WRITES, autosave);

  const originalVersion = required(deepHistory?.versions.at(-1)?.id, "original version missing");
  const restores = await measure(100, async () => {
    const restored = await documents.restoreVersion(scope, created.id, originalVersion,
      versionId, workingRevision, "Performance restore");
    if (restored.status !== "restored") throw new Error(`restore: ${restored.status}`);
    versionId = restored.version.id; workingRevision = restored.version.working_revision;
  });

  const plain = await documents.create(scope,
    { filename: "Versions.txt", fileType: "txt", bytes: Buffer.from("version 0") });
  let plainVersion = plain.current_version_id, plainRevision = plain.current_working_revision;
  const addVersion = async (index: number) => {
    const added = required(await documents.addVersion(scope, plain.id, {
      filename: "Versions.txt", fileType: "txt", bytes: Buffer.from(`version ${index}`),
      expectedCurrentVersionId: plainVersion, expectedCurrentWorkingRevision: plainRevision,
    }), "add version conflicted");
    plainVersion = added.id; plainRevision = added.working_revision;
  };
  for (let index = 0; index < 5; index++) await addVersion(-index);
  const addedVersions = await measure(ADDS, addVersion);
  const plainHistoryListing = await measure(50, async () => {
    required(await documents.versions(scope, plain.id), "plain history missing");
  });
  const project = await projectRepository.create(scope, {
    name: "Performance", cmNumber: null, practice: null, sharedWith: [], metadata: {}, notes: null,
  });
  const move = (documentId: string, from: string | null, to: string | null) =>
    documents.relocate(scope, documentId, { expectedProjectId: from, expectedFolderId: null,
      projectId: to, folderId: null, owner: true }).then((result) => {
      if (result.status !== "moved") throw new Error(`relocate: ${result.status}`);
    });
  const relocateResearchToProject = await elapsed(() => move(created.id, null, project.id));
  const relocateResearchToLibrary = await elapsed(() => move(created.id, project.id, null));
  const relocateUniqueToProject = await elapsed(() => move(plain.id, null, project.id));
  const relocateUniqueToLibrary = await elapsed(() => move(plain.id, project.id, null));

  console.log(JSON.stringify({ runtime: { node: process.version, platform: process.platform,
    database: "SQLite", objects: "local filesystem" }, corpus: {
    researchBytes: researchBytes.byteLength, labels: labels.length, sources: SOURCE_COUNT,
    researchHistoryVersions: (await documents.versions(scope, created.id))?.versions.length,
    plainHistoryVersions: (await documents.versions(scope, plain.id))?.versions.length,
  }, operations: { researchDecode, researchEncode, researchAutosave, checkpoints, historyListing,
    researchRead, deepHistoryAutosave, restores, addedVersions, plainHistoryListing,
    relocateResearchToProject, relocateResearchToLibrary,
    relocateUniqueToProject, relocateUniqueToLibrary } }, null, 2));
  } finally {
    await database.closeRelationalDatabase();
    await rm(root, { recursive: true, force: true });
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
