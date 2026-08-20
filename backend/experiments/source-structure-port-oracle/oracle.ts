import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import {
  __sourceStructurePortOracle as a2ajOracle,
  compileA2AJSourceDoc,
} from "../../src/lib/sourceDocA2AJ";
import {
  __nativeMarkupPortOracle as markupOracle,
  compileNativeMarkupSourceDoc,
} from "../../src/lib/sourceDocNativeMarkup";
import { __journalStructurePortOracle as journalOracle } from "../../src/lib/legalSources/journal";
import { computeStatuteSpine } from "../../src/lib/statuteSpine";
import { createSourceDoc, type SourceDoc, type SourceDocBlock } from "../../src/lib/sourceDoc";
import {
  canonicalSourceDocBytes,
  sourceDocPublicBytes,
} from "../source-structure-parity/canonical";

const ROOT = path.resolve(__dirname, "../..");
const FIXTURES = path.join(ROOT, "src/lib/__tests__/fixtures");
const relative = (name: string) => `backend/src/lib/__tests__/fixtures/${name}`;
const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const jsonSha = (value: unknown) => sha(JSON.stringify(value));

type A2AJCapture = Parameters<typeof compileA2AJSourceDoc>[0];
type MarkupCapture = {
  id?: string;
  citation?: string;
  packageId?: string;
  caseNumber?: string;
  text?: string;
  markup?: string;
};

function readCapture<T>(filename: string, repoPath: string) {
  const bytes = readFileSync(filename);
  return {
    value: JSON.parse(bytes.toString("utf8")) as T,
    source: { path: repoPath, bytes: bytes.length, sha256: sha(bytes) },
  };
}

const capture = <T>(name: string) =>
  readCapture<T>(path.join(FIXTURES, name), relative(name));
const oracleCapture = <T>(name: string) =>
  readCapture<T>(
    path.join(__dirname, "inputs", name),
    `backend/experiments/source-structure-port-oracle/inputs/${name}`,
  );

function scalarOffsets(text: string, wanted: Iterable<number>) {
  const offsets = [...new Set(wanted)].sort((left, right) => left - right);
  const result = new Map<number, number>();
  let utf16 = 0;
  let scalar = 0;
  let index = 0;
  for (const character of text) {
    while (offsets[index] === utf16) result.set(offsets[index++], scalar);
    utf16 += character.length;
    scalar += 1;
  }
  while (offsets[index] === utf16) result.set(offsets[index++], scalar);
  if (index !== offsets.length) {
    throw new Error(`offset outside text: ${offsets.slice(index)} > ${utf16}`);
  }
  return result;
}

function compactBlocks(text: string, blocks: readonly SourceDocBlock[]) {
  const valid = blocks.flatMap(({ start, end }) =>
    [start, end].filter((offset) => offset >= 0 && offset <= text.length),
  );
  const scalars = scalarOffsets(
    text,
    valid,
  );
  return blocks.map((block) => ({
    kind: block.kind,
    label: block.label,
    utf16: [block.start, block.end],
    scalar: [scalars.get(block.start) ?? null, scalars.get(block.end) ?? null],
    utf16_range_valid:
      block.start >= 0 && block.start <= block.end && block.end <= text.length,
    origin: block.origin,
    anchor: block.anchor ?? null,
    aliases: block.aliases ?? [],
    parent: block.parentLabel ?? null,
  }));
}

function compactRanges(text: string, ranges: ReadonlyArray<{ start: number; end: number }>) {
  const scalars = scalarOffsets(
    text,
    ranges.flatMap(({ start, end }) =>
      [start, end].filter((offset) => offset >= 0 && offset <= text.length),
    ),
  );
  return ranges.map(({ start, end }) => ({
    utf16: [start, end],
    scalar: [scalars.get(start) ?? null, scalars.get(end) ?? null],
    utf16_range_valid: start >= 0 && start <= end && end <= text.length,
  }));
}

function compactMarkers<T extends { start: number }>(text: string, markers: T[]) {
  const scalars = scalarOffsets(text, markers.map(({ start }) => start));
  return markers.map(({ start, ...marker }) => ({
    ...marker,
    start_utf16: start,
    start_scalar: scalars.get(start),
  }));
}

