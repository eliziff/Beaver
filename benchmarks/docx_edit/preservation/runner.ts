/** Public-tool execution only. The separate frozen Python oracle scores saved packages. */
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChatToolContext } from "../../../backend/src/lib/chat/turnEngine";

type Task = {
  id: string; family: string; name?: string; source?: string;
  tool: "session" | "Edit" | "word_python";
  old_string?: string; new_string?: string; replace_all?: boolean; program?: string;
};
type Receipt = {
  id: string; family: string; name: string; tool: Task["tool"]; output: string;
  source_sha256: string; output_sha256?: string; tool_success: boolean; error?: string;
  workflow_error?: string;
  tool_receipts: unknown[]; source_unchanged_before_apply: boolean | null;
  preview_applied_exact_bytes: boolean | null; libreoffice_opened: boolean | null;
  pages: number | null; preview_output?: string; preview_sha256?: string;
  observed_on_failure_output?: string; submission: { origin: "machine_test"; run_id: string; scenario: string };
};
const root = path.resolve(__dirname, "../../..");
const frozen = path.join(root, ".tmp/cloud-docx-hillclimb/frozen");
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const option = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
};
const component = (value: string) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(value) || value.includes(".."))
    throw new Error(`Unsafe fixture component: ${value}`);
  return value;
};
const repositoryFile = (relative: string) => {
  const absolute = path.resolve(root, relative);
  if (path.isAbsolute(relative) || !absolute.startsWith(root + path.sep))
    throw new Error(`Unsafe repository path: ${relative}`);
  return absolute;
};

