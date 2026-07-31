import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { once } from "node:events";

import { describe, expect, it } from "vitest";

import { compileA2AJSourceDoc } from "../sourceDocA2AJ";

const backend = path.resolve(__dirname, "../../..");
const root = path.resolve(backend, "..");

async function bridge(requests: unknown[]) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/sourcedoc-jsonl.ts"],
    { cwd: backend, stdio: ["pipe", "pipe", "inherit"] },
  );
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stdin.end(`${requests.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const [code] = (await once(child, "close")) as [number];
  expect(code).toBe(0);
  return output
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function topLevel(doc: ReturnType<typeof compileA2AJSourceDoc>, kind: string) {
  return doc.blocks
    .filter((block) => block.kind === kind && !block.parentLabel)
    .map(({ label, start, end, origin }) => ({ label, start, end, origin }));
}

describe("SourceDoc JSONL protocol", () => {
  it("returns exact production tuples and fails closed", async () => {
    const caseText = [1, 2, 3, 4, 5]
      .map(
        (number) =>
          `[${number}] This paragraph contains enough ordinary words to ` +
          "exercise the production compiler without a benchmark-side detector.",
      )
      .join("\n");
    const lawText =
      "1 First provision with enough text.\n" +
      "2 Second provision with enough text.\n" +
      "3 Third provision with enough text.";
    const caseRequest = {
      id: "case",
      docType: "cases" as const,
      citation: "2026 ONCA 1",
      dataset: "ONCA",
      text: caseText,
    };
    const lawRequest = {
      id: "law",
      docType: "laws" as const,
      citation: "Test Act",
      dataset: "LEGISLATION-ON",
      text: lawText,
    };
    const [caseResult, lawResult, malformed] = await bridge([
      caseRequest,
      lawRequest,
      { id: "bad", docType: "cases" },
    ]);

    expect(caseResult.compiler).toBe("compileA2AJSourceDoc");
    expect(caseResult.blocks).toMatchObject({
      paragraph: topLevel(
        compileA2AJSourceDoc(caseRequest),
        "paragraph",
      ),
    });
    expect(lawResult.blocks).toMatchObject({
      section: topLevel(compileA2AJSourceDoc(lawRequest), "section"),
    });
    expect(malformed).toMatchObject({
      compiler: "compileA2AJSourceDoc",
      id: "bad",
    });
    expect(malformed.error).toEqual(expect.any(String));
  });

  it("returns provider-map rendition slices without exporting offsets to Python", async () => {
    const request = {
      id: "mapped-law",
      docType: "laws" as const,
      citation: "Test Act",
      text: "This whole-text rendition is not the provider section map.",
      sectionMap: {
        "1": "😀 First provider section.",
        "2": "Second provider section.",
      },
    };
    const [result] = await bridge([request]);
    const doc = compileA2AJSourceDoc(request);
    const rendition = result.rendition as {
      kind: string;
      segments: Array<{
        kind: string;
        label?: string;
        origin?: string;
        text: string;
      }>;
    };

    expect(rendition.kind).toBe("sections");
    expect(rendition.segments.map(({ text }) => text).join("")).toBe(doc.text);
    expect(rendition.segments.filter(({ kind }) => kind === "section")).toEqual([
      {
        kind: "section",
        label: "sec1",
        aliases: [],
        origin: "native",
        text: "😀 First provider section.",
      },
      {
        kind: "section",
        label: "sec2",
        aliases: [],
        origin: "native",
        text: "Second provider section.",
      },
    ]);
  });

  it("records production-only short-ladder structure in the sweep", () => {
    const script = [
      "import json,sys",
      "sys.path.insert(0, r'benchmarks/structure_stress')",
      "import sweep",
      "from sourcedoc_client import close_client",
      "text='[1] This complete paragraph contains enough ordinary substantive words " +
        "to exercise the production short ladder compiler mechanism and demonstrate " +
        "that a real judicial reason rather than a quoted list owns the whole document.\\n" +
        "[2] This complete paragraph contains enough ordinary substantive words " +
        "to exercise the production short ladder compiler mechanism and demonstrate " +
        "that a real judicial reason rather than a quoted list owns the whole document.\\n" +
        "[3] This complete paragraph contains enough ordinary substantive words " +
        "to exercise the production short ladder compiler mechanism and demonstrate " +
        "that a real judicial reason rather than a quoted list owns the whole document.\\n" +
        "[4] This complete paragraph contains enough ordinary substantive words " +
        "to exercise the production short ladder compiler mechanism and demonstrate " +
        "that a real judicial reason rather than a quoted list owns the whole document.'",
      "row=sweep.scan_doc(('ONCA:test:en','case',text," +
        "{'self_cite':'2026 ONCA 1','dataset':'ONCA','cited_count':0}))",
      "print(json.dumps(row['structure']))",
      "close_client()",
    ].join(";");
    const run = spawnSync("python", ["-c", script], {
      cwd: root,
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      engine: "compileA2AJSourceDoc",
      kind: "paragraphs",
      count: 4,
      first: 1,
      last: 4,
    });
  });

  it("measures law reconstruction without forwarding provider sections", () => {
    const script = [
      "import json,sys",
      "sys.path.insert(0, r'benchmarks/structure_stress')",
      "import sweep",
      "from sourcedoc_client import close_client",
      "text='1 First reconstructed provision.\\n" +
        "2 Second reconstructed provision.\\n" +
        "3 Third reconstructed provision.'",
      "row=sweep.scan_doc(('LAW:test:en','law',text," +
        "{'citation':'Test Act','dataset':'LEGISLATION-ON'," +
        "'section_labels':['9'],'section_map':{'9':'Provider-only rendition.'}}))",
      "print(json.dumps(row['sections']))",
      "close_client()",
    ].join(";");
    const run = spawnSync("python", ["-c", script], {
      cwd: root,
      encoding: "utf8",
    });

    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      engine: "compileA2AJSourceDoc",
      expected_count: 1,
      actual: 3,
      recovery_production: 0,
      precision_production: 0,
    });
  });
});
