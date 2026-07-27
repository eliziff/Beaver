import type JSZip from "jszip";
import { loadZip } from "./zip";
import { readFile } from "node:fs/promises";
import {
  addLocalVersion,
  getLocalVersionFile,
} from "./localDocumentStore";
import { decodeXmlText, escapeXmlText } from "./text";

const SUPRA_PATTERN = /\bsupra,?\s+note\s+(\d+)\b/giu;
const RUN_PATTERN = /<w:r\b([^>]*)>([\s\S]*?)<\/w:r>/gu;
const TEXT_PATTERN = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gu;
const PARAGRAPH_PATTERN = /<w:p\b[\s\S]*?<\/w:p>/gu;

export type SupraCleanupResult = {
  bytes: Buffer;
  detected: number;
  converted: number;
  already_linked: number;
  review_required: number;
  bookmarks_added: number;
  reasons: {
    restarted_numbering: boolean;
    unsafe_or_split_fields: number;
  };
};

function getZipEntry(zip: JSZip, canonicalPath: string) {
  return (
    zip.file(canonicalPath) ??
    zip.file(canonicalPath.replaceAll("/", "\\"))
  );
}

function setZipEntry(zip: JSZip, canonicalPath: string, contents: string) {
  const windowsPath = canonicalPath.replaceAll("/", "\\");
  if (!zip.file(canonicalPath) && zip.file(windowsPath)) {
    zip.file(windowsPath, contents);
    return;
  }
  zip.file(canonicalPath, contents);
}

function elementIsOpen(xml: string, offset: number, tag: string) {
  const prior = xml.slice(0, offset);
  const lastOpen = Math.max(
    prior.lastIndexOf(`<${tag} `),
    prior.lastIndexOf(`<${tag}>`),
  );
  return lastOpen > prior.lastIndexOf(`</${tag}>`);
}

function footnoteReferenceIds(documentXml: string) {
  const ids: number[] = [];
  const pattern =
    /<w:footnoteReference\b[^>]*\bw:id=(?:"(-?\d+)"|'(-?\d+)')[^>]*\/?>/gu;
  for (const match of documentXml.matchAll(pattern)) {
    if (/\bw:customMarkFollows=/u.test(match[0])) continue;
    const id = Number(match[1] ?? match[2]);
    if (Number.isInteger(id) && id > 0) ids.push(id);
  }
  return ids;
}

type ParagraphTextNode = {
  text: string;
  visibleStart: number;
  visibleEnd: number;
  xmlStart: number;
  runStart: number;
  runEnd: number;
  runAttributes: string;
  runBody: string;
  runFull: string;
  runProperties: string;
  safeToReplace: boolean;
};

function noterefFieldSpans(paragraph: string) {
  const markers = [
    ...paragraph.matchAll(
      /<w:fldChar\b[^>]*\bw:fldCharType=(?:"(begin|end)"|'(begin|end)')[^>]*\/?>/gu,
    ),
  ];
  const stack: number[] = [];
  const spans: { start: number; end: number }[] = [];
  for (const marker of markers) {
    const kind = marker[1] ?? marker[2];
    const offset = marker.index ?? 0;
    if (kind === "begin") {
      stack.push(offset);
      continue;
    }
    const start = stack.pop();
    if (
      start !== undefined &&
      /\bNOTEREF\b/iu.test(paragraph.slice(start, offset))
    ) {
      spans.push({ start, end: offset + marker[0].length });
    }
  }
  return spans;
}

