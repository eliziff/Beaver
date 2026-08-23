import { spawn } from "child_process";

import { MAX_DRAFTING_DOCX_BYTES } from "./docx/core";
import { openDocxSession } from "./docx/session";
import { isolatedProcessEnv } from "./subprocessEnv";

const HEADING_OUTLINE_MAP: Record<string, string> = {
  Heading1: "0",
  Heading2: "1",
  Heading3: "2",
  Heading4: "3",
  Heading5: "4",
  Heading6: "5",
};

function cleanError(value: unknown) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function stripHeadingNumbering(documentXml: string) {
  return documentXml.replace(
    /<w:pPr>((?:(?!<\/w:pPr>)[\s\S])*?<w:pStyle\b[^>]*w:val="(Heading\d+)"(?:(?!<\/w:pPr>)[\s\S])*?)<\/w:pPr>/g,
    (_match: string, inner: string, style: string) => {
      let cleaned = inner.replace(/<w:numPr\b[\s\S]*?<\/w:numPr>/g, "");
      const level = HEADING_OUTLINE_MAP[style];
      if (level && !/<w:outlineLvl\b/.test(cleaned)) {
        cleaned = `<w:outlineLvl w:val="${level}"/>${cleaned}`;
      }
      return `<w:pPr>${cleaned}</w:pPr>`;
    },
  );
}

function normalizeStylesForPandoc(stylesXml: string) {
  let result = stylesXml;
  if (!/<w:style\b[^>]*\bw:default="1"/.test(result)) {
    result = result.replace(
      "</w:styles>",
      '<w:style w:default="1" w:styleId="Normal" w:type="paragraph"><w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>',
    );
  }
  return result.replace(
    /<w:style\b[^>]*\bw:styleId="(Heading\d+)"[\s\S]*?<\/w:style>/g,
    (match: string, style: string) => {
      let patched = match.replace(
        /(<w:name\b[^>]*w:val=")Heading (\d)(")/gi,
        (_match: string, before: string, number: string, after: string) =>
          `${before}heading ${number}${after}`,
      );
      const level = HEADING_OUTLINE_MAP[style];
      if (level && !/<w:outlineLvl\b/.test(patched)) {
        patched = patched.replace(
          /(<w:pPr[\s>][^<]*)/,
          `$1<w:outlineLvl w:val="${level}"/>`,
        );
      }
      return patched;
    },
  );
}

function runPandoc(bytes: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pandoc",
      ["-f", "docx", "-t", "gfm", "--sandbox", "--wrap=none", "-o", "-"],
      {
        env: isolatedProcessEnv(),
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 2 * 60 * 1000,
        windowsHide: true,
      },
    );
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    child.stdout.on("data", (data: Buffer) => {
      stdoutBytes += data.length;
      if (stdoutBytes > MAX_DRAFTING_DOCX_BYTES) child.kill();
      else stdout.push(data);
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr = `${stderr}${data.toString("utf8")}`.slice(-8_192);
    });
    child.on("close", (code: number | null) => {
      if (stdoutBytes > MAX_DRAFTING_DOCX_BYTES) {
        reject(new Error("Pandoc conversion output exceeded 25 MiB"));
      } else if (code !== 0) {
        reject(new Error(`Pandoc conversion failed (exit ${code}): ${cleanError(stderr)}`));
      } else {
        resolve(Buffer.concat(stdout, stdoutBytes).toString("utf8"));
      }
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "ENOENT"
          ? new Error("Pandoc is required for drafting mode but was not found on PATH")
          : new Error(`Pandoc conversion failed: ${cleanError(error)}`),
      );
    });
    child.stdin.end(bytes);
  });
}

function cleanMarkdown(markdown: string) {
  return markdown
    .replace(/\r\n?/gu, "\n")
    .replace(/<img\b[^>]*\/?>/giu, "[Image omitted]")
    .replace(/!\[[^\]]*\]\([^)]*\)(?:\{[^}]*\})?/gu, "[Image omitted]")
    .replace(/^\[\]\([^)]*\)\s*$/gmu, "")
    .replace(/\[[^\]]*\]\((?:data|javascript):[^)]*\)/giu, "")
    .replace(/\\(\[|\])/gu, "$1")
    .trim();
}

/** Return the model's structured Markdown view of a DOCX. */
export async function docxDraftingMarkdown(bytes: Buffer): Promise<string> {
  if (!bytes.length || bytes.length > MAX_DRAFTING_DOCX_BYTES) {
    throw new Error("Precedent DOCX exceeds the drafting read limit");
  }
  const session = await openDocxSession(bytes).catch((error: unknown) => {
    throw new Error(cleanError(error).replace(/^DOCX\b/u, "Precedent DOCX"));
  });
  const documentXml = await session
    .readText("word/document.xml")
    .catch((error: unknown) => {
      throw new Error(
        `Precedent DOCX is corrupted (word/document.xml cannot be read): ${cleanError(error)}`,
      );
    });
  if (documentXml == null) throw new Error("Drafting mode requires a valid DOCX");

  const stylesXml = (await session.readText("word/styles.xml").catch(() => "")) ?? "";
  const numberedHeadings =
    /<w:pStyle\b[^>]*w:val="Heading\d+"[\s\S]*?<w:numPr\b/iu.test(documentXml);
  const headingStyles = /<w:style\b[^>]*\bw:styleId="Heading\d+"/.test(stylesXml);
  if (numberedHeadings) {
    session.write("word/document.xml", stripHeadingNumbering(documentXml));
  }
  if (headingStyles) {
    session.write("word/styles.xml", normalizeStylesForPandoc(stylesXml));
  }
  const input = numberedHeadings || headingStyles ? await session.save() : bytes;

  let markdown = cleanMarkdown(
    await runPandoc(input).catch((error: unknown) => {
      const message = cleanError(error);
      if (/not found on PATH/u.test(message)) throw new Error(message);
      throw new Error(
        `Precedent DOCX contains malformed XML in word/document.xml: ${message}`,
      );
    }),
  );
  if (!markdown) {
    const mammoth = await import("mammoth");
    markdown = (await mammoth.extractRawText({ buffer: input })).value;
  }
  if (!markdown) throw new Error("Precedent DOCX has no readable drafting structure");
  return markdown;
}
