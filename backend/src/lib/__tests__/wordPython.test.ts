import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DeletedTextRun, InsertedTextRun, Paragraph, TextRun } from "docx";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveSofficeBinary } from "../convert";
import { runWordPython, wordPython } from "../wordPython";
import { docxBytes, docxXml } from "./support/docxFixtures";

const available = () => {
  if (process.env.WORD_PYTHON_CONTAINER_IMAGE) return true;
  try {
    execFileSync(wordPython(), ["-I", path.resolve(__dirname, "../../../scripts/word_python/probe.py")], { stdio: "ignore" });
    return !!resolveSofficeBinary();
  } catch { return false; }
};

const signal = new AbortController().signal;
const clauses = ["Services Agreement", "The Client shall pay all invoices within 30 days of receipt.",
  "Either party may terminate on 60 days written notice.", "Fees are set out below.", "Governed by the laws of Alberta."];
const paragraphs = (xml: string) => [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/gu)].map(([p]) =>
  [...p.matchAll(/<w:(?:t|delText)(?: [^>]*)?>([^<]*)<\/w:(?:t|delText)>/gu)].map(m => m[1]).join(""));
/** Independent oracle: drop insertions, keep deletions, drop inserted paragraph marks. */
const rejected = (xml: string) => paragraphs(xml.replace(/<w:ins w:id[^>]*>[\s\S]*?<\/w:ins>/gu, "")
  .replace(/<w:p>(?:(?!<\/w:p>)[\s\S])*?<w:rPr><w:ins [^>]*\/>(?:(?!<\/w:p>)[\s\S])*?<\/w:p>/gu, "")).filter(Boolean);
const accepted = (xml: string) => paragraphs(xml.replace(/<w:del w:id[^>]*[^/]>[\s\S]*?<\/w:del>/gu, "")).filter(Boolean);

