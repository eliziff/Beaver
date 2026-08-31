import {
  validateAuthoritiesDraft,
  type AuthoritiesDraft,
  type AuthoritiesDocumentSnapshot,
  type AuthorityIdentity,
  type AuthorityKind,
  type AuthoritySourceDecision,
  type AuthoritySourceIdentity,
} from "./authoritiesDomain";
import { canonicalJson, canonicalJsonSha256, sha256 } from "./hash";
import { addNativeTableOfAuthorities, type DocxAuthorityMark } from "./docxOperations";
import type { ResolvedWorkProductInput, WorkProductBuildReceipt,
  WorkProductInput } from "./workProduct";

export type AuthoritiesOutputRole = "table" | "book" | "annotated-document";
export type AuthoritiesBuildArtifact = {
  role: AuthoritiesOutputRole;
  filename: string;
  mimeType: string;
  bytes: Buffer;
  sha256: string;
  pageCount: number | null;
  receipt: WorkProductBuildReceipt;
};
export type AuthoritiesBuildReceipt = {
  schemaVersion: "beaver.authorities-build.v1";
  builtAt: string;
  workProduct: { id: string; kind: "authorities"; revision: number };
  inputs: WorkProductBuildReceipt["inputs"];
  draft: { schemaVersion: AuthoritiesDraft["schemaVersion"];
    outputMode: AuthoritiesDraft["outputMode"];
    insertIntoDocument: boolean;
    document: AuthoritiesDocumentSnapshot | null };
  authorities: Array<{
    id: string; key: string; kind: AuthorityKind; citation: string; name: string;
    tab: string; excluded: boolean; source: AuthoritySourceDecision;
    sourceIdentity: AuthoritySourceIdentity | null;
    evidenceIds: string[]; locators: Array<{ kind: string; label: string }>;
    binding: WorkProductInput | null;
  }>;
  outputs: Partial<Record<AuthoritiesOutputRole, {
    filename: string; mimeType: string; sha256: string; pageCount: number | null;
  }>>;
};
export type AuthoritiesBuildResult = {
  artifacts: Partial<Record<AuthoritiesOutputRole, AuthoritiesBuildArtifact>>;
  receipt: AuthoritiesBuildReceipt;
};
export type AuthoritiesBuildInput = {
  draft: AuthoritiesDraft;
  title: string;
  workProduct: { id: string; revision: number };
  sources?: Record<string, { bytes?: Uint8Array; resolved?: ResolvedWorkProductInput }>;
};

type BareArtifact = Omit<AuthoritiesBuildArtifact, "receipt">;

type Entry = {
  authority: AuthorityIdentity;
  name: string;
  citedAt: string;
  tab: string;
  sourceUrl: string | null;
};
type Group = { label: string; entries: Entry[] };
type PdfModule = typeof import("pdf-lib");
type PdfDocument = import("pdf-lib").PDFDocument;
type PdfPage = import("pdf-lib").PDFPage;
type PdfRef = import("pdf-lib").PDFRef;
type PdfFont = import("pdf-lib").PDFFont;

const GROUPS: ReadonlyArray<readonly [string, AuthorityKind]> = [
  ["Cases", "case"], ["Legislation", "legislation"],
  ["Secondary sources", "commentary"], ["Other sources", "other"],
];
const RENDERERS: Record<AuthoritiesOutputRole, string> = {
  table: "beaver.authorities.table-docx.v1",
  book: "beaver.authorities.book-pdf.v1",
  "annotated-document": "beaver.authorities.native-word-toa.v1",
};

function authorityName(authority: AuthorityIdentity) {
  const citation = authority.citation.trim();
  const name = (authority.displayName ?? authority.name ?? "").trim();
  if (!name) return citation;
  if (!citation) return name;
  if (name.toLocaleLowerCase().includes(citation.toLocaleLowerCase())) return name;
  if (citation.toLocaleLowerCase().startsWith(name.toLocaleLowerCase())) return citation;
  return `${name}, ${citation}`;
}

function citedAt(draft: AuthoritiesDraft, authorityId: string) {
  const pages = [...new Set(draft.units.flatMap((unit) => unit.occurrenceIds.some((id) =>
    draft.occurrences[id]?.authorityId === authorityId) ? unit.pageNumbers : []))]
    .sort((left, right) => left - right);
  return pages.join(", ") || "—";
}