function paragraphTextNodes(
  xml: string,
  paragraph: string,
  paragraphOffset: number,
) {
  const nodes: ParagraphTextNode[] = [];
  let visibleOffset = 0;
  for (const run of paragraph.matchAll(RUN_PATTERN)) {
    const runStart = run.index ?? 0;
    const runFull = run[0];
    const runAttributes = run[1] ?? "";
    const runBody = run[2] ?? "";
    const textNodes = [...runBody.matchAll(TEXT_PATTERN)];
    const runProperties =
      runBody.match(/<w:rPr\b[\s\S]*?<\/w:rPr>/u)?.[0] ?? "";
    const onlyText =
      textNodes.length === 1 &&
      !runBody.replace(runProperties, "").replace(textNodes[0][0], "").trim();
    const globalRunOffset = paragraphOffset + runStart;
    const safeToReplace =
      onlyText &&
      !elementIsOpen(xml, globalRunOffset, "w:hyperlink") &&
      !elementIsOpen(xml, globalRunOffset, "w:fldSimple") &&
      !elementIsOpen(xml, globalRunOffset, "w:ins") &&
      !elementIsOpen(xml, globalRunOffset, "w:del");
    for (const textNode of textNodes) {
      const text = decodeXmlText(textNode[1] ?? "");
      const xmlStart =
        runStart +
        runFull.indexOf(runBody) +
        (textNode.index ?? 0);
      nodes.push({
        text,
        visibleStart: visibleOffset,
        visibleEnd: visibleOffset + text.length,
        xmlStart,
        runStart,
        runEnd: runStart + runFull.length,
        runAttributes,
        runBody,
        runFull,
        runProperties,
        safeToReplace,
      });
      visibleOffset += text.length;
    }
  }
  return nodes;
}

function analyzeSupras(xml: string) {
  let detected = 0;
  let alreadyLinked = 0;
  const ordinals = new Set<number>();
  for (const paragraphMatch of xml.matchAll(PARAGRAPH_PATTERN)) {
    const paragraph = paragraphMatch[0];
    const nodes = paragraphTextNodes(
      xml,
      paragraph,
      paragraphMatch.index ?? 0,
    );
    const visibleText = nodes.map((node) => node.text).join("");
    const fieldSpans = noterefFieldSpans(paragraph);
    for (const match of visibleText.matchAll(SUPRA_PATTERN)) {
      detected += 1;
      if (match.index === undefined) continue;
      const ordinal = Number(match[1]);
      const numberStart =
        match.index + match[0].lastIndexOf(match[1]);
      const numberEnd = numberStart + match[1].length;
      const node = nodes.find(
        (candidate) =>
          candidate.visibleStart <= numberStart &&
          candidate.visibleEnd >= numberEnd,
      );
      const isLinked =
        !!node &&
        fieldSpans.some(
          (span) =>
            span.start <= node.xmlStart && node.xmlStart < span.end,
        );
      if (isLinked) {
        alreadyLinked += 1;
      } else if (Number.isInteger(ordinal) && ordinal > 0) {
        ordinals.add(ordinal);
      }
    }
  }
  return { detected, alreadyLinked, ordinals };
}

function nextBookmarkId(documentXml: string) {
  let maximum = 0;
  for (const match of documentXml.matchAll(
    /<w:bookmark(?:Start|End)\b[^>]*\bw:id=(?:"(\d+)"|'(\d+)')/gu,
  )) {
    maximum = Math.max(maximum, Number(match[1] ?? match[2]));
  }
  return maximum + 1;
}

function addTargetBookmarks(
  documentXml: string,
  referenceIds: number[],
  ordinals: Set<number>,
) {
  let xml = documentXml;
  let bookmarkId = nextBookmarkId(documentXml);
  let added = 0;
  const names = new Map<number, string>();

  for (const ordinal of [...ordinals].sort((left, right) => left - right)) {
    const referenceId = referenceIds[ordinal - 1];
    if (!referenceId) continue;
    const name = `MikeSupraNote${ordinal}`;
    names.set(ordinal, name);
    if (
      new RegExp(
        `<w:bookmarkStart\\b[^>]*\\bw:name=(?:"${name}"|'${name}')`,
        "u",
      ).test(xml)
    ) {
      continue;
    }
    const runPattern = new RegExp(
      `<w:r\\b[^>]*>(?:(?!<\\/w:r>)[\\s\\S])*?<w:footnoteReference\\b[^>]*\\bw:id=(?:"${referenceId}"|'${referenceId}')[^>]*\\/?>[\\s\\S]*?<\\/w:r>`,
      "u",
    );
    const target = xml.match(runPattern)?.[0];
    if (!target) {
      names.delete(ordinal);
      continue;
    }
    xml = xml.replace(
      target,
      `<w:bookmarkStart w:id="${bookmarkId}" w:name="${name}"/>${target}<w:bookmarkEnd w:id="${bookmarkId}"/>`,
    );
    bookmarkId += 1;
    added += 1;
  }

  return { xml, names, added };
}