async function main() {
  const subset = option("subset") ?? "development";
  if (!["development", "heldout"].includes(subset)) throw new Error("Unknown subset");
  const requested = option("out");
  if (!requested || !path.isAbsolute(requested)) throw new Error("--out must be an absolute new run directory");
  const out = path.resolve(requested);
  await mkdir(out, { recursive: true });
  for (const file of ["tool-results.json", "local-data"]) {
    if (await access(path.join(out, file)).then(() => true, () => false))
      throw new Error(`Run directory already contains ${file}; choose a fresh directory`);
  }
  // No sibling subset is listed or opened. Hash only shared gates and this subset.
  const freezeBytes = await readFile(path.join(frozen, "freeze.json"));
  const freezeSha256 = hash(freezeBytes);
  const manifest = JSON.parse(freezeBytes.toString("utf8")) as {
    files: Record<string, string>; production_identity_paths?: string[];
  };
  let finalProductionSha256: string | undefined;
  if (subset === "heldout") {
    const sealPath = option("final-incumbent");
    if (!sealPath || !path.isAbsolute(sealPath))
      throw new Error("Held-out execution requires --final-incumbent /absolute/root-created-seal.json");
    const seal = JSON.parse(await readFile(sealPath, "utf8")) as {
      schema: string; freeze_sha256: string; production_files: Record<string, string>; production_sha256: string;
    };
    if (seal.schema !== "docx-preservation-final-incumbent-v1" || seal.freeze_sha256 !== freezeSha256)
      throw new Error("Final incumbent seal does not match the frozen evaluation");
    const mandatory = ["backend/src/lib/docxTrackedChanges.ts", "backend/src/lib/wordEditApplication.ts",
      "backend/scripts/word_python/helpers.py"];
    const identities = manifest.production_identity_paths;
    if (!Array.isArray(identities) || !mandatory.every(file => identities.includes(file)))
      throw new Error("Freeze lacks the complete production identity path contract");
    const entries = Object.entries(seal.production_files ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    if (JSON.stringify(entries.map(([file]) => file)) !== JSON.stringify([...identities].sort()))
      throw new Error("Final incumbent seal production file set differs from the frozen identity path contract");
    // Root writes production_sha256 = SHA256(UTF8(JSON.stringify(sorted [path,sha256] pairs))).
    if (hash(Buffer.from(JSON.stringify(entries))) !== seal.production_sha256)
      throw new Error("Final incumbent production digest is invalid");
    for (const [file, digest] of entries) {
      if (hash(await readFile(repositoryFile(file))) !== digest) throw new Error(`Final incumbent changed: ${file}`);
    }
    finalProductionSha256 = seal.production_sha256;
  }
  for (const [file, digest] of Object.entries(manifest.files)) {
    const other = subset === "development" ? "heldout" : "development";
    if (file.startsWith(`.tmp/cloud-docx-hillclimb/frozen/${other}/`)) continue;
    if (hash(await readFile(repositoryFile(file))) !== digest) throw new Error(`Frozen file changed: ${file}`);
  }
  const runId = `docx-preservation-${randomUUID()}`;
  process.env.AUTH_MODE = "local";
  process.env.MIKE_LOCAL_DATA_DIR = path.join(out, "local-data");
  process.env.OPEN_LEGAL_DATA_HOME = path.join(out, "local-data", "legal-data");
  process.env.BEAVER_TEST_RUN_ID = runId;
  process.env.MIKE_PDF_LAYOUT_PROVIDER = "none";
  process.env.MIKE_PDF_OCR_PROVIDER = "none";
  // This runner never invokes a model, and never loads a developer's backend .env.
  process.loadEnvFile = () => {};
  const { openDocxSession } = await import("../../../backend/scripts/docx-edit-bench-bridge");
  const { createChatToolRunner } = await import("../../../backend/src/lib/chat/chatToolRunner");
  const { TurnToolRegistry } = await import("../../../backend/src/lib/chat/toolRegistry");
  const { createLegalEvidenceTurnState } = await import("../../../backend/src/lib/chat/legalEvidence");
  const { createSourceWorkspaceApplication } = await import("../../../backend/src/lib/sourceWorkspaceApplication");
  const { localDocuments: documents, localLibraryStore: library, localProjects: projects,
    createLocalDocument } = await import("../../../backend/src/lib/__tests__/support/localDocumentFixtures");
  const { closeRelationalDatabase } = await import("../../../backend/src/lib/relationalDatabase");
  const results: Receipt[] = [];
  const ids = new Set<string>();
  const outputs = new Set<string>();
  try {
    const selected = path.join(frozen, subset);
    const families = (await readdir(selected, { withFileTypes: true }))
      .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    for (const family of families) {
      component(family);
      const directory = path.join(selected, family);
      const parsed = JSON.parse(await readFile(path.join(directory, "tasks.json"), "utf8"));
      const tasks: Task[] = Array.isArray(parsed) ? parsed : parsed.tasks;
      if (!Array.isArray(tasks)) throw new Error(`Invalid tasks in ${family}`);
      for (const task of tasks) {
        if (task.family !== family || !task.id || ids.has(task.id)) throw new Error("Invalid or duplicate task identity");
        ids.add(task.id);
        const name = component(task.name ?? task.id);
        const output = `${family}-${name}.docx`;
        if (outputs.has(output)) throw new Error("Duplicate output filename");
        outputs.add(output);
        const original = await readFile(path.join(directory, component(task.source ?? "source.docx")));
        const receipt: Receipt = { id: task.id, family, name, tool: task.tool, output,
          source_sha256: hash(original), tool_success: false, tool_receipts: [],
          source_unchanged_before_apply: null, preview_applied_exact_bytes: null,
          libreoffice_opened: null, pages: null,
          submission: { origin: "machine_test", run_id: runId, scenario: task.id } };
        let artifact: Buffer = original;
        let readPublished: (() => Promise<Buffer>) | undefined;
        process.env.BEAVER_TEST_SCENARIO = task.id;
        try {
          if (task.tool === "session") {
            artifact = await (await openDocxSession(original)).save();
            receipt.tool_receipts.push({ entrypoint: "openDocxSession.save", completed: true });
            receipt.tool_success = true;
          } else {
            if (!["Edit", "word_python"].includes(task.tool)) throw new Error(`Unknown tool ${task.tool}`);
            const scope = { userId: "local-user" };
            const source = await createLocalDocument({ ...scope, kind: "file", filename: `${family}-${name}.docx`, bytes: original });
            const evidence = createLegalEvidenceTurnState();
            const context: ChatToolContext & { emit(): void } = { evidence, emit() {},
              operation: { executor: "assistant", turnId: `${runId}-${task.id}` },
              addEvent(event) { receipt.tool_receipts.push({ event }); } };
            const runnerOptions = { ...scope, documents, library, projects,
              allowedDocumentIds: new Set([source.id]), includeResearchTools: false,
              editMode: "auto" as const, onMutationCommitted() {},
              sources: createSourceWorkspaceApplication(documents, { chats: {} as never, tables: {} as never,
                tabular: async () => { throw new Error("DOCX fixture has no research table"); } }) };
            // Match the existing public Word tool test: unrelated work-product
            // application ports are not supplied or invoked by these DOCX operations.
            const runner = createChatToolRunner(runnerOptions as Parameters<typeof createChatToolRunner>[0]);
            const registry = new TurnToolRegistry(runner.createTools(evidence, "main", context));
            const readDocument = async (id: string) => {
              const found = await documents.read(scope, id, null, false);
              if (!found) throw new Error(`Document missing: ${id}`);
              return found.bytes;
            };
            readPublished = () => readDocument(source.id);
            let sequence = 0;
            const call = async (tool: string, input: Record<string, unknown>) => {
              const [result] = await registry.run([{ id: String(++sequence), name: tool, input }], context,
                new AbortController().signal, (call, outcome) => {
                  receipt.tool_receipts.push({ call, outcome });
                });
              receipt.tool_receipts.push({ normalized_result: result });
              if (!result || result.status !== "ok") throw new Error(`${tool}: ${result?.content ?? "missing result"}`);
              let value: Record<string, unknown>;
              try { value = JSON.parse(result.content); }
              catch { throw new Error(`${tool}: expected JSON result, received ${result.content}`); }
              if (value.ok === false) throw new Error(`${tool}: ${result.content}`);
              return value;
            };
            const file_path = `document://${source.id}/version/${source.current_version_id}`;
            if (task.tool === "Edit") {
              await call("Edit", { file_path, old_string: task.old_string, new_string: task.new_string,
                ...(task.replace_all !== undefined ? { replace_all: task.replace_all } : {}) });
              receipt.tool_success = true;
              artifact = await readPublished();
            } else {
              await call("load_tools", { names: ["word_python"] });
              const inspected = await call("word_python", { action: "inspect", file_path });
              const preview = await call("word_python", { action: "preview", file_path,
                snapshot: inspected.snapshot, program: task.program });
              receipt.libreoffice_opened = preview.libreoffice_opened === true;
              receipt.pages = typeof preview.pages === "number" ? preview.pages : null;
              receipt.source_unchanged_before_apply = (await readPublished()).equals(original);
              if (!receipt.source_unchanged_before_apply) throw new Error("Preview changed the source before apply");
              const candidateId = typeof preview.resource === "string" ? preview.resource.split("/")[2] : "";
              if (!candidateId || typeof preview.artifact !== "string") throw new Error("Preview returned no candidate resource/artifact");
              const candidate = await readDocument(candidateId);
              receipt.preview_output = `${family}-${name}.preview.docx`;
              receipt.preview_sha256 = hash(candidate);
              await writeFile(path.join(out, receipt.preview_output), candidate, { flag: "wx" });
              await call("word_python", { action: "apply", file_path: preview.artifact });
              receipt.tool_success = true;
              artifact = await readPublished();
              receipt.preview_applied_exact_bytes = artifact.equals(candidate);
              if (!receipt.preview_applied_exact_bytes) throw new Error("Apply did not publish the exact preview bytes");
            }
          }
        } catch (error) {
          receipt.error = error instanceof Error ? error.message : String(error);
          if (receipt.tool_success) receipt.workflow_error = receipt.error;
          // A failing tool may already have changed its source: score that observed
          // state, never replace known collateral with the untouched input.
          if (readPublished) {
            const observed = await readPublished().catch(() => undefined);
            artifact = observed ?? original;
            if (observed && !observed.equals(original)) {
              receipt.observed_on_failure_output = `${family}-${name}.observed-on-failure.docx`;
              await writeFile(path.join(out, receipt.observed_on_failure_output), observed, { flag: "wx" });
            }
          }
        }
        await writeFile(path.join(out, output), artifact, { flag: "wx" });
        receipt.output_sha256 = hash(artifact);
        results.push(receipt);
        await writeFile(path.join(out, "tool-results.json"), JSON.stringify(results, null, 2) + "\n");
        console.log(JSON.stringify({ id: task.id, tool_success: receipt.tool_success,
          output, ...(receipt.error ? { error: receipt.error } : {}) }));
      }
    }
    await writeFile(path.join(out, "runner-receipt.json"), JSON.stringify({ schema: "docx-preservation-runner-v1",
      submission: { origin: "machine_test", run_id: runId }, subset, freeze_sha256: freezeSha256,
      ...(finalProductionSha256 ? { final_incumbent_sha256: finalProductionSha256 } : {}),
      runner_sha256: hash(await readFile(__filename)), node: process.version,
      python: process.env.BEAVER_WORD_PYTHON ?? process.env.BEAVER_PYTHON ?? "python3",
      tasks: results.length, tool_success: results.filter(result => result.tool_success).length,
      artifact_correctness: "Not assessed by runner; use frozen independent oracle." }, null, 2) + "\n");
  } finally { await closeRelationalDatabase(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