function groupedEntries(draft: AuthoritiesDraft) {
  const ordered = draft.authorityOrder.map((id) => draft.authorities[id]);
  const groups: Group[] = GROUPS.flatMap(([label, kind]) => {
    const authorities = ordered.filter((authority) => authority.kind === kind);
    return authorities.length ? [{ label, entries: authorities.map((authority) => ({
      authority, name: authorityName(authority), citedAt: citedAt(draft, authority.id),
      tab: "", sourceUrl: authority.source.kind === "attached" ? authority.source.sourceUrl
        : authority.source.kind === "pending-canlii" ? authority.source.pageUrl
          : authority.sourceIdentity?.externalUrl ?? null,
    })) }] : [];
  });
  let tab = 0;
  for (const entry of groups.flatMap(({ entries }) => entries)) {
    entry.tab = entry.authority.excluded ? "Not reproduced" : `Tab ${++tab}`;
  }
  return groups;
}

async function tableArtifact(groups: Group[], filename: string, subtitle: string) {
  const { BorderStyle, Document, ExternalHyperlink, HeadingLevel, Packer, Paragraph,
    Table, TableCell, TableRow, TextRun, WidthType } = await import("docx");
  const border = { style: BorderStyle.SINGLE, size: 1, color: "B7B7B7" };
  const cell = (value: string, width: number, bold = false) => new TableCell({
    width: { size: width, type: WidthType.DXA },
    children: [new Paragraph({ children: [new TextRun({ text: value, bold, size: 19 })] })],
  });
  const children: Array<InstanceType<typeof Paragraph> | InstanceType<typeof Table>> = [
    new Paragraph({ text: "Table of Authorities", heading: HeadingLevel.TITLE }),
    new Paragraph({ children: [new TextRun({ text: subtitle, italics: true,
      color: "666666", size: 22 })] }),
  ];
  if (!groups.length) children.push(new Paragraph("No authorities."));
  for (const group of groups) {
    children.push(new Paragraph({ text: group.label, heading: HeadingLevel.HEADING_1,
      keepNext: true }));
    children.push(new Table({ width: { size: 9360, type: WidthType.DXA },
      borders: { top: border, bottom: border, left: border, right: border,
        insideHorizontal: border, insideVertical: border }, rows: [
        new TableRow({ tableHeader: true, children: [
          cell("Tab", 1050, true), cell("Authority", 4800, true),
          cell("Cited at", 1850, true), cell("Source", 1660, true),
        ] }),
        ...group.entries.map((entry) => new TableRow({ cantSplit: true, children: [
          cell(entry.tab, 1050), cell(entry.name, 4800), cell(entry.citedAt, 1850),
          new TableCell({ width: { size: 1660, type: WidthType.DXA }, children: [
            new Paragraph({ children: entry.sourceUrl ? [new ExternalHyperlink({
              link: entry.sourceUrl, children: [new TextRun({ text: "Open source",
                style: "Hyperlink", size: 19 })],
            })] : [new TextRun({ text: "—", size: 19 })] }),
          ] }),
        ] })),
      ] }));
  }
  const document = new Document({ creator: "Beaver", title: "Table of Authorities",
    description: "Reviewed legal authorities",
    styles: { default: { document: { run: { font: "Times New Roman", size: 22 } } } },
    sections: [{ properties: { page: { margin: {
      top: 1440, right: 1440, bottom: 1440, left: 1440,
    } } }, children }],
  });
  const bytes = await Packer.toBuffer(document);
  return artifact("table", filename, "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    bytes, null);
}

function nativeMark(authority: AuthorityIdentity, unitId: string, offset: number): DocxAuthorityMark {
  const citation = authority.citation.trim();
  const shortName = (authority.displayName ?? authority.name ?? citation).trim();
  const longName = authorityName(authority);
  return { unitId, offset, longName, shortName: shortName || citation,
    category: authority.kind === "case" ? 1 : authority.kind === "legislation" ? 2
      : authority.kind === "commentary" ? 5 : 3 };
}

async function documentArtifact(draft: AuthoritiesDraft, filename: string,
  bytes: Uint8Array, sourceSha256: string) {
  if (!bytes.byteLength || sha256(Buffer.from(bytes)) !== sourceSha256) {
    throw new Error("The imported Word document changed before building.");
  }
  const seen = new Set<string>();
  const marks = draft.units.flatMap((unit) => unit.occurrenceIds.flatMap((id) => {
    const occurrence = draft.occurrences[id], authority = occurrence?.authorityId
      ? draft.authorities[occurrence.authorityId] : null;
    const key = authority && `${unit.id}\0${occurrence.end}\0${authority.id}`;
    if (!authority || !key || seen.has(key)) return [];
    seen.add(key);
    return [nativeMark(authority, unit.id, occurrence.end)];
  }));
  const output = await addNativeTableOfAuthorities(Buffer.from(bytes), draft.units, marks);
  return artifact("annotated-document", filename,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    output, null);
}

function fit(font: PdfFont, value: string, size: number, width: number) {
  if (font.widthOfTextAtSize(value, size) <= width) return value;
  let text = value;
  while (text && font.widthOfTextAtSize(`${text}…`, size) > width) text = text.slice(0, -1);
  return `${text}…`;
}

function addLink(page: PdfPage, rect: number[], target: PdfPage) {
  const annotation = page.doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: rect,
    Border: [0, 0, 0], Dest: [target.ref, "Fit"] });
  page.node.addAnnot(page.doc.context.register(annotation));
}

