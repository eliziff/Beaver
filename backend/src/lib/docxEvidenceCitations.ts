import { legalEvidenceDocumentLink } from "./chat/citations";
import {
  registerDocumentLegalEvidence,
  type LegalEvidenceReceipt,
  type LegalEvidenceTurnState,
} from "./chat/legalEvidence";
import type { DocxCitation } from "./chat/tools/docxMarkdown";
import { docxMarkdownCitationMarkers } from "./chat/tools/docxMarkdown";
import { authoritySeedFromReceipts,
  type AuthorityCitationLedger } from "./authoritiesDomain";
import { sha256 } from "./hash";
import { structureNative, type NativeAuthorityTextUnit } from "./structureNative";

const CITATION_ID = /^[a-z][a-z0-9_-]{0,63}$/u;
const EVIDENCE_ID = /^e_[A-Za-z0-9_-]{8,64}$/u;

type CitationInput = {
  id: string;
  evidenceIds: string[];
};

export type ResolvedDocxEvidenceCitations = {
  citations: Record<string, DocxCitation>;
  bindings: {
    id: string;
    evidenceIds: string[];
    sourceSha256s: string[];
    locators: string[];
    mainUrls: string[];
    pinpointUrls: string[];
  }[];
};

type LedgerSource = {
  authorityKey: string;
  stableId: string;
  authority: string;
  shortAuthority: string;
  evidenceIds: string[];
  pinpoints: Array<{ kind: "paragraph" | "section" | "page"; text: string;
    separator?: " at " | ", " }>;
};

type LedgerNative = Pick<ReturnType<typeof structureNative>,
  "citationLookupKey" | "docxAuthorityTextUnits">;

function citationInputs(raw: unknown): CitationInput[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 100) {
    throw new Error("DOCX citations must be an array of at most 100 entries.");
  }
  const seen = new Set<string>();
  let evidenceCount = 0;
  return raw.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Each DOCX citation must be an object.");
    }
    const row = value as Record<string, unknown>;
    if (Object.keys(row).some((key) => !["id", "evidence_ids"].includes(key))) {
      throw new Error("DOCX citation objects contain unsupported fields.");
    }
    const id = typeof row.id === "string" ? row.id.trim() : "";
    const evidenceIds = Array.isArray(row.evidence_ids)
      ? row.evidence_ids.map((item) => typeof item === "string" ? item.trim() : "")
      : [];
    if (!CITATION_ID.test(id) || seen.has(id)) {
      throw new Error("DOCX citation ids must be unique lowercase identifiers.");
    }
    if (
      !evidenceIds.length ||
      evidenceIds.length > 16 ||
      evidenceIds.some((evidenceId) => !EVIDENCE_ID.test(evidenceId)) ||
      new Set(evidenceIds).size !== evidenceIds.length
    ) {
      throw new Error(`DOCX citation "${id}" has invalid evidence_ids.`);
    }
    evidenceCount += evidenceIds.length;
    if (evidenceCount > 256) {
      throw new Error("DOCX citations contain more than 256 evidence ids.");
    }
    seen.add(id);
    return { id, evidenceIds };
  });
}

