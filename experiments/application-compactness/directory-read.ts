import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

async function main() {
  const label = process.argv[2] ?? "candidate";
  if (!/^[a-z0-9-]+$/u.test(label)) throw new Error("Invalid result label");
  const directory = await mkdtemp(path.join(os.tmpdir(), "beaver-directory-benchmark-"));
  process.env.AUTH_MODE = "local";
  process.env.MIKE_LOCAL_DATA_DIR = directory;
  const [{ createDocumentApplication }, { documentRepository }, { libraryRepository },
    { createLibraryStore }, { projectRepository }, { createProjectStore }, objects, database] =
    await Promise.all([
      import("../../backend/src/lib/documentApplication"),
      import("../../backend/src/lib/relationalDocumentRepository"),
      import("../../backend/src/lib/relationalLibraryRepository"),
      import("../../backend/src/lib/libraryStore"),
      import("../../backend/src/lib/relationalProjectRepository"),
      import("../../backend/src/lib/projectStore"),
      import("../../backend/src/lib/filesystemObjectStorage"),
      import("../../backend/src/lib/relationalDatabase"),
    ]);
  const documents = createDocumentApplication(documentRepository, objects.filesystemDocumentObjects());
  const library = createLibraryStore(libraryRepository, documents);
  const projects = createProjectStore(projectRepository, documents);
  const scope = { userId: "directory-benchmark" };
  const project = await projects.create(scope, { name: "Matter", cmNumber: null,
    practice: null, sharedWith: [] });
  const folder = await library.createFolder({ ...scope, kind: "file" }, "Agreements", null);
  assert(folder);
  for (let index = 0; index < 500; index++) {
    const input = { filename: `Agreement ${String(index).padStart(4, "0")}.txt`,
      fileType: "txt", bytes: Buffer.from(`Clause ${index}. Written notice is required.`) };
    await documents.create(scope, { ...input, folderId: folder.id });
    await documents.create(scope, { ...input, projectId: project.id });
    if (index % 100 === 0) console.log(`${label}: seeded ${index}/500 Library and project documents`);
  }
  const options = { q: "Agreement", parentFolderId: null, limit: 100, after: null };
  const db = await database.relationalDatabase(), query = db.query.bind(db);
  let queries = 0;
  db.query = (statement) => { queries++; return query(statement); };
  const outcomes: Record<string, unknown> = {};
  try {
    for (const [name, operation] of [
      ["library-search", () => library.page({ ...scope, kind: "file" }, options)],
      ["library-folder", () => library.page({ ...scope, kind: "file" }, {
        ...options, q: "", parentFolderId: folder.id })],
      ["project-navigation", () => projects.directory(scope, project.id, { ...options, q: "" })],
    ] as const) {
      const elapsed: number[] = [], queryCounts: number[] = [];
      for (let sample = 0; sample < 65; sample++) {
        queries = 0;
        const start = performance.now(), page = await operation();
        const ms = performance.now() - start;
        assert.equal(page.items.length, 100);
        if (sample >= 5) { elapsed.push(ms); queryCounts.push(queries); }
        if (sample % 20 === 0) console.log(`${label}: ${name}, sample ${sample}/65`);
      }
      elapsed.sort((a, b) => a - b);
      outcomes[name] = { samples: elapsed.length, medianMs: elapsed[29], p95Ms: elapsed[56],
        queriesPerPage: [...new Set(queryCounts)] };
      await writeFile(path.join(__dirname, "results", `${label}-directory-read.json`),
        JSON.stringify({ label, measuredAt: new Date().toISOString(), node: process.version,
          documentsPerDirectory: 500, pageSize: 100, outcomes }, null, 2));
    }
    console.log(JSON.stringify(outcomes, null, 2));
  } finally { await database.closeRelationalDatabase(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