function plainRun(attributes: string, runProperties: string, text: string) {
  if (!text) return "";
  return `<w:r${attributes}>${runProperties}<w:t xml:space="preserve">${escapeXmlText(text)}</w:t></w:r>`;
}

function noteRefField(
  attributes: string,
  runProperties: string,
  bookmarkName: string,
  displayNumber: string,
) {
  return [
    `<w:r${attributes}>${runProperties}<w:fldChar w:fldCharType="begin"/></w:r>`,
    `<w:r${attributes}>${runProperties}<w:instrText xml:space="preserve"> NOTEREF ${bookmarkName} \\h </w:instrText></w:r>`,
    `<w:r${attributes}>${runProperties}<w:fldChar w:fldCharType="separate"/></w:r>`,
    plainRun(attributes, runProperties, displayNumber),
    `<w:r${attributes}>${runProperties}<w:fldChar w:fldCharType="end"/></w:r>`,
  ].join("");
}

function convertSafeParagraphs(
  xml: string,
  bookmarkNames: Map<number, string>,
) {
  let converted = 0;
  const result = xml.replace(PARAGRAPH_PATTERN, (paragraph, offset: number) => {
    const nodes = paragraphTextNodes(xml, paragraph, offset);
    const visibleText = nodes.map((node) => node.text).join("");
    const fieldSpans = noterefFieldSpans(paragraph);
    const candidates = new Map<
      number,
      {
        node: ParagraphTextNode;
        numberStart: number;
        numberText: string;
        bookmarkName: string;
      }[]
    >();

    for (const match of visibleText.matchAll(SUPRA_PATTERN)) {
      if (match.index === undefined) continue;
      const numberText = match[1];
      const ordinal = Number(numberText);
      const bookmarkName = bookmarkNames.get(ordinal);
      if (!bookmarkName) continue;
      const numberStart =
        match.index + match[0].lastIndexOf(numberText);
      const numberEnd = numberStart + numberText.length;
      const node = nodes.find(
        (candidate) =>
          candidate.visibleStart <= numberStart &&
          candidate.visibleEnd >= numberEnd,
      );
      if (
        !node?.safeToReplace ||
        fieldSpans.some(
          (span) =>
            span.start <= node.xmlStart && node.xmlStart < span.end,
        )
      ) {
        continue;
      }
      const current = candidates.get(node.runStart) ?? [];
      current.push({ node, numberStart, numberText, bookmarkName });
      candidates.set(node.runStart, current);
    }

    const edits: { start: number; end: number; replacement: string }[] = [];
    for (const rows of candidates.values()) {
      const node = rows[0].node;
      const ordered = rows
        .slice()
        .sort((left, right) => left.numberStart - right.numberStart);
      let cursor = 0;
      let replacement = "";
      for (const row of ordered) {
        const localStart = row.numberStart - node.visibleStart;
        replacement += plainRun(
          node.runAttributes,
          node.runProperties,
          node.text.slice(cursor, localStart),
        );
        replacement += noteRefField(
          node.runAttributes,
          node.runProperties,
          row.bookmarkName,
          row.numberText,
        );
        cursor = localStart + row.numberText.length;
        converted += 1;
      }
      replacement += plainRun(
        node.runAttributes,
        node.runProperties,
        node.text.slice(cursor),
      );
      edits.push({
        start: node.runStart,
        end: node.runEnd,
        replacement,
      });
    }
    let nextParagraph = paragraph;
    for (const edit of edits.sort((left, right) => right.start - left.start)) {
      nextParagraph =
        nextParagraph.slice(0, edit.start) +
        edit.replacement +
        nextParagraph.slice(edit.end);
    }
    return nextParagraph;
  });
  return { xml: result, converted };
}

