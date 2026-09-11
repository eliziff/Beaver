import { legalEvidenceDocumentLink } from "./chat/citations";
import { legalEvidenceLocatorText } from "./chat/citationPresentation";
import {
  registerDocumentLegalEvidence,
  type LegalEvidenceReceipt,
  type LegalEvidenceTurnState,
} from "./chat/legalEvidence";
import type { DocxCitation, DocxCitationAppearance } from "./chat/tools/docxMarkdown";
import { authoritySeedFromReceipts,
  type AuthorityCitationLedger } from "./authoritiesDomain";
import { sha256 } from "./hash";
import { structureNative, type NativeAuthorityTextUnit } from "./structureNative";
import { isJsonRecord } from "./value";

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
  evidenceIds: string[];
  pinpoints: Array<{ kind: "paragraph" | "section" | "page"; text: string;
    separator?: " at " | ", " }>;
};

type LedgerNative = Pick<ReturnType<typeof structureNative>,
  "citationLookupKey" | "docxAuthorityTextUnits">;

function citationInputs(raw: unknown): CitationInput[] {
  if (raw === undefined) return [];
  if (!isJsonRecord(raw) || Object.keys(raw).length > 100) {
    throw new Error("DOCX citations must be an object of at most 100 entries.");
  }
  const seen = new Set<string>();
  let evidenceCount = 0;
  return Object.entries(raw).map(([key, value]) => {
    const id = key.trim();
    const evidenceIds = Array.isArray(value)
      ? value.map((item) => typeof item === "string" ? item.trim() : "")
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
            legalEvidenceLocatorText(candidate) === pinpoint.text);
          const kind = entry?.receipt.locator.kind;
          if (kind !== "paragraph" && kind !== "section" && kind !== "page") {
            throw new Error("Citation pinpoint is unavailable");
          }
          return { kind, text: pinpoint.text, ...(pinpoint.separator
            ? { separator: pinpoint.separator } : {}) };
        });
        return { authorityKey: key, stableId: source.stableId,
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

function textPositions(units: NativeAuthorityTextUnit[], kind: "body" | "footnote",
  text: string, noteId?: number) {
  const positions: Array<{ unit: NativeAuthorityTextUnit; start: number }> = [];
  // An empty rendered citation has no position to bind, and searching for one never
  // advances past the end of the unit: the ledger abstains instead of spinning.
  if (!text) return positions;
  for (const unit of units) {
    if (unit.kind !== kind || (noteId !== undefined && unit.footnote_id !== noteId)) continue;
    for (let start = unit.text.indexOf(text); start >= 0;
      start = unit.text.indexOf(text, start + text.length)) {
      positions.push({ unit, start });
    }
  }
  return positions;
}

/** Builds a version-bound ledger from verified renderer markers, or abstains on ambiguity. */
export async function createDocxAuthorityLedger(state: LegalEvidenceTurnState | undefined,
  bytes: Buffer, resolved: ResolvedDocxEvidenceCitations, appearances: readonly DocxCitationAppearance[],
  native: LedgerNative = structureNative()):
  Promise<Omit<AuthorityCitationLedger, "document"> | undefined> {
  if (!state || !resolved.bindings.length) return undefined;
  const input = ledgerInputs(state, resolved, native);
  if (!input) return undefined;
  const units = await native.docxAuthorityTextUnits(bytes);
  const expected = new Map<string, number>();
  for (const appearance of appearances) {
    const text = appearance.sources.map((source) => source.text).join("; ");
    const key = `${appearance.kind}\0${appearance.noteId ?? ""}\0${text}`;
    expected.set(key, (expected.get(key) ?? 0) + 1);
  }
  const positions = new Map<string, ReturnType<typeof textPositions>>();
  // Reserve complete groups before counting their constituent citation strings.
  const claimed: Array<{ unit: NativeAuthorityTextUnit; start: number; end: number }> = [];
  for (const [key, count] of [...expected].sort(([a], [b]) => b.length - a.length)) {
    const [kind, noteId, text] = key.split("\0") as ["body" | "footnote", string, string];
    const found = textPositions(units, kind, text, noteId ? Number(noteId) : undefined)
      .filter(({ unit, start }) => !claimed.some((span) => span.unit === unit && start >= span.start && start + text.length <= span.end));
    if (found.length !== count || found.some(({ unit, start }) => claimed.some((span) =>
      span.unit === unit && start < span.end && start + text.length > span.start))) return undefined;
    positions.set(key, found);
    claimed.push(...found.map(({ unit, start }) => ({ unit, start, end: start + text.length })));
  }
  const localOrdinals = new Map<string, number>();
  const occurrences: AuthorityCitationLedger["occurrences"] = [];
  for (const appearance of appearances) {
    const whole = appearance.sources.map((source) => source.text).join("; "), key = `${appearance.kind}\0${appearance.noteId ?? ""}\0${whole}`;
    const position = positions.get(key)?.shift();
    if (!position) return undefined;
    let offset = position.start;
    for (const [index, renderedSource] of appearance.sources.entries()) {
      const source = input.sources.get(appearance.markerId)?.find((source) => source.stableId === renderedSource.stableId);
      if (!source) return undefined;
      if (index) offset += 2;
      const text = renderedSource.text, start = offset; offset += text.length;
      const localOrdinal = localOrdinals.get(position.unit.key) ?? 0;
      localOrdinals.set(position.unit.key, localOrdinal + 1);
      occurrences.push({ id: `${position.unit.key}:ledger:${localOrdinal}`,
        markerId: appearance.markerId, targetId: source.authorityKey,
        authorityKey: source.authorityKey,
        unit: { id: position.unit.key, kind: position.unit.kind,
          ordinal: position.unit.ordinal, footnoteId: position.unit.footnote_id,
          footnoteRefs: position.unit.footnote_refs,
          pageNumbers: position.unit.page_numbers, text: position.unit.text,
          sourceTextSha256: sha256(position.unit.text) }, start, end: offset, text,
        displayedForm: renderedSource.displayedForm,
        pinpoints: source.pinpoints.map(({ kind, text }) => ({ kind, text })),
        evidenceIds: source.evidenceIds, localOrdinal });
    }
  }
  return { schemaVersion: "beaver.authority-ledger.v1", seeds: input.seeds, occurrences };
}