type Outline = { title: string; pageIndex: number; children?: Outline[] };
function outlineBranch(pdf: PdfModule, document: PdfDocument, items: Outline[], parent: PdfRef) {
  const nodes = items.map((item) => {
    const dict = document.context.obj({ Title: pdf.PDFHexString.fromText(item.title),
      Parent: parent, Dest: [document.getPage(item.pageIndex).ref, "Fit"] });
    return { item, dict, ref: document.context.register(dict), count: 0 };
  });
  nodes.forEach((node, index) => {
    if (index) node.dict.set(pdf.PDFName.of("Prev"), nodes[index - 1].ref);
    if (index + 1 < nodes.length) node.dict.set(pdf.PDFName.of("Next"), nodes[index + 1].ref);
    if (!node.item.children?.length) return;
    const branch = outlineBranch(pdf, document, node.item.children, node.ref);
    node.dict.set(pdf.PDFName.of("First"), branch.first);
    node.dict.set(pdf.PDFName.of("Last"), branch.last);
    node.dict.set(pdf.PDFName.of("Count"), document.context.obj(branch.count));
    node.count = branch.count;
  });
  return { first: nodes[0].ref, last: nodes.at(-1)!.ref,
    count: nodes.reduce((count, node) => count + node.count + 1, 0) };
}

function addOutlines(pdf: PdfModule, document: PdfDocument, items: Outline[]) {
  const root = document.context.obj({ Type: "Outlines" });
  const ref = document.context.register(root);
  const branch = outlineBranch(pdf, document, items, ref);
  root.set(pdf.PDFName.of("First"), branch.first);
  root.set(pdf.PDFName.of("Last"), branch.last);
  root.set(pdf.PDFName.of("Count"), document.context.obj(branch.count));
  document.catalog.set(pdf.PDFName.of("Outlines"), ref);
  document.catalog.set(pdf.PDFName.of("PageMode"), pdf.PDFName.of("UseOutlines"));
}