function finalDoc(doc: SourceDoc) {
  const canonical = canonicalSourceDocBytes(doc);
  const publicBytes = sourceDocPublicBytes(doc);
  return {
    status: doc.status,
    revision: doc.revision,
    text_utf16: doc.text.length,
    text_scalars: [...doc.text].length,
    supplementary_scalars: [...doc.text].filter((value) => value.length === 2).length,
    public_utf16_json: { bytes: publicBytes.length, sha256: sha(publicBytes) },
    canonical_utf16_json: { bytes: canonical.length, sha256: sha(canonical) },
    ranges: doc.ranges,
    blocks: compactBlocks(doc.text, doc.blocks),
  };
}

function caseTrace(text: string, oldMode: "a2aj" | "generic" | "courtlistener", excluded: Array<{ start: number; end: number }> = []) {
  const markers = a2ajOracle.paragraphMarkers(text, oldMode);
  const visible = a2ajOracle.outsideExcludedRanges(markers, excluded);
  const quoted = oldMode === "generic"
    ? new Set<number>()
    : a2ajOracle.quotedDotProvisionStarts(text, visible);
  const eligible = visible.filter(({ start }) => !quoted.has(start));
  const styles = (["bracket", "dot", "bare"] as const).map((style) => {
    const known = new Set(eligible.filter((mark) => mark.style === style).map(({ start }) => start));
    const joined = style === "bare" ? [] : a2ajOracle.headingJoinedCandidates(text, known, style);
    const weighted = a2ajOracle.spineCandidates(text, eligible, style);
    const rooted = a2ajOracle.selectSpineChain(weighted);
    const recovered = oldMode === "courtlistener" && style !== "bare"
      ? a2ajOracle.recoverHeadingJoinedMarkers(text, eligible, style)
      : eligible.filter((mark) => mark.style === style);
    const scopes = oldMode === "courtlistener"
      ? a2ajOracle.contiguousScopes(recovered)
      : a2ajOracle.monotoneScopes(recovered, oldMode === "generic" ? 8 : 1);
    return {
      style,
      heading_joined: compactMarkers(text, joined),
      weighted_candidates: compactMarkers(text, weighted),
      rooted_chain: compactMarkers(text, rooted.chain),
      rooted_score: rooted.score,
      sole_chain: rooted.chain.length > 0 && a2ajOracle.soleChain(rooted.chain, weighted),
      rooted_endnote_shaped: a2ajOracle.endnoteShaped(rooted.chain, text.length),
      scopes: scopes.map((scope) => ({
        markers: compactMarkers(text, scope),
        sole_ladder: a2ajOracle.soleLadder(scope, recovered, scopes),
      })),
    };
  });
  return {
    old_mode: oldMode,
    markers: compactMarkers(text, markers),
    excluded_ranges: compactRanges(text, excluded),
    visible_markers: compactMarkers(text, visible),
    quoted_provision_starts_utf16: [...quoted],
    selected_paragraph_blocks: compactBlocks(
      text,
      a2ajOracle.paragraphBlocks(text, 5, oldMode, excluded),
    ),
    styles,
  };
}

function expected<T>(value: T) {
  return { sha256: jsonSha(value), value };
}

function a2ajCase(name: string, local = false) {
  const loaded = local
    ? oracleCapture<A2AJCapture>(`${name}.json`)
    : capture<A2AJCapture>(`sourcedoc/${name}.json`);
  const input = loaded.value;
  const reportStart = a2ajOracle.reporterStartPage(input.citation, input.alternateCitation);
  const doc = compileA2AJSourceDoc(input);
  return {
    id: name,
    provenance: "real-captured" as const,
    profile: "case_rooted_complete" as const,
    old_detector_mode: "a2aj",
    profile_options: {
      report_start_page: reportStart,
      require_report_start: (input.dataset ?? "").toUpperCase() === "SCC",
    },
    fixture: loaded.source,
    engine_input: {
      text: { bytes: Buffer.byteLength(input.text), sha256: sha(input.text) },
      section_map: input.sectionMap
        ? { entries: Object.keys(input.sectionMap).length, sha256: jsonSha(input.sectionMap) }
        : null,
    },
    expected: expected({ decisions: caseTrace(input.text, "a2aj"), final: finalDoc(doc) }),
  };
}