describe.skipIf(!available())("word_python", () => {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "beaver-word-python-"));
    process.env.MIKE_LOCAL_DATA_DIR = home;
    vi.resetModules();
  });
  afterAll(async () => {
    await (await import("../relationalDatabase")).closeRelationalDatabase();
    delete process.env.MIKE_LOCAL_DATA_DIR;
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  async function chat(editMode: "auto" | "manual") {
    const { createChatToolRunner } = await import("../chat/chatToolRunner");
    const { TurnToolRegistry } = await import("../chat/toolRegistry");
    const { createLegalEvidenceTurnState } = await import("../chat/legalEvidence");
    const { createSourceWorkspaceApplication } = await import("../sourceWorkspaceApplication");
    const { localDocuments: documents, localLibraryStore: library, localProjects: projects,
      createLocalDocument } = await import("./support/localDocumentFixtures");
    const source = await createLocalDocument({ userId: "local-user", kind: "file", filename: "contract.docx",
      bytes: await docxBytes(clauses.map((text, i) => new Paragraph({ children: [new TextRun({ text, bold: i === 0 })] }))) });
    const scope = { userId: "local-user" }, evidence = createLegalEvidenceTurnState();
    const context = { evidence, operation: { executor: "assistant" as const }, emit() {}, addEvent() {} };
    const runner = createChatToolRunner({ ...scope, documents, library, projects, allowedDocumentIds: new Set([source.id]),
      includeResearchTools: false, editMode, onMutationCommitted() {},
      sources: createSourceWorkspaceApplication(documents, { chats: {} as never, tables: {} as never,
        tabular: async () => { throw new Error("No table in this fixture"); } }) });
    const entries = runner.createTools(evidence, "main", context);
    const registry = new TurnToolRegistry(entries);
    let id = 0;
    const raw = async (name: string, input: Record<string, unknown>) => (await registry.run([{ id: String(++id), name, input }], context))[0];
    const call = async (name: string, input: Record<string, unknown>) => {
      const result = await raw(name, input);
      expect(result.status, `${name}: ${result.content}`).toBe("ok");
      return JSON.parse(result.content);
    };
    const read = async (documentId: string) => (await documents.read(scope, documentId, null, false))!.bytes;
    await call("load_tools", { names: ["word_python"] });
    return { call, raw, read, documents, source, entries, file_path: `document://${source.id}/version/${source.current_version_id}` };
  }

  it("names word_python as the only Word specialist in model-visible tool text", async () => {
    const { entries } = await chat("auto");
    const catalog = JSON.stringify(entries.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })));
    expect([...new Set(catalog.match(/\bword_[a-z]+/gu))]).toEqual(["word_python"]);
    expect(catalog).not.toMatch(/\bUNO\b/u);
  }, 120_000);

  it("previews a verified candidate without touching the source and applies exactly those bytes", async () => {
    const { call, read, documents, source, file_path } = await chat("auto");
    const original = await read(source.id);
    const inspected = await call("word_python", { action: "inspect", file_path });
    expect(inspected.items[1].text).toBe(clauses[1]);
    const preview = await call("word_python", { action: "preview", file_path, snapshot: inspected.snapshot, program: [
      "t = insert_table_after(find('Fees are set out')[0], 2, 2, style='Table Grid')",
      "t.cell(0, 0).text = 'Advice'; t.cell(0, 1).text = '$400'",
      "section_range(t, t)  # repeating the range must not add an empty section",
      "set_page(section_range(t, t), orientation='landscape', margins_mm=15)",
      "replace_text(find('30 days')[0], '30 days', '45 days')",
      "return len(doc.sections)"].join("\n") });
    expect(preview).toMatchObject({ result: 3, reopened: true, libreoffice_opened: true });
    expect(preview.pages).toBeGreaterThanOrEqual(2);
    expect(preview.sections[1].orientation).toBe("landscape");
    expect(await read(source.id)).toEqual(original);
    const candidateId = preview.resource.split("/")[2];
    expect((await documents.metadata({ userId: "local-user" }, candidateId))!.filename).toBe("contract (preview).docx");
    // A preview of the candidate still revises the original.
    const refined = await call("word_python", { action: "preview", file_path: preview.artifact,
      program: "find('Governed by')[0].runs[0].italic = True" });
    expect(refined.source).toBe(preview.source);
    const applied = await call("word_python", { action: "apply", file_path: refined.artifact });
    expect(applied.mode).toBe("direct");
    const published = await read(source.id);
    expect(published).toEqual(await read(refined.resource.split("/")[2]));
    const xml = await docxXml(published);
    expect(xml).toMatch(/<w:tbl>/u); expect(xml).toMatch(/w:orient="landscape"/u);
    expect(xml).toMatch(/45 days/u); expect(xml).toMatch(/<w:i\/>/u);
    expect((await call("word_python", { action: "apply", file_path: refined.artifact })).already_applied).toBe(true);
  }, 240_000);

  it("publishes direct edits that keep the text, such as page setup and comments", async () => {
    const { call, read, source, ...tools } = await chat("auto");
    let file_path = tools.file_path;
    const publish = async (program: string) => {
      const preview = await call("word_python", { action: "preview", file_path, program });
      file_path = (await call("word_python", { action: "apply", file_path: preview.artifact })).resource;
      return docxXml(await read(source.id));
    };
    expect(await publish("set_page(doc.sections[0], margins_mm=25)")).toMatch(/w:left="1417"/u);
    expect(await publish("doc.add_comment(isolate(find('30 days')[0], '30 days'), text='Check', author='Beaver')"))
      .toMatch(/<w:commentRangeStart/u);
    expect(await publish("from docx.oxml.ns import qn\n" +
      "for tag in ('w:commentRangeStart', 'w:commentRangeEnd', 'w:commentReference'):\n" +
      "    for e in list(doc.element.body.iter(qn(tag))): e.getparent().remove(e)\n" +
      "for c in list(doc.part._comments_part.element): c.getparent().remove(c)")).not.toMatch(/<w:comment(RangeStart|Reference)/u);
  }, 240_000);

  it("records ordinary edits as native revisions in Review mode that reject back to the source", async () => {
    const { call, raw, read, file_path } = await chat("manual");
    const preview = await call("word_python", { action: "preview", file_path, program: [
      "replace_text(find('30 days')[0], '30 days', '45 days')",
      "delete(find('Either party may terminate')[0])",
      "insert_paragraph_after(find('Fees are set out')[0], 'Invoices are payable in CAD.')",
      "find('Services Agreement')[0].runs[0].italic = True"].join("\n") });
    expect(preview.review_verified).toBe(true);
    const xml = await docxXml(await read(preview.resource.split("/")[2]));
    expect(xml).toMatch(/<w:del w:id="\d+" w:author="Beaver"[^>]*><w:r>(?:<w:rPr>(?:(?!<\/w:rPr>).)*<\/w:rPr>)?<w:delText[^>]*>30<\/w:delText>/u);
    expect(xml).toMatch(/<w:ins w:id="\d+" w:author="Beaver"[^>]*><w:r>(?:<w:rPr>(?:(?!<\/w:rPr>).)*<\/w:rPr>)?<w:t[^>]*>45<\/w:t>/u);
    expect(xml).toMatch(/<w:rPrChange /u);
    expect(rejected(xml)).toEqual(clauses);
    const applied = await call("word_python", { action: "apply", file_path: preview.artifact });
    expect(applied).toMatchObject({ mode: "tracked", review_verified: true });
    // A follow-up edit inside a pending insertion just changes it; one beside earlier revisions adds only its own.
    const followUp = await call("word_python", { action: "preview", file_path: applied.resource, program: [
      "replace_text(find('payable in CAD')[0], 'CAD', 'CAD or USD')",
      "replace_text(find('45 days')[0], 'within', 'no later than')"].join("\n") });
    expect(followUp).toMatchObject({ review_verified: true, new_revisions: { del: 1, ins: 1 } });
    const revised = await docxXml(await read(followUp.resource.split("/")[2]));
    expect(revised).not.toMatch(/<w:ins [^>]*[^/]>(?:(?!<\/w:ins>).)*<w:(?:ins|del) /u);
    expect(rejected(revised)).toEqual(clauses);
    expect(revised).toMatch(/CAD or USD/u); expect(revised).toMatch(/no later than/u);
    // Deleting that pending paragraph withdraws it rather than recording a deletion of it.
    const withdrawn = await call("word_python", { action: "preview", file_path: followUp.artifact, program: "delete(find('payable in')[0])" });
    expect(withdrawn.review_verified).toBe(true); expect(withdrawn.new_revisions).toBeUndefined();
    const remaining = await docxXml(await read(withdrawn.resource.split("/")[2]));
    expect(remaining).not.toMatch(/payable in/u); expect(rejected(remaining)).toEqual(clauses);
    // A style-definition edit is untrackable, and bypassing the recorder is caught by the separate verifier.
    const style = await raw("word_python", { action: "preview", file_path: applied.resource,
      program: "next(s for s in doc.styles if s.type == WD_STYLE_TYPE.PARAGRAPH).font.size = Pt(15)" });
    expect(style.status).toBe("error"); expect(style.content).toMatch(/style definitions changed/u);
    const bypass = await raw("word_python", { action: "preview", file_path: applied.resource,
      program: "import sys\nsys.modules['tracking'].Recorder.record = lambda self: []\nfind('Alberta')[0].text = 'Governed by Ontario law.'" });
    expect(bypass.status).toBe("error"); expect(bypass.content).toMatch(/not a tracked revision/u);
  }, 240_000);

  it("keeps another author's pending revisions attributed when a Review-mode edit touches them", async () => {
    const john = { author: "John", date: "2026-01-01T00:00:00Z" };
    const source = await docxBytes([
      new Paragraph({ children: [new TextRun("Notices "), new InsertedTextRun({ text: "may be sent by courier or ", id: 1, ...john }),
        new TextRun("must be in writing.")] }),
      new Paragraph({ children: [new TextRun("Pay within "), new DeletedTextRun({ text: "30", id: 2, ...john }),
        new InsertedTextRun({ text: "45", id: 3, ...john }), new TextRun(" days.")] })]);
    const { report, candidate } = await runWordPython(source, { action: "preview", mode: "tracked", program: [
      "replace_text(find('by courier')[0], 'courier', 'registered mail')",
      "replace_text(find('Pay within')[0], 'within', 'no later than')"].join("\n") }, signal);
    expect(report.review_verified).toBe(true);
    const xml = await docxXml(candidate!);
    // Deleting John's inserted word nests Beaver's deletion inside John's insertion; the new words are Beaver's.
    expect(xml).toMatch(/<w:ins [^>]*w:author="John"[^>]*>(?:(?!<\/w:ins>).)*<w:del [^>]*w:author="Beaver"[^>]*>(?:(?!<\/w:del>).)*courier/u);
    expect(xml).toMatch(/<w:ins [^>]*w:author="Beaver"[^>]*><w:r>(?:(?!<\/w:r>).)*registered mail/u);
    expect(rejected(xml)).toEqual(rejected(await docxXml(source)));
    expect(accepted(xml)).toEqual(["Notices may be sent by registered mail or must be in writing.", "Pay no later than 45 days."]);
  }, 120_000);

  it("refuses network, processes and files outside the program's directory", async () => {
    const bytes = await docxBytes([new Paragraph("Clause.")]);
    const outside = path.join(os.tmpdir(), "beaver-word-python-escape.txt");
    for (const program of [
      "import socket\nsocket.create_connection(('example.com', 80))",
      "import importlib\nimportlib.import_module('_socket').socket()",
      "import os\nos.system('echo escaped')",
      "import subprocess\nsubprocess.run(['cmd'])",
      `open(${JSON.stringify(outside)}, 'w').write('escaped')`,
      "return open('../source.docx', 'rb').read(4)",
    ]) await expect(runWordPython(bytes, { action: "inspect", program }, signal), program).rejects.toThrow(/Sandbox:/u);
    const own = await runWordPython(bytes, { action: "inspect", program: "open('scratch.txt', 'w').write('x')\nreturn doc.paragraphs[0].text" }, signal);
    expect(own.report.result).toBe("Clause.");
  }, 120_000);

  it("fails a preview that changes nothing instead of filing a copy", async () => {
    const bytes = await docxBytes([new Paragraph("Clause.")]);
    for (const mode of ["direct", "tracked"])
      await expect(runWordPython(bytes, { action: "preview", mode,
        program: "def edit(doc):\n    doc.paragraphs[0].text = 'Changed.'" }, signal)).rejects.toThrow(/changed nothing/u);
  }, 120_000);
});