export async function fixDocxSupraCrossReferences(
  bytes: Buffer,
): Promise<SupraCleanupResult> {
  const zip = await loadZip(bytes);
  const documentEntry = getZipEntry(zip, "word/document.xml");
  const footnotesEntry = getZipEntry(zip, "word/footnotes.xml");
  if (!documentEntry || !footnotesEntry) {
    throw new Error("DOCX does not contain ordinary Word footnotes");
  }

  const [documentXml, footnotesXml, settingsXml] = await Promise.all([
    documentEntry.async("string"),
    footnotesEntry.async("string"),
    getZipEntry(zip, "word/settings.xml")?.async("string") ?? "",
  ]);
  const documentAnalysis = analyzeSupras(documentXml);
  const footnoteAnalysis = analyzeSupras(footnotesXml);
  const detected =
    documentAnalysis.detected + footnoteAnalysis.detected;
  const alreadyLinked =
    documentAnalysis.alreadyLinked + footnoteAnalysis.alreadyLinked;
  const restartedNumbering = /<w:numRestart\b/iu.test(
    `${documentXml}\n${settingsXml}`,
  );
  if (!detected || restartedNumbering) {
    return {
      bytes,
      detected,
      converted: 0,
      already_linked: alreadyLinked,
      review_required: Math.max(0, detected - alreadyLinked),
      bookmarks_added: 0,
      reasons: {
        restarted_numbering: restartedNumbering,
        unsafe_or_split_fields: Math.max(0, detected - alreadyLinked),
      },
    };
  }

  const ordinals = new Set([
    ...documentAnalysis.ordinals,
    ...footnoteAnalysis.ordinals,
  ]);
  const references = footnoteReferenceIds(documentXml);
  const bookmarks = addTargetBookmarks(documentXml, references, ordinals);
  const bodyConversion = convertSafeParagraphs(
    bookmarks.xml,
    bookmarks.names,
  );
  const footnoteConversion = convertSafeParagraphs(
    footnotesXml,
    bookmarks.names,
  );
  const converted = bodyConversion.converted + footnoteConversion.converted;
  const reviewRequired = Math.max(
    0,
    detected - converted - alreadyLinked,
  );

  if (!converted) {
    return {
      bytes,
      detected,
      converted,
      already_linked: alreadyLinked,
      review_required: reviewRequired,
      bookmarks_added: 0,
      reasons: {
        restarted_numbering: false,
        unsafe_or_split_fields: reviewRequired,
      },
    };
  }

  setZipEntry(zip, "word/document.xml", bodyConversion.xml);
  setZipEntry(zip, "word/footnotes.xml", footnoteConversion.xml);
  return {
    bytes: await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
    }),
    detected,
    converted,
    already_linked: alreadyLinked,
    review_required: reviewRequired,
    bookmarks_added: bookmarks.added,
    reasons: {
      restarted_numbering: false,
      unsafe_or_split_fields: reviewRequired,
    },
  };
}

export async function fixLocalDocxSupraCrossReferences(
  userId: string,
  documentId: string,
) {
  const file = await getLocalVersionFile(userId, documentId);
  if (!file) throw new Error("Document not found");
  if (file.fileType.toLowerCase() !== "docx") {
    throw new Error("Supra cleanup currently requires a DOCX document");
  }
  const cleanup = await fixDocxSupraCrossReferences(
    await readFile(file.path),
  );
  if (!cleanup.converted) {
    return {
      ok: true,
      changed: false,
      document_id: documentId,
      version_id: file.version.id,
      filename: file.version.filename,
      ...cleanup,
      bytes: undefined,
    };
  }

  const baseName = file.document.filename.replace(/\.docx$/iu, "");
  const version = await addLocalVersion({
    userId,
    documentId,
    filename: `${baseName} - supras fixed.docx`,
    bytes: cleanup.bytes,
  });
  if (!version) throw new Error("Document disappeared before saving");
  return {
    ok: true,
    changed: true,
    document_id: documentId,
    version_id: version.id,
    filename: version.filename,
    ...cleanup,
    bytes: undefined,
  };
}