function a2ajLaw(name: string) {
  const loaded = capture<A2AJCapture>(`sourcedoc/${name}.json`);
  const input = loaded.value;
  const allowHyphen = /\b(?:rules?|regulations?|r[eè]glements?)\b/iu.test(input.name ?? "");
  const spine = computeStatuteSpine(input.text, allowHyphen);
  const doc = compileA2AJSourceDoc(input);
  return {
    id: name,
    provenance: "real-captured" as const,
    profile: "legislation" as const,
    old_detector_mode: "lawSectionBlocks/statuteSpine",
    profile_options: { allow_hyphenated_sections: allowHyphen },
    fixture: loaded.source,
    engine_input: {
      text: { bytes: Buffer.byteLength(input.text), sha256: sha(input.text) },
      section_map: input.sectionMap
        ? { entries: Object.keys(input.sectionMap).length, sha256: jsonSha(input.sectionMap) }
        : null,
    },
    expected: expected({
      statute_spine: compactMarkers(input.text, spine),
      reconstructed_blocks: compactBlocks(input.text, a2ajOracle.lawSectionBlocks(input.text, input.name)),
      final: finalDoc(doc),
    }),
  };
}

function nativeMarkup(
  name: string,
  provider: "courtlistener" | "tna" | "govinfo" | "govuk-et",
  local = false,
) {
  const loaded = local
    ? oracleCapture<MarkupCapture>(`${name}.json`)
    : capture<MarkupCapture>(`nativemarkup/${name}.json`);
  const input = loaded.value;
  const markup = input.markup ?? "";
  const id = input.id ?? input.citation ?? input.packageId ?? input.caseNumber ?? name;
  const parsed = markupOracle.nativeMarkupBlocks(provider, markup, []);
  const native = markup.trim()
    ? parsed
    : { text: input.text ?? "", blocks: [] as SourceDocBlock[], excludedRanges: [] };
  const capLegacy = /<(?:\w+:)?(?:section|article)\b[^>]*\bcasebody\b/iu.test(markup);
  const profile = capLegacy ? "case_lossy" : provider === "courtlistener" ? "case_contiguous_complete" : "case_lossy";
  const oldMode = profile === "case_contiguous_complete" ? "courtlistener" : "generic";
  const doc = compileNativeMarkupSourceDoc({
    provider,
    id,
    text: input.text ?? markup,
    markup,
    citation: input.citation,
  });
  const claims = native.blocks.map(({ kind, label }) => `${kind}:${label.toLowerCase()}`);
  return {
    id: name,
    provenance: "real-captured" as const,
    profile,
    old_detector_mode: oldMode,
    profile_options: {
      report_start_page: a2ajOracle.reporterStartPage(input.citation),
      require_report_start: false,
    },
    fixture: loaded.source,
    engine_input: {
      raw_markup: { bytes: Buffer.byteLength(markup), sha256: sha(markup) },
      rendered_text: { bytes: Buffer.byteLength(native.text), sha256: sha(native.text) },
    },
    expected: expected({
      native_blocks: compactBlocks(native.text, native.blocks),
      native_claims: claims,
      excluded_ranges: compactRanges(native.text, native.excludedRanges),
      recovery: caseTrace(native.text, oldMode, native.excludedRanges),
      final: finalDoc(doc),
    }),
  };
}

function journal(name: string) {
  const loaded = capture<{
    row: Record<string, unknown>;
    pageRows: Array<{ page_label: unknown; pdf_page: unknown }>;
  }>(`nativemarkup/${name}.json`);
  const text = String(loaded.value.row.text ?? "");
  const id = Number(loaded.value.row.article_id);
  const url = String(loaded.value.row.galley_url ?? loaded.value.row.url_en ?? "");
  const pageClaims = journalOracle.pageBlocks(text, loaded.value.pageRows);
  const recovered = journalOracle.reconstructedJournalBlocks(text, loaded.value.pageRows);
  const doc = journalOracle.journalSourceDoc(id, url, text, loaded.value.pageRows);
  return {
    id: name,
    provenance: "real-captured" as const,
    profile: "journal" as const,
    old_detector_mode: "reconstructedJournalBlocks",
    profile_options: {},
    fixture: loaded.source,
    engine_input: { bytes: Buffer.byteLength(text), sha256: sha(text) },
    expected: expected({
      page_claims: compactMarkers(text, pageClaims),
      reconstructed_blocks: compactBlocks(text, recovered),
      final: finalDoc(doc),
    }),
  };
}

