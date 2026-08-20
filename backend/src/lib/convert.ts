import { execFile } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type JSZip from "jszip";
import { createParser, elAttrs, elChildren, elName, getTextContent, type XNode } from "./docx/core";
import { decodeXmlText } from "./text";
import { assertBoundedZip, loadZip, readZipEntry, zipReadBudget } from "./zip";
import { isolatedProcessEnv } from "./subprocessEnv";

const MAX_OFFICE_BYTES = 100 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const execute = promisify(execFile);
let sofficeBinary: string | null | undefined;

function xmlElements(nodes: XNode[], wanted: string): XNode[] {
  return nodes.flatMap((node) => [
    ...(elName(node)?.split(":").at(-1) === wanted ? [node] : []),
    ...xmlElements(elChildren(node), wanted),
  ]);
}

function executable(file: string) {
  try { fs.accessSync(file, fs.constants.X_OK); return true; }
  catch { return false; }
}

function resolveSofficeBinary() {
  if (sofficeBinary !== undefined) return sofficeBinary;
  const windows = process.platform === "win32";
  const names = windows ? ["soffice.exe"] : ["soffice", "libreoffice"];
  const candidates = [
    process.env.SOFFICE_BINARY_PATH,
    process.env.LIBREOFFICE_BINARY_PATH,
    process.env.LIBRE_OFFICE_EXE,
    ...(process.env.PATH ?? "").split(path.delimiter)
      .flatMap((directory) => directory ? names.map((name) => path.join(directory, name)) : []),
    ...(windows
      ? [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
          .flatMap((directory) => directory
            ? [path.join(directory, "LibreOffice", "program", "soffice.exe")] : [])
      : ["/usr/bin/libreoffice", "/usr/bin/soffice", "/snap/bin/libreoffice",
          "/opt/libreoffice/program/soffice", "/opt/libreoffice7.6/program/soffice",
          "/Applications/LibreOffice.app/Contents/MacOS/soffice"]),
  ].flatMap((candidate) => candidate?.trim() ? [candidate.trim()] : []);
  return sofficeBinary = [...new Set(candidates)].find(executable) ?? null;
}

export async function assertSafeOfficeConversion(zip: JSZip) {
  const budget = zipReadBudget(128 * 1024 * 1024);
  for (const entry of Object.values(zip.files)) {
    const name = entry.name.replace(/\\/gu, "/").toLowerCase();
    if (entry.dir) continue;
    if (name.includes("/embeddings/") || name.includes("/activex/") ||
        name.endsWith("vbaproject.bin")) {
      throw new Error("Office document contains an embedded object");
    }
    if (name.endsWith(".rels")) {
      const xml = (await readZipEntry(entry, 64 * 1024 * 1024, budget,
        "Office XML")).toString("utf8");
      for (const relationship of xmlElements(createParser().parse(xml) as XNode[], "Relationship")) {
        const attrs = elAttrs(relationship);
        const attribute = (name: string) => decodeXmlText(attrs[`@_${name}`] ?? "");
        if (attribute("TargetMode") === "External" &&
            (!attribute("Type").endsWith("/hyperlink") ||
              !/^(?:https?:|mailto:)/iu.test(attribute("Target")))) {
          throw new Error("Office document contains an active external relationship");
        }
      }
    }
    if (name === "word/document.xml") {
      const xml = (await readZipEntry(entry, 64 * 1024 * 1024, budget,
        "Office document XML")).toString("utf8");
      const parsed = createParser().parse(xml) as XNode[];
      const instructions = xmlElements(parsed, "instrText")
        .map(getTextContent).join("").replace(/\s+/gu, "");
      if (xmlElements(parsed, "altChunk").length ||
          /(?:DDEAUTO|INCLUDETEXT|INCLUDEPICTURE)/iu.test(instructions)) {
        throw new Error("Office document contains active linked content");
      }
    }
  }
}

async function normalizeDocxZipPaths(buffer: Buffer): Promise<Buffer> {
  let zip: JSZip;
  try { zip = await loadZip(buffer); }
  catch {
    const ole = buffer.subarray(0, 8).equals(
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    );
    if (ole || buffer.subarray(0, 5).toString() === "{\\rtf") return buffer;
    throw new Error("Office document archive is invalid");
  }
  assertBoundedZip(zip, "Office document", {
    maxEntries: 10_000, maxExpandedBytes: MAX_EXPANDED_BYTES,
    selected: { test: /\.xml(?:\.rels)?$/iu, maxEntryBytes: 64 * 1024 * 1024,
      maxBytes: 128 * 1024 * 1024, name: "XML part" },
  });
  await assertSafeOfficeConversion(zip);
  const actualByCanonical = new Map<string, string>();
  for (const entry of Object.values(zip.files)) {
    const canonical = entry.name.replace(/\\/gu, "/");
    const prior = actualByCanonical.get(canonical);
    if (prior && prior !== entry.name)
      throw new Error(`Office document contains duplicate package part ${canonical}`);
    actualByCanonical.set(canonical, entry.name);
  }
  const renames = [...actualByCanonical].filter(([canonical, actual]) => canonical !== actual);
  if (!renames.length) return buffer;
  const budget = zipReadBudget(MAX_EXPANDED_BYTES);
  for (const [canonical, actual] of renames) {
    const entry = zip.file(actual);
    if (!entry) continue;
    zip.file(canonical, await readZipEntry(entry, MAX_OFFICE_BYTES, budget,
      "Office package part"));
    zip.remove(actual);
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

export async function docxToPdf(buffer: Buffer): Promise<Buffer> {
  if (!buffer.length || buffer.length > MAX_OFFICE_BYTES)
    throw new Error("Office document is empty or exceeds the conversion limit");
  const binary = resolveSofficeBinary();
  if (!binary) throw new Error(
    "LibreOffice/soffice binary was not found. Ensure Railway uses backend/nixpacks.toml or set SOFFICE_BINARY_PATH/LIBREOFFICE_BINARY_PATH.",
  );
  const temporary = await mkdtemp(path.join(os.tmpdir(), "beaver-soffice-"));
  const source = path.join(temporary, "source"), output = `${source}.pdf`;
  try {
    await writeFile(source, await normalizeDocxZipPaths(buffer), { mode: 0o600 });
    await execute(binary, [
      `-env:UserInstallation=${pathToFileURL(path.join(temporary, "profile")).href}`,
      "--headless", "--norestore", "--convert-to", "pdf:writer_pdf_Export",
      "--outdir", temporary, source,
    ], { cwd: temporary, env: isolatedProcessEnv(["SAL_*", "URE_*"]),
      timeout: 3 * 60_000, maxBuffer: 1024 * 1024, windowsHide: true });
    const size = (await stat(output)).size;
    if (!size || size > MAX_OFFICE_BYTES)
      throw new Error("LibreOffice PDF output is empty or exceeds the storage limit");
    const pdf = await readFile(output);
    if (!pdf.subarray(0, 5).equals(Buffer.from("%PDF-")))
      throw new Error("LibreOffice returned an invalid PDF");
    return pdf;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