async function bookArtifact(
  groups: Group[], filename: string, subtitle: string,
  attached: NonNullable<AuthoritiesBuildInput["sources"]>,
) {
  const pdf = await import("pdf-lib");
  const entries = groups.flatMap(({ entries }) => entries.filter(({ authority }) =>
    !authority.excluded));
  if (!entries.length) throw new Error("Add at least one authority PDF before building the book.");
  const sources = await Promise.all(entries.map(async (entry) => {
    const source = entry.authority.source;
    if (source.kind !== "attached") throw new Error(`Attach a PDF for ${entry.name}.`);
    const bytes = Buffer.from(attached[source.bindingRole]?.bytes ?? []);
    if (!bytes.length || sha256(bytes) !== source.sourceSha256)
      throw new Error(`Attached PDF changed for ${entry.name}.`);
    let document: PdfDocument;
    try {
      document = await pdf.PDFDocument.load(bytes, { updateMetadata: false });
    } catch {
      throw new Error(`Attached PDF could not be opened for ${entry.name}.`);
    }
    if (!document.getPageCount()) throw new Error(`Attached PDF is empty for ${entry.name}.`);
    return { entry, document };
  }));
  const tokens = groups.flatMap((group) => {
    const kept = group.entries.filter(({ authority }) => !authority.excluded);
    return kept.length ? [{ label: group.label, entry: null as Entry | null },
      ...kept.map((entry) => ({ label: "", entry }))] : [];
  });
  const chunks = Array.from({ length: Math.ceil(tokens.length / 23) }, (_, index) =>
    tokens.slice(index * 23, index * 23 + 23));
  const frontPages = 1 + chunks.length;
  const starts = new Map<string, number>();
  let next = frontPages;
  for (const { entry, document } of sources) {
    starts.set(entry.authority.id, next);
    next += document.getPageCount();
  }
  const document = await pdf.PDFDocument.create();
  const regular = await document.embedFont(pdf.StandardFonts.Helvetica);
  const bold = await document.embedFont(pdf.StandardFonts.HelveticaBold);
  const serif = await document.embedFont(pdf.StandardFonts.TimesRoman);
  const cover = document.addPage([612, 792]);
  cover.drawRectangle({ x: 0, y: 0, width: 18, height: 792, color: pdf.rgb(.18, .18, .18) });
  cover.drawLine({ start: { x: 72, y: 626 }, end: { x: 540, y: 626 },
    thickness: 2, color: pdf.rgb(.55, .55, .55) });
  cover.drawText("Book of Authorities", { x: 72, y: 500, size: 28, font: bold });
  cover.drawText(fit(serif, subtitle, 13, 468), { x: 72, y: 462, size: 13, font: serif,
    color: pdf.rgb(.25, .25, .25) });
  const links: Array<{ page: PdfPage; entry: Entry; rect: number[] }> = [];
  chunks.forEach((chunk, chunkIndex) => {
    const page = document.addPage([612, 792]);
    page.drawText(chunkIndex ? "Table of Contents — continued" : "Table of Contents",
      { x: 48, y: 730, size: 20, font: bold });
    let y = 690;
    for (const token of chunk) {
      if (!token.entry) {
        page.drawRectangle({ x: 48, y: y - 8, width: 516, height: 22,
          color: pdf.rgb(.92, .92, .92) });
        page.drawText(token.label.toUpperCase(), { x: 56, y, size: 8.5, font: bold });
        y -= 27;
        continue;
      }
      const start = starts.get(token.entry.authority.id)!;
      page.drawText(token.entry.tab, { x: 54, y, size: 7.5, font: bold });
      page.drawText(fit(serif, token.entry.name, 8.8, 390),
        { x: 102, y, size: 8.8, font: serif });
      page.drawText(String(start + 1), { x: 535, y, size: 8, font: bold });
      page.drawLine({ start: { x: 102, y: y - 7 }, end: { x: 564, y: y - 7 },
        thickness: .45, color: pdf.rgb(.82, .82, .82) });
      links.push({ page, entry: token.entry, rect: [48, y - 10, 564, y + 10] });
      y -= 25;
    }
    page.drawText(String(chunkIndex + 2), { x: 540, y: 24, size: 8, font: regular });
  });
  for (const { document: source } of sources) {
    const pages = await document.copyPages(source, source.getPageIndices());
    pages.forEach((page) => document.addPage(page));
  }
  for (const link of links) addLink(link.page, link.rect,
    document.getPage(starts.get(link.entry.authority.id)!));
  addOutlines(pdf, document, [
    { title: "Book of Authorities", pageIndex: 0 },
    { title: "Table of Contents", pageIndex: 1 },
    ...groups.flatMap((group): Outline[] => {
      const entries = group.entries.filter(({ authority }) => !authority.excluded);
      return entries.length ? [{ title: group.label,
        pageIndex: starts.get(entries[0].authority.id)!,
        children: entries.map((entry) => ({ title: `${entry.tab} — ${entry.name}`,
          pageIndex: starts.get(entry.authority.id)! })) }] : [];
    }),
  ]);
  document.setTitle("Book of Authorities");
  document.setSubject("Navigable book of legal authorities");
  document.setCreator("Beaver");
  document.setProducer("Beaver · pdf-lib");
  document.setCreationDate(new Date(0));
  document.setModificationDate(new Date(0));
  document.catalog.set(pdf.PDFName.of("Lang"), pdf.PDFHexString.fromText("en-CA"));
  const bytes = Buffer.from(await document.save({ useObjectStreams: false }));
  return artifact("book", filename, "application/pdf", bytes, document.getPageCount());
}