function finalJournal(name: string) {
  const loaded = capture<{
    row: Record<string, unknown>;
    pageRows: Array<{ page_label: unknown; pdf_page: unknown }>;
    pages_gzip_base64: string;
  }>(`nativemarkup/${name}.json`);
  const pages = gunzipSync(Buffer.from(loaded.value.pages_gzip_base64, "base64"));
  const temporary = mkdtempSync(path.join(os.tmpdir(), "source-port-oracle-"));
  const filename = path.join(temporary, "pages.jsonl");
  writeFileSync(filename, pages);
  const id = Number(loaded.value.row.article_id);
  const canonical = journalOracle.finalContractSource(
    id,
    { filename, signature: sha(pages) },
    loaded.value.pageRows,
  );
  rmSync(temporary, { recursive: true, force: true });
  if (!canonical) throw new Error(`${name}: invalid final contract capture`);
  const url = String(loaded.value.row.galley_url ?? loaded.value.row.url_en ?? "");
  const recovered = journalOracle.reconstructedJournalBlocks(canonical.text, loaded.value.pageRows);
  const doc = journalOracle.journalSourceDoc(
    id,
    url,
    canonical.text,
    loaded.value.pageRows,
    canonical.blocks,
  );
  return {
    id: name,
    provenance: "real-captured" as const,
    profile: "journal" as const,
    old_detector_mode: "finalContractSource+journalSourceDoc",
    profile_options: {},
    fixture: loaded.source,
    engine_input: {
      pages_jsonl: { bytes: pages.length, sha256: sha(pages) },
      canonical_text: { bytes: Buffer.byteLength(canonical.text), sha256: sha(canonical.text) },
    },
    expected: expected({
      native_blocks: compactBlocks(canonical.text, canonical.blocks),
      recovered_candidates: compactBlocks(canonical.text, recovered),
      native_kinds: [...new Set(canonical.blocks.map(({ kind }) => kind))].sort(),
      final: finalDoc(doc),
    }),
  };
}

function localPdf(name: string) {
  const loaded = capture<{
    response: { result: { source_doc: Parameters<typeof createSourceDoc>[0] } };
  }>(`legalpdf/${name}.json`);
  const doc = createSourceDoc(loaded.value.response.result.source_doc);
  return {
    id: name,
    provenance: "real-captured" as const,
    profile: "case_lossy" as const,
    old_detector_mode: "legalpdf-source-doc",
    profile_options: {},
    fixture: loaded.source,
    engine_input: { bytes: Buffer.byteLength(doc.text), sha256: sha(doc.text) },
    expected: expected({ final: finalDoc(doc) }),
  };
}

