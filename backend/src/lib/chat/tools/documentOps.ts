import {
  normalizeDocxControlTag,
  renderDocxMarkdown,
  type RenderDocxMarkdownOptions,
} from "./docxMarkdown";

function docxFieldValues(raw: unknown) {
  if (raw === undefined) return {};
  if (!Array.isArray(raw) || raw.length > 100) {
    throw new Error("DOCX fields must be an array of at most 100 values.");
  }
  // Report every bad field in one error so the model can fix the whole call
  // in a single retry instead of discovering problems one round-trip at a time.
  const values: Record<string, string> = {};
  const problems: string[] = [];
  let totalLength = 0;
  for (const [index, item] of raw.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      problems.push(`fields[${index}] must be an object with id and value.`);
      continue;
    }
    const record = item as Record<string, unknown>;
    const id =
      typeof record.id === "string"
        ? normalizeDocxControlTag(record.id)
        : null;
    if (!id) {
      problems.push(
        `fields[${index}].id must normalize to an identifier beginning with a letter.`,
      );
      continue;
    }
    if (Object.hasOwn(values, id)) {
      problems.push(`field "${id}" is duplicated.`);
      continue;
    }
    if (typeof record.value !== "string" || record.value.length > 20_000) {
      problems.push(
        `field "${id}" value must be a string of at most 20,000 characters.`,
      );
      continue;
    }
    totalLength += record.value.length;
    values[id] = record.value;
  }
  if (totalLength > 200_000) {
    problems.push("field values exceed 200,000 characters in total.");
  }
  if (problems.length) {
    throw new Error(
      `DOCX fields rejected: ${problems.join(" ")} Fix every listed field and retry the same call.`,
    );
  }
  return values;
}

export async function renderMarkdownDocx(
  title: string,
  markdown: string,
  fields?: unknown,
  options?: Omit<RenderDocxMarkdownOptions, "title" | "values">,
) {
  const bytes = await renderDocxMarkdown(markdown, {
    ...options,
    title,
    values: docxFieldValues(fields),
  });
  return { filename: safeGeneratedFilename(title, "docx"), bytes };
}

export function safeGeneratedFilename(title: string, extension: string) {
  const safeTitle =
    title
      .replace(/\.(?:docx|xlsx|pptx)$/iu, "")
      .replace(/[^a-zA-Z0-9 -]/g, "")
      .trim()
      .slice(0, 64) || "document";
  return `${safeTitle}.${extension}`;
}

function xmlEscape(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function normalizeSheetName(value: string, fallback: string) {
  const raw = value.trim() || fallback;
  return (
    raw
      .replace(/[:\\/?*[\]]/g, " ")
      .trim()
      .slice(0, 31) || fallback
  );
}

function markdownSections(markdown: string, initial?: string) {
  const sections: Array<{ title: string; lines: string[] }> = initial === undefined
    ? [] : [{ title: initial, lines: [] }];
  for (const line of markdown.split(/\r?\n/u)) {
    const heading = /^##\s+(.+)$/u.exec(line);
    if (heading) sections.push({ title: heading[1].trim(), lines: [] });
    else sections.at(-1)?.lines.push(line);
  }
  return sections;
}

export function workbookFromMarkdown(markdown: string) {
  const sheets = markdownSections(markdown, "Sheet 1").flatMap(({ title, lines }) => {
    const table = lines.flatMap((line) => {
      if (!/^\s*\|.*\|\s*$/u.test(line)) return [];
      const cells = line.trim().slice(1, -1).split("|").map((cell) => cell.trim());
      return cells.every((cell) => /^:?-{3,}:?$/u.test(cell)) ? [] : [cells];
    });
    return table.length
      ? [{ name: title, columns: table[0], rows: table.slice(1) }]
      : [];
  });
  if (!sheets.length) throw new Error("XLSX content requires at least one pipe table.");
  return sheets;
}

export function presentationFromMarkdown(markdown: string) {
  const slides = markdownSections(markdown).map(({ title, lines }) => ({
    title,
    bullets: lines.join("\n")
      .replace(/^```notes\s*$[\s\S]*?(?:^```\s*$|(?![\s\S]))/gimu, "")
      .split("\n")
      .flatMap((line) => {
        const bullet = /^\s*(?:[-*+] |\d+[.)]\s+)(.+)$/u.exec(line);
        return bullet ? [bullet[1].trim()] : [];
      }),
  }));
  if (!slides.length) throw new Error("PPTX content requires at least one ## slide heading.");
  return slides;
}

export async function renderXlsxWorkbook(
  title: string,
  sheets: ReturnType<typeof workbookFromMarkdown>,
) {
  const XLSX = await import("xlsx");
  const workbook = XLSX.utils.book_new();
  workbook.Props = { Title: title, Author: "Beaver" };
  sheets.forEach((sheet, index) => {
    const header = sheet.columns.length ? sheet.columns : ["Value"];
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        header,
        ...sheet.rows.map((row) => header.map((_, column) => row[column] ?? "")),
      ]),
      normalizeSheetName(sheet.name, `Sheet ${index + 1}`),
      true,
    );
  });
  return Buffer.from(
    XLSX.write(workbook, {
      type: "buffer",
      bookType: "xlsx",
      compression: true,
    }),
  );
}