function artifact(
  role: AuthoritiesOutputRole, filename: string, mimeType: string,
  bytes: Buffer, pageCount: number | null,
): BareArtifact {
  return { role, filename, mimeType, bytes, sha256: sha256(bytes), pageCount };
}

function resolvedInput(
  role: string, binding: WorkProductInput, filename: string, sourceSha256: string,
  supplied?: ResolvedWorkProductInput,
): ResolvedWorkProductInput {
  const resolved = supplied ?? (binding.kind === "local-file" &&
    binding.lastSeen.sha256 === sourceSha256
    ? { kind: "local-file" as const, handleId: binding.handleId, filename,
      size: binding.lastSeen.size, modified: binding.lastSeen.modified, sha256: sourceSha256 }
    : binding.kind === "document" && binding.version !== "latest" &&
      binding.version.sha256 === sourceSha256
      ? { kind: "document" as const, documentId: binding.documentId,
        versionId: binding.version.versionId, filename, sha256: sourceSha256 }
      : null);
  if (!resolved || resolved.sha256 !== sourceSha256 ||
      (binding.kind === "local-file" &&
        (resolved.kind !== binding.kind || resolved.handleId !== binding.handleId)) ||
      (binding.kind === "document" &&
        (resolved.kind !== binding.kind || resolved.documentId !== binding.documentId ||
         (binding.version !== "latest" &&
          resolved.versionId !== binding.version.versionId))) ||
      (binding.kind === "work-product-output" &&
        (resolved.kind !== binding.kind || resolved.workProductId !== binding.workProductId ||
         resolved.role !== binding.role))) {
    throw new Error(`Resolve the exact current input for ${role} before building.`);
  }
  return resolved;
}