export function buildOracle() {
  const statuteTest = readFileSync(path.join(ROOT, "src/lib/__tests__/statuteSpine.test.ts"));
  const parityCoverage = readFileSync(path.join(ROOT, "experiments/source-structure-parity/coverage.json"));
  const coverage = JSON.parse(parityCoverage.toString("utf8")) as {
    rows: Array<{ id: string; status: string }>;
    applicability_proofs: Array<{ id: string; query_sha256: string }>;
  };
  const rowBindings = {
    "a2aj/flat-case": "a2aj-case-scc-2026scc16-toc",
    "a2aj/flat-law": "a2aj-laws-fed-criminalcode-s231",
    "a2aj/hybrid-section-map": "a2aj-laws-fed-criminalcode-sectionmap",
    "a2aj/native-section-map": "a2aj-laws-ab-abc-benefits-s8",
    "courtlistener/native-cap": "courtlistener-cap-372us335",
    "courtlistener/hybrid-opinion": "courtlistener-hybrid-2072234",
    "courtlistener/flat-opinion": "courtlistener-flat-5134833",
    "tna/native-akn": "tna-eat-2025-1",
    "tna/hybrid-akn": {
      status: "not_applicable",
      query_sha256: coverage.applicability_proofs.find(({ id }) => id === "tna/hybrid-akn")?.query_sha256,
    },
    "govinfo/flat-text": "govinfo-nywd-1-22-cv-00930",
    "govuk-et/flat-text": "govuk-et-kogut-2200123-2023",
    "journal/hybrid-legacy": "journal-alr-13",
    "journal/native-final-contract": "journal-final-native-12027",
    "journal/hybrid-final-contract-recovery": "journal-final-recovery-9284",
    "local-pdf/native-source-doc": "local-pdf-native",
    "local-pdf/hybrid-source-doc": "local-pdf-hybrid",
    "local-pdf/flat-source-doc": "local-pdf-flat",
  };
  const scalarControl = "A\u{1F4DA}[1] B\u{1F600}";
  const scalarPoints = [0, 1, 3, 6, 8, scalarControl.length];
  return {
    schema_version: "source-structure-port-oracle.v1",
    contract: {
      offsets: "SourceDoc fields are UTF-16 code-unit offsets; scalar is the Unicode-scalar projection of the same boundary",
      profiles: ["case_rooted_complete", "case_contiguous_complete", "case_lossy", "legislation", "journal"],
      native_precedence: "native claims remain native; heuristic recovery may only fill unclaimed labels",
      acceptance: "real-captured vectors only; synthetic controls cannot satisfy provider acceptance",
    },
    suites: {
      real_captured: [
        a2ajCase("a2aj-case-scc-2026scc16-toc"),
        a2ajCase("a2aj-case-scc-1986scr103-dot"),
        a2ajCase("a2aj-case-scc-2014scc53-bracket"),
        a2ajCase("a2aj-case-scc-2020scc45-bracket"),
        a2ajCase("a2aj-citt-pr-2014-016a-endnotes", true),
        a2ajCase("a2aj-onca-2024-468-heading-join", true),
        a2ajLaw("a2aj-laws-fed-criminalcode-s231"),
        a2ajLaw("a2aj-laws-fed-criminalcode-sectionmap"),
        a2ajLaw("a2aj-regs-on-oreg267-03"),
        a2ajLaw("a2aj-regs-fed-crc870-a01"),
        a2ajLaw("a2aj-laws-ab-abc-benefits-s8"),
        nativeMarkup("courtlistener-cap-372us335", "courtlistener"),
        nativeMarkup("courtlistener-hybrid-2072234", "courtlistener"),
        nativeMarkup("courtlistener-flat-5134833", "courtlistener"),
        nativeMarkup("courtlistener-table-4589554", "courtlistener", true),
        nativeMarkup("tna-eat-2025-1", "tna"),
        nativeMarkup("govinfo-nywd-1-22-cv-00930", "govinfo"),
        nativeMarkup("govuk-et-kogut-2200123-2023", "govuk-et"),
        journal("journal-alr-13"),
        finalJournal("journal-final-native-12027"),
        finalJournal("journal-final-recovery-9284"),
        localPdf("local-pdf-native"),
        localPdf("local-pdf-hybrid"),
        localPdf("local-pdf-flat"),
      ],
      statute_spine_regressions: {
        classification: "synthetic-regression-controls",
        path: "backend/src/lib/__tests__/statuteSpine.test.ts",
        sha256: sha(statuteTest),
        command: "npm test --prefix backend -- --run src/lib/__tests__/statuteSpine.test.ts",
      },
      provider_final_parity: {
        path: "backend/experiments/source-structure-parity/coverage.json",
        sha256: sha(parityCoverage),
        row_bindings: rowBindings,
        coverage_rows: coverage.rows.map(({ id, status }) => ({ id, status })),
        required_rows: coverage.rows.map(({ id }) => id),
      },
      synthetic_offset_control: {
        classification: "synthetic-negative-control",
        text_sha256: sha(scalarControl),
        utf16_length: scalarControl.length,
        scalar_length: [...scalarControl].length,
        points: scalarPoints.map((utf16) => ({
          utf16,
          scalar: scalarOffsets(scalarControl, [utf16]).get(utf16),
        })),
      },
    },
  };
}