function safeUrls(values: Array<string | null | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export function resolveDocxEvidenceCitations(
  state: LegalEvidenceTurnState | undefined,
  rawCitations: unknown,
): ResolvedDocxEvidenceCitations {
  const inputs = citationInputs(rawCitations);
  if (inputs.length && !state) {
    throw new Error("DOCX citations require this turn's legal evidence registry.");
  }
  const resolved = inputs.map((input) => {
    const entries = input.evidenceIds.map((evidenceId) => {
      const entry = state?.evidence.get(evidenceId);
      if (!entry) {
        throw new Error(
          `DOCX citation "${input.id}" has unknown evidence_id: ${evidenceId}.`,
        );
      }
      if (entry.receipt.scope !== "passage" || !entry.receipt.span_text) {
        throw new Error(
          `DOCX citation "${input.id}" requires exact passage evidence: ${evidenceId}.`,
        );
      }
      return entry;
    });
    const projected = entries.map(legalEvidenceDocumentLink);
    const grouped = new Map<string, DocxCitation["sources"][number]>();
    for (const source of projected) {
      const existing = grouped.get(source.stableId);
      if (!existing) {
        grouped.set(source.stableId, {
          stableId: source.stableId,
          authority: source.authority,
          shortAuthority: source.shortAuthority,
          mainUrl: source.mainUrl,
          pinpoints: source.pinpoint ? [source.pinpoint] : [],
        });
      } else if (
        source.pinpoint &&
        !existing.pinpoints.some(
          (pinpoint) =>
            pinpoint.text === source.pinpoint?.text &&
            pinpoint.url === source.pinpoint?.url,
        )
      ) {
        existing.pinpoints.push(source.pinpoint);
      }
    }
    const citation: DocxCitation = { sources: [...grouped.values()] };
    return {
      id: input.id,
      citation,
      binding: {
        id: input.id,
        evidenceIds: input.evidenceIds,
        sourceSha256s: [...new Set(projected.map(({ sourceSha256 }) => sourceSha256))],
        locators: projected.flatMap(({ pinpoint }) => pinpoint ? [pinpoint.text] : []),
        mainUrls: safeUrls(projected.map(({ mainUrl }) => mainUrl)),
        pinpointUrls: safeUrls(projected.map(({ pinpoint }) => pinpoint?.url)),
      },
    };
  });
  if (state) {
    registerDocumentLegalEvidence(
      state,
      resolved.flatMap(({ binding }) => binding.evidenceIds),
    );
  }
  return {
    citations: Object.fromEntries(resolved.map(({ id, citation }) => [id, citation])),
    bindings: resolved.map(({ binding }) => binding),
  };
}

function ledgerInputs(state: LegalEvidenceTurnState,
  resolved: ResolvedDocxEvidenceCitations, native: LedgerNative) {
  const receipts = new Map<string, LegalEvidenceReceipt[]>();
  const sources = new Map<string, LedgerSource[]>();
  try {
    for (const binding of resolved.bindings) {
      const entries = binding.evidenceIds.map((id) => state.evidence.get(id)!);
      const bySource = new Map<string, typeof entries>();
      for (const entry of entries) {
        const list = bySource.get(entry.receipt.stable_source_id) ?? [];
        list.push(entry); bySource.set(entry.receipt.stable_source_id, list);
      }
      const markerSources = resolved.citations[binding.id].sources.map((source) => {
        const grouped = bySource.get(source.stableId);
        if (!grouped?.length) throw new Error("Citation source is unavailable");
        const key = native.citationLookupKey(grouped[0].receipt.citation);
        if (!key) throw new Error("Citation identity is unavailable");
        const known = receipts.get(key) ?? [];
        for (const { receipt } of grouped) {
          if (!known.some(({ evidence_id }) => evidence_id === receipt.evidence_id)) {
            known.push(receipt);
          }
        }
        receipts.set(key, known);
        const pinpoints = source.pinpoints.map((pinpoint) => {
          const entry = grouped.find((candidate) =>
            legalEvidenceDocumentLink(candidate).pinpoint?.text === pinpoint.text);
          const kind = entry?.receipt.locator.kind;
          if (kind !== "paragraph" && kind !== "section" && kind !== "page") {
            throw new Error("Citation pinpoint is unavailable");
          }
          return { kind, text: pinpoint.text, ...(pinpoint.separator
            ? { separator: pinpoint.separator } : {}) };
        });
        return { authorityKey: key, stableId: source.stableId,
          authority: source.authority, shortAuthority: source.shortAuthority,
          evidenceIds: grouped.map(({ receipt }) => receipt.evidence_id), pinpoints };
      });
      sources.set(binding.id, markerSources);
    }
  } catch { return null; }
  try {
    return { seeds: [...receipts].map(([key, values]) =>
      authoritySeedFromReceipts(key, values)), sources };
  } catch { return null; }
}

const sourceText = (source: LedgerSource, authority = source.authority) =>
  authority + source.pinpoints.map((pinpoint, index) =>
    `${index ? ", " : pinpoint.separator ?? " at "}${pinpoint.text}`).join("");

function textPositions(units: NativeAuthorityTextUnit[], kind: "body" | "footnote",
  text: string) {
  const positions: Array<{ unit: NativeAuthorityTextUnit; start: number }> = [];
  for (const unit of units) {
    if (unit.kind !== kind) continue;
    for (let start = unit.text.indexOf(text); start >= 0;
      start = unit.text.indexOf(text, start + Math.max(1, text.length))) {
      positions.push({ unit, start });
    }
  }
  return positions;
}

/** Builds a version-bound ledger from verified renderer markers, or abstains on ambiguity. */
export async function createDocxAuthorityLedger(state: LegalEvidenceTurnState | undefined,
  markdown: string, bytes: Buffer, resolved: ResolvedDocxEvidenceCitations,
  placement: "footnotes" | "inline" | "after-paragraph" | "none",
  native: LedgerNative = structureNative()):
  Promise<Omit<AuthorityCitationLedger, "document"> | undefined> {
  if (!state || !resolved.bindings.length) return undefined;
  const input = ledgerInputs(state, resolved, native);
  if (!input) return undefined;
  const markers = docxMarkdownCitationMarkers(markdown);
  if (placement === "after-paragraph" && markers.body.length) return undefined;
  const appearances: Array<{ markerId: string; occurrence: number;
    kind: "body" | "footnote"; sources: Array<LedgerSource & {
      renderedAuthority: string; displayedForm: "full" | "supra" | "ibid" }> }> = [];
  if (placement !== "none") {
    const firstNote = new Map<string, number>();
    let previous: string | null = null;
    for (const [index, marker] of markers.body.entries()) {
      const markerSources = input.sources.get(marker.id);
      if (!markerSources) continue;
      const rendered: Array<LedgerSource & { renderedAuthority: string;
        displayedForm: "full" | "supra" | "ibid" }> = markerSources.map((source) => ({
          ...source, renderedAuthority: source.authority, displayedForm: "full",
        }));
      if (placement === "footnotes" && rendered.length === 1) {
        const source = rendered[0], note = firstNote.get(source.stableId);
        source.displayedForm = previous === source.stableId ? "ibid" : note ? "supra" : "full";
        source.renderedAuthority = source.displayedForm === "ibid" ? "Ibid"
          : source.displayedForm === "supra"
          ? `${source.shortAuthority}, supra note ${note}` : source.authority;
        if (!note) firstNote.set(source.stableId, markers.footnoteCount + index + 1);
        previous = source.stableId;
      } else if (placement === "footnotes") previous = null;
      appearances.push({ markerId: marker.id, occurrence: marker.occurrence,
        kind: placement === "footnotes" ? "footnote" : "body",
        sources: rendered });
    }
  }
  for (const marker of markers.footnotes) {
    const markerSources = input.sources.get(marker.id);
    if (markerSources) appearances.push({ markerId: marker.id,
      occurrence: marker.occurrence, kind: "footnote",
      sources: markerSources.map((source) => ({ ...source,
        renderedAuthority: source.authority, displayedForm: "full" })) });
  }
  const units = await native.docxAuthorityTextUnits(bytes);
  const expected = new Map<string, number>();
  for (const appearance of appearances) {
    const text = appearance.sources.map((source) =>
      sourceText(source, source.renderedAuthority)).join("; ");
    const key = `${appearance.kind}\0${text}`;
    expected.set(key, (expected.get(key) ?? 0) + 1);
  }
  const positions = new Map<string, ReturnType<typeof textPositions>>();
  for (const [key, count] of expected) {
    const [kind, text] = key.split("\0") as ["body" | "footnote", string];
    const found = textPositions(units, kind, text);
    if (found.length !== count) return undefined;
    positions.set(key, found);
  }
  const localOrdinals = new Map<string, number>();
  const occurrences = appearances.flatMap((appearance) => {
    const rendered = appearance.sources.map((source) =>
      sourceText(source, source.renderedAuthority));
    const whole = rendered.join("; "), key = `${appearance.kind}\0${whole}`;
    const position = positions.get(key)?.shift();
    if (!position) return [];
    let offset = position.start;
    return appearance.sources.map((source, index) => {
      if (index) offset += 2;
      const text = rendered[index], start = offset; offset += text.length;
      const localOrdinal = localOrdinals.get(position.unit.key) ?? 0;
      localOrdinals.set(position.unit.key, localOrdinal + 1);
      return { id: `${position.unit.key}:ledger:${localOrdinal}`,
        markerId: appearance.markerId, targetId: source.authorityKey,
        authorityKey: source.authorityKey,
        unit: { id: position.unit.key, kind: position.unit.kind,
          ordinal: position.unit.ordinal, footnoteId: position.unit.footnote_id,
          footnoteRefs: position.unit.footnote_refs,
          pageNumbers: position.unit.page_numbers, text: position.unit.text,
          sourceTextSha256: sha256(position.unit.text) }, start, end: offset, text,
        displayedForm: source.displayedForm,
        pinpoints: source.pinpoints.map(({ kind, text }) => ({ kind, text })),
        evidenceIds: source.evidenceIds, localOrdinal };
    });
  });
  return { schemaVersion: "beaver.authority-ledger.v1", seeds: input.seeds, occurrences };
}