export async function buildAuthorities(input: AuthoritiesBuildInput): Promise<AuthoritiesBuildResult> {
  const errors = validateAuthoritiesDraft(input.draft);
  if (errors.length) throw new Error(errors[0]);
  if (!input.workProduct.id || !Number.isInteger(input.workProduct.revision) ||
      input.workProduct.revision < 1) throw new Error("Valid work-product identity is required.");
  const groups = groupedEntries(input.draft);
  const sources = input.sources ?? {};
  const imported = input.draft.import.kind === "document" ? (() => {
    const { bindingRole: role, filename, snapshot } = input.draft.import;
    const binding = input.draft.bindings[role], supplied = sources[role]?.resolved;
    const bindingSha = binding.kind === "local-file" ? binding.lastSeen.sha256
      : binding.kind === "document" && binding.version !== "latest"
        ? binding.version.sha256 : undefined;
    const resolved = resolvedInput(role, binding, filename,
      snapshot?.sha256 ?? supplied?.sha256 ?? bindingSha ?? "", supplied);
    if (snapshot && (resolved.kind !== "document" ||
        resolved.documentId !== snapshot.documentId || resolved.versionId !== snapshot.versionId)) {
      throw new Error(`Resolve the imported document snapshot for ${role} before building.`);
    }
    return [{ role, resolved }];
  })() : [];
  const inputs = [...imported, ...groups.flatMap(({ entries }) => entries.flatMap(({ authority }) => {
    if (authority.source.kind !== "attached") return [];
    const role = authority.source.bindingRole;
    return [{ role, resolved: resolvedInput(role, input.draft.bindings[role],
      authority.source.filename, authority.source.sourceSha256, sources[role]?.resolved) }];
  }))];
  const base = input.title.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "-")
    .replace(/[. ]+$/u, "").slice(0, 120) || "Authorities";
  const subtitle = input.draft.import.kind === "document"
    ? input.draft.import.filename : input.title;
  const wanted: AuthoritiesOutputRole[] = input.draft.outputMode === "both"
    ? ["table", "book"] : [input.draft.outputMode];
  if (input.draft.insertIntoDocument) wanted.push("annotated-document");
  const built = await Promise.all(wanted.map((role) => role === "table"
    ? tableArtifact(groups, `${base}.table-of-authorities.docx`, subtitle)
    : role === "book"
      ? bookArtifact(groups, `${base}.book-of-authorities.pdf`, subtitle, sources)
      : documentArtifact(input.draft, `${base}.with-table-of-authorities.docx`,
        sources[input.draft.import.kind === "document"
          ? input.draft.import.bindingRole : "source"]?.bytes ?? new Uint8Array(),
        imported[0]?.resolved.sha256 ?? "")));
  const builtAt = new Date().toISOString();
  const settings: WorkProductBuildReceipt["settings"] = {
    profileId: null, outputMode: input.draft.outputMode,
    stateSha256: canonicalJsonSha256(input.draft),
    settingsSha256: canonicalJsonSha256({
      schemaVersion: "beaver.authorities-build.v1",
      draftSchemaVersion: input.draft.schemaVersion,
      title: input.title,
      outputMode: input.draft.outputMode,
      insertIntoDocument: input.draft.insertIntoDocument,
      renderers: wanted.map((role) => [role, RENDERERS[role]]),
    }),
    sourceReceiptIds: [...new Set([
      ...Object.values(input.draft.authorities).flatMap(({ evidenceIds }) => evidenceIds),
      ...Object.values(input.draft.occurrences).flatMap(({ evidenceIds }) => evidenceIds),
    ])].sort(),
    audit: { effective: null, valuesJson: canonicalJson({ title: input.title,
      outputMode: input.draft.outputMode, insertIntoDocument: input.draft.insertIntoDocument,
      authorityOrder: input.draft.authorityOrder,
      authorities: input.draft.authorityOrder.map((id) => {
        const authority = input.draft.authorities[id];
        return { id, citation: authority.citation, name: authority.name,
          displayName: authority.displayName, excluded: authority.excluded,
          source: authority.source };
      }) }) },
  };
  const artifacts = Object.fromEntries(built.map((item) => [item.role, { ...item,
    receipt: { schemaVersion: "beaver.work-product-build.v2", builtAt,
      workProduct: { ...input.workProduct, kind: "authorities" }, inputs, settings,
      steps: item.role === "table" ? ["Rendered grouped Table of Authorities"]
        : item.role === "book"
          ? ["Combined attached authority PDFs", "Added index links and PDF bookmarks"]
          : ["Marked reviewed citations with native Word TA fields",
            "Added a native Word TOA field on a final page"],
      output: { role: item.role, filename: item.filename, mimeType: item.mimeType,
        pageCount: item.pageCount, sha256: item.sha256 } },
  }])) as
    AuthoritiesBuildResult["artifacts"];
  const outputs = Object.fromEntries(built.map(({ role, filename, mimeType, sha256, pageCount }) =>
    [role, { filename, mimeType, sha256, pageCount }])) as AuthoritiesBuildReceipt["outputs"];
  const entries = groups.flatMap(({ entries }) => entries);
  return { artifacts, receipt: {
    schemaVersion: "beaver.authorities-build.v1", builtAt,
    workProduct: { ...input.workProduct, kind: "authorities" }, inputs,
    draft: { schemaVersion: input.draft.schemaVersion, outputMode: input.draft.outputMode,
      insertIntoDocument: input.draft.insertIntoDocument,
      document: input.draft.import.kind === "document" ? input.draft.import.snapshot : null },
    authorities: entries.map(({ authority, name, tab }) => ({
      id: authority.id, key: authority.key, kind: authority.kind, citation: authority.citation,
      name, tab, excluded: authority.excluded, source: structuredClone(authority.source),
      sourceIdentity: structuredClone(authority.sourceIdentity),
      evidenceIds: [...authority.evidenceIds], locators: structuredClone(authority.locators),
      binding: authority.source.kind === "attached"
        ? structuredClone(input.draft.bindings[authority.source.bindingRole]) : null,
    })),
    outputs,
  } };
}
