/** Real gateway/QuickJS/Writer tests. Missing runtime is a failure, never a skip. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import JSZip from "jszip";
import { runLibreOffice } from "../../src/lib/libreOffice";
import { resolveUnoRuntime } from "../../src/lib/libreOfficeRuntime";
import { executeWordProgram } from "../../src/lib/libreOfficeConsole";

const exec = promisify(execFile), signal = new AbortController().signal;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "beaver-console-test-"));
  try {
    const runtime = await resolveUnoRuntime(), output = path.join(directory, "source.docx");
    const script = path.resolve(__dirname, "test_worker.py");
    const code = "import sys,os,json,importlib.util; from pathlib import Path; " +
      "paths=json.loads(sys.argv[1]); sys.path[:0]=paths; " +
      "dlls=[os.add_dll_directory(p) for p in paths if os.name=='nt' and os.path.isdir(p)]; " +
      "s=importlib.util.spec_from_file_location('fixtures',sys.argv[2]); m=importlib.util.module_from_spec(s); " +
      "s.loader.exec_module(m); m.fixture(Path(sys.argv[3]))";
    await exec(runtime.python, ["-I", "-c", code, JSON.stringify(runtime.modulePaths), script, output],
      { env: runtime.env, windowsHide: true, timeout: 20000 });
    console.log(JSON.stringify({ platform: process.platform, architecture: process.arch,
      python: runtime.pythonVersion, soffice: runtime.soffice }));
    return await readFile(output);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
const source = fixture();
async function preview(bytes: Buffer, program: string, mode: "tracked" | "direct" = "direct") {
  return runLibreOffice(bytes, { action: "preview", snapshot: hash(bytes), program, mode }, signal);
}
async function xml(bytes: Buffer, name: string) {
  const file = (await JSZip.loadAsync(bytes)).file(name); assert.ok(file, name);
  return file.async("string");
}

test("QuickJS programs are expressive, isolated, and promptly cancellable", async () => {
  assert.deepEqual(await executeWordProgram("let n=0; for(let i=0;i<100;i++) n+=i; return [n,typeof process,typeof require,typeof fetch];",
    async () => { throw new Error("No native call expected"); }, signal), [4950, "undefined", "undefined", "undefined"]);
  const controller = new AbortController(), start = Date.now();
  const task = executeWordProgram("while(true){}", async () => null, controller.signal);
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(task, /cancelled/);
  assert.ok(Date.now() - start < 5000, "CPU loop must not block Stop on the host");
  await assert.rejects(executeWordProgram("return 'x'.repeat(100000);", async () => null, signal), /result exceeds/);
});

test("real console discovers native APIs and performs compound edits", async () => {
  const bytes = await source;
  const { report, candidate } = await preview(bytes, `
    const t=word.target('table:Table1');
    word.assert(t.describe('Header').items.length>0);
    t.set({RepeatHeadline:true});
    t.get('Rows').call('insertByIndex',2,1);
    for (const [cell,text] of [['A3','Additional item'],['B3','$250']]) t.call('getCellByName',cell).set({String:text});
    word.batch([{target:'footnote:0',replace:{find:'paragraph 12',text:'paragraph 15'}}]);
    const text=doc.get('Text'), cursor=text.call('createTextCursor'); cursor.call('gotoStart',false);
    const bookmark=word.create('com.sun.star.text.Bookmark'); bookmark.set({Name:'beaver_anchor'});
    text.call('insertTextContent',cursor,bookmark,false);
    word.target('cell:Table1/A3').expect({String:'Additional item'});
    return {rows:t.get('Rows').get('Count'),footnotes:word.inspect({family:'footnote'}).total};
  `);
  assert.ok(candidate); assert.equal(report.reopened, true);
  assert.deepEqual(report.result, { rows: 3, footnotes: 1 });
  assert.match(await xml(candidate, "word/document.xml"), /Additional item/);
  assert.match(await xml(candidate, "word/document.xml"), /tblHeader/);
  assert.match(await xml(candidate, "word/document.xml"), /beaver_anchor/);
  assert.match(await xml(candidate, "word/footnotes.xml"), /paragraph 15/);
  assert.match(await xml(candidate, "word/comments.xml"), /Do not remove my note/);
  if (process.env.UNO_EVIDENCE_DIR) {
    await mkdir(process.env.UNO_EVIDENCE_DIR, { recursive: true });
    await writeFile(path.join(process.env.UNO_EVIDENCE_DIR, process.platform + "-candidate.docx"), candidate);
    await writeFile(path.join(process.env.UNO_EVIDENCE_DIR, process.platform + "-receipt.json"), JSON.stringify(report, null, 2));
  }
});

test("text and note edits are native revisions and can be rejected without erasing earlier reviews", async () => {
  const { candidate, report } = await preview(await source, `
    word.batch([{target:'paragraph:1',replace:{find:'unchanged',text:'revised'}},
      {target:'footnote:0',replace:{find:'paragraph 12',text:'paragraph 15'}}]);
    return word.inspect({family:'revision',limit:100});
  `, "tracked");
  assert.ok(candidate); assert.equal(report.review_verified, true);
  assert.equal(report.mode, "tracked-candidate");
  assert.match(await xml(candidate, "word/document.xml"), /w:ins/);
  assert.match(await xml(candidate, "word/footnotes.xml"), /w:del/);
  const { candidate: rejected } = await preview(candidate, `
    const changes=word.inspect({family:'revision',limit:100}).items;
    word.review(changes.filter(r=>r.author===${JSON.stringify(report.author)}).map(r=>r.target),'reject');
    return word.inspect({family:'revision',limit:100});
  `, "tracked");
  assert.ok(rejected);
  assert.match(await xml(rejected, "word/footnotes.xml"), /paragraph 12/);
  assert.doesNotMatch(await xml(rejected, "word/footnotes.xml"), /paragraph 15/);
  assert.match(await xml(rejected, "word/document.xml"), /retained insertion/);
  assert.match(await xml(rejected, "word/document.xml"), /retained deletion/);
});

test("untrackable mixed changes fail rather than bypass Review mode", async () => {
  await assert.rejects(preview(await source, `
    word.batch([{target:'paragraph:1',replace:{find:'unchanged',text:'revised'}}]);
    word.target('page-style:Standard').set({LeftMargin:1905});
  `, "tracked"), /reviewable|tracked/);
});

test("creation, readonly policy, unsafe native access, and failed programs use the same gateway", async () => {
  const bytes = await source;
  const made = await preview(bytes, `
    const text=doc.get('Text'),cursor=text.call('createTextCursor'); cursor.call('gotoStart',false);
    const note=word.create('com.sun.star.text.Footnote');text.call('insertTextContent',cursor,note,false);
    note.set({String:'New native note.'}); return word.inspect({family:'footnote'}).total;
  `);
  assert.ok(made.candidate); assert.equal(made.report.result, 2);
  await assert.rejects(runLibreOffice(bytes, {action:'inspect',snapshot:hash(bytes),program:"word.target('paragraph:1').set({String:'forbidden'});"}, signal), /read-only/);
  await assert.rejects(preview(bytes, "doc.get('BasicLibraries');"), /document-only/);
  await assert.rejects(preview(bytes, "word.target('paragraph:1').set({HyperLinkURL:'file:///etc/passwd'});"), /HTTP|document/);
  await assert.rejects(preview(bytes, "word.target('paragraph:1').set({String:'temporary'}); throw new Error('discard me');"), /discard me/);
  const inspected = await runLibreOffice(bytes, { action:'inspect', target:'paragraph:1' }, signal);
  assert.match(String(inspected.report.text), /stays unchanged/);
});