function pptTextParagraphs(lines: string[], title = false) {
  const titleAttrs = title ? ' sz="3200" b="1"' : ' sz="2000"';
  const bullet = title
    ? ""
    : '<a:pPr marL="342900" indent="-171450"><a:buChar char="&#8226;"/></a:pPr>';
  return lines
    .map(
      (line) =>
        `<a:p>${bullet}<a:r><a:rPr lang="en-US"${titleAttrs}/><a:t>${xmlEscape(line)}</a:t></a:r></a:p>`,
    )
    .join("");
}

function pptShape(
  id: number,
  name: string,
  x: number,
  y: number,
  cx: number,
  cy: number,
  body: string,
) {
  return `<p:sp>
  <p:nvSpPr><p:cNvPr id="${id}" name="${xmlEscape(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
  <p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>
  <p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${body}</p:txBody>
</p:sp>`;
}

const pptRelationships = (...relationships: string[]) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${relationships.join("\n")}
</Relationships>`;

export async function buildPptxPresentation(
  slides: ReturnType<typeof presentationFromMarkdown>,
) {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();

  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
${slides
  .map(
    (_, i) =>
      `  <Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
  )
  .join("\n")}
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    pptRelationships('  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>'),
  );
  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId${slides.length + 1}"/></p:sldMasterIdLst>
  <p:sldIdLst>
${slides.map((_, i) => `    <p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join("\n")}
  </p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000" type="screen16x9"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`,
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    pptRelationships(
      ...slides.map(
    (_, i) =>
      `  <Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`,
      ),
      `  <Relationship Id="rId${slides.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>`,
      `  <Relationship Id="rId${slides.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>`,
    ),
  );
  zip.file(
    "ppt/slideMasters/slideMaster1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>
  <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>`,
  );
  zip.file(
    "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    pptRelationships(
      '  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>',
      '  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>',
    ),
  );
  zip.file(
    "ppt/slideLayouts/slideLayout1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank">
  <p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>
</p:sldLayout>`,
  );
  zip.file(
    "ppt/theme/theme1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Beaver">
  <a:themeElements>
    <a:clrScheme name="Office"><a:dk1><a:srgbClr val="111111"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F8FAFC"/></a:lt2><a:accent1><a:srgbClr val="2563EB"/></a:accent1><a:accent2><a:srgbClr val="059669"/></a:accent2><a:accent3><a:srgbClr val="D97706"/></a:accent3><a:accent4><a:srgbClr val="7C3AED"/></a:accent4><a:accent5><a:srgbClr val="DC2626"/></a:accent5><a:accent6><a:srgbClr val="0891B2"/></a:accent6><a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme>
    <a:fontScheme name="Office"><a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/></a:minorFont></a:fontScheme>
    <a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
  </a:themeElements>
</a:theme>`,
  );

  for (const [index, slide] of slides.entries()) {
    const bullets = slide.bullets.length ? slide.bullets : [""];
    zip.file(
      `ppt/slides/slide${index + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      ${pptShape(2, "Title", 685800, 457200, 10820400, 914400, pptTextParagraphs([slide.title], true))}
      ${pptShape(3, "Content", 914400, 1600200, 10363200, 4343400, pptTextParagraphs(bullets))}
    </p:spTree>
  </p:cSld>
</p:sld>`,
    );
    zip.file(
      `ppt/slides/_rels/slide${index + 1}.xml.rels`,
      pptRelationships('  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'),
    );
  }

  return zip.generateAsync({ type: "nodebuffer" });
}

export function findTextMatches(params: {
  text: string;
  query: string;
  maxResults: number;
  contextChars: number;
  startIndex?: number;
}) {
  const { text, query, maxResults, contextChars, startIndex = 0 } = params;
  const hits: Array<{ index: number; excerpt: string; context: string; at: number }> = [];
  const tokens = query.trim().split(/\s+/u).filter(Boolean);
  if (!tokens.length) return { hits, totalMatches: 0 };
  const pattern = tokens
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("\\s+");
  let totalMatches = 0;
  for (const match of text.matchAll(new RegExp(pattern, "giu"))) {
    const start = match.index;
    const end = start + match[0].length;
    if (hits.length < maxResults) {
      const ctxStart = Math.max(0, start - contextChars);
      const ctxEnd = Math.min(text.length, end + contextChars);
      hits.push({
        index: startIndex + hits.length,
        excerpt: match[0],
        context:
          (ctxStart > 0 ? "…" : "") +
          text.slice(ctxStart, ctxEnd).replace(/\s+/g, " ").trim() +
          (ctxEnd < text.length ? "…" : ""),
        at: start,
      });
    }
    totalMatches++;
  }
  return { hits, totalMatches };
}
