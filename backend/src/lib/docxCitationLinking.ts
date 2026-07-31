import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  fetchA2AJDocument,
  getA2AJDocumentSourceDoc,
  lookupA2AJLocator,
  type A2AJLocatorKind,
} from "./a2aj";
import {
  getCourtlistenerCases,
  getCourtlistenerOpinionStructure,
  lookupCourtlistenerOpinionLocator,
  verifyCourtlistenerCitations,
} from "./courtlistener";
import {
  fetchJournalArticle,
  searchJournalArticles,
  lookupJournalArticle,
} from "./journalArticles";
import {
  buildA2AJPinpointUrl,
  buildLegalSourcePinpointUrl,
} from "./legalSourceLinks";
import { addLocalVersion, getLocalVersionFile } from "./localDocumentStore";
import {
  fetchGovInfoCase,
  fetchGovUkEtCase,
  fetchTnaCase,
  lookupPublicLegalSource,
  searchGovInfoCase,
  searchGovUkEtCase,
  searchTnaCase,
  type PublicLegalDocument,
} from "./publicLegalSources";
import { runLegalPdf } from "./legalPdfProcess";

const US_REPORTER =
  /\b\d{1,4}\s+(?:U\.?\s*S\.?|S\.?\s*Ct\.?|L\.?\s*Ed\.?(?:\s*2d)?|F\.?(?:\s*Supp\.?)?(?:\s*2d|\s*3d|\s*4th)?)\s+\d{1,6}\b/iu;
const CANADIAN =
  /\b(?:\d{4}\s+[A-Z][A-Z0-9]{1,12}\s+\d+|\d+\s+S\.?C\.?R\.?\s+\d+|R\.?S\.?[A-Z]\.?\s+\d{4})\b/iu;
const TNA =
  /\[(?:19|20)\d{2}\]\s+(?:UKSC|UKPC|EWCA\s+(?:Civ|Crim)|EWHC|EWCC|EWFC|EWCOP|EWCR|UKUT|UKFTT|EAT)\s+\d+/iu;
const ET_CASE = /(?<![\w/])(?:[A-Z]\/)?\d{6,8}\/(?:19|20)\d{2}(?![\w/])/iu;
const GOVINFO_DOCKET =
  /\b(?:\d{1,2}:\d{2,4}-(?:cv|cr|bk|ap|md|mj|mc)-\d{1,8}|(?:case\s+)?no\.?\s*\d{2}-\d{3,6})\b/iu;

type JsonRecord = Record<string, unknown>;

export type DocxCitationIntent = {
  part_id: string;
  verbatim: string;
  kind: string;
  bare_citation: string;
  citation_with_style: string;
  short_form: string;
  support_quote: string;
  locator_kind: "paragraph" | "section" | "page" | "none";
  locator: string;
};

export type DocxCitationLinkPlan = {
  schema_version: "legalpdf.docx_link_plan.v1";
  source_sha256: string;
  footnotes: { parts: DocxCitationIntent[] }[];
  telemetry?: unknown;
};

export type ResolvedDocxCitationLinks = {
  links: Record<string, string>;
  unresolved: { part_id: string; reason: string }[];
  providers: Record<string, number>;
};

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function clean(value: string) {
  return value.trim().replace(/\s+/gu, " ");
}

function exact(value: string) {
  return clean(value)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function citationText(intent: DocxCitationIntent) {
  return clean(intent.bare_citation || intent.citation_with_style);
}

function quotes(intent: DocxCitationIntent) {
  return intent.support_quote.trim() ? [intent.support_quote.trim()] : [];
}

function locator(intent: DocxCitationIntent) {
  return intent.locator_kind === "none" || !intent.locator.trim()
    ? null
    : {
        kind: intent.locator_kind as A2AJLocatorKind,
        value: intent.locator.trim(),
      };
}

async function resolveA2AJ(intent: DocxCitationIntent) {
  const citation = citationText(intent);
  const docType = intent.kind === "statute" ? "laws" : "cases";
  const requested = locator(intent);
  if (requested) {
    const lookup = await lookupA2AJLocator({
      citation,
      docType,
      kind: requested.kind,
      locator: requested.value,
      contextBlocks: 0,
    });
    return lookup?.status === "found" && lookup.block
      ? buildA2AJPinpointUrl(lookup, quotes(intent))
      : null;
  }
  const document = await fetchA2AJDocument({
    citation,
    docType,
    maxChars: 300_000,
  });
  if (!document?.url) return null;
  const source = getA2AJDocumentSourceDoc(document);
  return buildLegalSourcePinpointUrl(
    { url: document.url, blockText: source, documentText: source },
    quotes(intent),
  );
}

function uniqueClusterId(value: unknown) {
  const links = record(value)?.citationLinks;
  if (!Array.isArray(links)) return null;
  const ids = [
    ...new Set(
      links.flatMap((raw) => {
        const id = record(raw)?.clusterId;
        return typeof id === "number" && Number.isSafeInteger(id) && id > 0
          ? [id]
          : [];
      }),
    ),
  ];
  return ids.length === 1 ? ids[0] : null;
}

async function resolveCourtlistener(intent: DocxCitationIntent) {
  const verified = await verifyCourtlistenerCitations({
    citations: [citationText(intent)],
  });
  const clusterId = uniqueClusterId(verified);
  if (!clusterId) return null;
  const payload = await getCourtlistenerCases({
    clusterIds: [clusterId],
    includeFullText: true,
    maxChars: 50_000,
  });
  const rawCase = Array.isArray(payload.cases) ? payload.cases[0] : null;
  const caseRecord = record(rawCase);
  if (!caseRecord) return null;
  const opinions = Array.isArray(caseRecord.opinions)
    ? caseRecord.opinions.filter(
        (opinion): opinion is object =>
          Boolean(opinion) && typeof opinion === "object",
      )
    : [];
  const caseUrl =
    typeof caseRecord.url === "string" && caseRecord.url.trim()
      ? caseRecord.url
      : null;
  const requested = locator(intent);
  if (!requested) {
    const opinion = opinions.length === 1 ? record(opinions[0]) : null;
    const opinionUrl = typeof opinion?.url === "string" ? opinion.url : caseUrl;
    const structure = opinion
      ? getCourtlistenerOpinionStructure(opinion)
      : null;
    return opinionUrl && structure
      ? buildLegalSourcePinpointUrl(
          {
            url: opinionUrl,
            blockText: structure,
            documentText: structure,
          },
          quotes(intent),
        )
      : null;
  }
  const matches = opinions.flatMap((opinion) => {
    const lookup = lookupCourtlistenerOpinionLocator(
      opinion,
      requested.kind,
      requested.value,
      0,
    );
    return lookup?.status === "found" && lookup.block
      ? [{ opinion, lookup }]
      : [];
  });
  if (matches.length !== 1) return null;
  const match = matches[0];
  const opinion = record(match.opinion);
  const url =
    (typeof opinion?.url === "string" ? opinion.url : null) ?? caseUrl;
  if (!url) return null;
  const documentText = getCourtlistenerOpinionStructure(match.opinion);
  if (!documentText) return null;
  return buildLegalSourcePinpointUrl(
    {
      url,
      anchor: match.lookup.block!.anchor,
      blockText: match.lookup.block!.text,
      documentText,
      pageScoped: requested.kind === "page",
    },
    quotes(intent),
  );
}

async function resolvePublicDocument(
  document: PublicLegalDocument | null,
  intent: DocxCitationIntent,
) {
  if (!document) return null;
  const requested = locator(intent);
  if (!requested) {
    return buildLegalSourcePinpointUrl(
      {
        url: document.url,
        blockText: document.structure,
        documentText: document.structure,
      },
      quotes(intent),
    );
  }
  const lookup = lookupPublicLegalSource(
    document,
    requested.kind,
    requested.value,
    0,
  );
  return lookup.status === "found" && lookup.block
    ? buildLegalSourcePinpointUrl(
        {
          url: document.url,
          anchor: lookup.anchor ?? undefined,
          blockText: lookup.block.text,
          documentText: document.structure,
          pageScoped: requested.kind === "page",
        },
        quotes(intent),
      )
    : null;
}

async function resolvePublicCase(intent: DocxCitationIntent) {
  const citation = citationText(intent);
  if (TNA.test(citation)) {
    const match = await searchTnaCase(citation);
    return resolvePublicDocument(
      match ? await fetchTnaCase(match) : null,
      intent,
    );
  }
  if (ET_CASE.test(citation)) {
    const match = await searchGovUkEtCase(citation);
    return resolvePublicDocument(
      match ? await fetchGovUkEtCase(match) : null,
      intent,
    );
  }
  if (GOVINFO_DOCKET.test(citation)) {
    const match = await searchGovInfoCase(citation);
    return resolvePublicDocument(
      match ? await fetchGovInfoCase(match) : null,
      intent,
    );
  }
  return null;
}

async function resolveJournal(intent: DocxCitationIntent) {
  const candidates = [
    citationText(intent),
    clean(intent.citation_with_style),
    clean(intent.short_form),
  ].filter(Boolean);
  let article = null;
  for (const candidate of candidates) {
    article = fetchJournalArticle(candidate);
    if (article) break;
  }
  if (!article) {
    const matches = searchJournalArticles(candidates[0], 10).filter((match) =>
      candidates.some(
        (candidate) =>
          exact(candidate) === exact(match.citation) ||
          exact(candidate) === exact(match.name),
      ),
    );
    if (matches.length === 1) {
      article = fetchJournalArticle(String(matches[0].articleId));
    }
  }
  if (!article) return null;
  const requested = locator(intent);
  if (!requested) {
    return buildLegalSourcePinpointUrl(
      {
        url: article.url,
        blockText: article.structure,
        documentText: article.structure,
      },
      quotes(intent),
    );
  }
  const lookup = lookupJournalArticle(
    article,
    requested.kind,
    requested.value,
    0,
  );
  return lookup.status === "found" && lookup.block
    ? buildLegalSourcePinpointUrl(
        {
          url: article.url,
          anchor: lookup.anchor ?? undefined,
          blockText: lookup.block.text,
          documentText: article.structure,
          pageScoped: requested.kind === "page",
        },
        quotes(intent),
      )
    : null;
}

export function citationProvider(intent: DocxCitationIntent) {
  const citation = citationText(intent);
  if (intent.kind === "journal") return "journal";
  if (intent.kind === "statute") return "a2aj";
  if (!["case", "unreported"].includes(intent.kind)) return null;
  if (
    TNA.test(citation) ||
    ET_CASE.test(citation) ||
    GOVINFO_DOCKET.test(citation)
  ) {
    return "public";
  }
  if (US_REPORTER.test(citation)) return "courtlistener";
  if (CANADIAN.test(citation)) return "a2aj";
  return null;
}

async function resolveIntent(
  intent: DocxCitationIntent,
): Promise<{ provider: string; url: string } | null> {
  const citation = citationText(intent);
  if (!citation) return null;
  const provider = citationProvider(intent);
  if (provider === "journal") {
    const url = await resolveJournal(intent);
    return url ? { provider: "journal", url } : null;
  }
  if (provider === "a2aj") {
    const url = await resolveA2AJ(intent);
    return url ? { provider: "a2aj", url } : null;
  }
  if (provider === "public") {
    const url = await resolvePublicCase(intent);
    return url ? { provider: "public", url } : null;
  }
  if (provider === "courtlistener") {
    const url = await resolveCourtlistener(intent);
    return url ? { provider: "courtlistener", url } : null;
  }
  return null;
}

function validPlan(value: unknown): value is DocxCitationLinkPlan {
  const plan = record(value);
  return (
    plan?.schema_version === "legalpdf.docx_link_plan.v1" &&
    typeof plan.source_sha256 === "string" &&
    Array.isArray(plan.footnotes)
  );
}

export async function resolveDocxCitationLinks(
  plan: DocxCitationLinkPlan,
  resolver: (
    intent: DocxCitationIntent,
  ) => Promise<{ provider: string; url: string } | null> = resolveIntent,
): Promise<ResolvedDocxCitationLinks> {
  const links: Record<string, string> = {};
  const unresolved: ResolvedDocxCitationLinks["unresolved"] = [];
  const providers: Record<string, number> = {};
  const intents = plan.footnotes.flatMap((note) => note.parts);
  const pending = new Map<
    string,
    Promise<{ provider: string; url: string } | null>
  >();
  const resolved = new Array<{ provider: string; url: string } | null | Error>(
    intents.length,
  );
  let cursor = 0;
  const worker = async () => {
    while (cursor < intents.length) {
      const index = cursor++;
      const intent = intents[index];
      const key = JSON.stringify([
        intent.kind,
        citationText(intent),
        intent.locator_kind,
        intent.locator,
        intent.support_quote,
      ]);
      let request = pending.get(key);
      if (!request) {
        request = resolver(intent);
        pending.set(key, request);
      }
      try {
        resolved[index] = await request;
      } catch (error) {
        resolved[index] =
          error instanceof Error ? error : new Error("Provider lookup failed");
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(6, Math.max(1, intents.length)) }, () =>
      worker(),
    ),
  );

  for (const [index, intent] of intents.entries()) {
    try {
      const match = resolved[index];
      if (match instanceof Error) throw match;
      let verifiedUrl: URL | null = null;
      try {
        verifiedUrl = match ? new URL(match.url) : null;
      } catch {
        verifiedUrl = null;
      }
      if (
        !match ||
        !verifiedUrl ||
        !["http:", "https:"].includes(verifiedUrl.protocol) ||
        verifiedUrl.username ||
        verifiedUrl.password
      ) {
        unresolved.push({
          part_id: intent.part_id,
          reason: "No unique verified provider match",
        });
        continue;
      }
      links[intent.part_id] = match.url;
      providers[match.provider] = (providers[match.provider] ?? 0) + 1;
    } catch (error) {
      unresolved.push({
        part_id: intent.part_id,
        reason:
          error instanceof Error ? error.message : "Provider lookup failed",
      });
    }
  }
  return { links, unresolved, providers };
}

export async function linkLocalDocxCitations(
  userId: string,
  documentId: string,
) {
  const file = await getLocalVersionFile(userId, documentId);
  if (!file) throw new Error("Document not found");
  if (file.fileType.toLowerCase() !== "docx") {
    throw new Error("Citation linking currently requires a DOCX document");
  }
  const temporary = await mkdtemp(path.join(os.tmpdir(), "beaver-docx-links-"));
  try {
    const planPath = path.join(temporary, "plan.json");
    const linksPath = path.join(temporary, "links.json");
    const outputPath = path.join(temporary, "linked.docx");
    await runLegalPdf(
      [
        "docx-link-plan",
        file.path,
        "--output",
        planPath,
        "--strategy",
        process.env.MIKE_DOCX_LINK_STRATEGY?.trim() || "auto",
        "--model",
        process.env.MIKE_DOCX_LINK_MODEL?.trim() || "gpt-5.6-sol",
        "--effort",
        process.env.MIKE_DOCX_LINK_EFFORT?.trim() || "none",
      ],
    );
    const rawPlan: unknown = JSON.parse(await readFile(planPath, "utf8"));
    if (!validPlan(rawPlan))
      throw new Error("Citation worker returned an invalid plan");
    const resolved = await resolveDocxCitationLinks(rawPlan);
    if (!Object.keys(resolved.links).length) {
      throw new Error(
        `No citation had a unique verified provider match (${resolved.unresolved.length} unresolved)`,
      );
    }
    await writeFile(
      linksPath,
      JSON.stringify({ links: resolved.links }),
      "utf8",
    );
    await runLegalPdf(
      [
        "docx-apply-links",
        file.path,
        "--plan",
        planPath,
        "--links",
        linksPath,
        "--output",
        outputPath,
      ],
    );
    const original = file.document.filename.replace(/\.docx$/iu, "");
    const version = await addLocalVersion({
      userId,
      documentId,
      filename: `${original} - linked.docx`,
      bytes: await readFile(outputPath),
    });
    if (!version) throw new Error("Document disappeared before saving");
    return {
      ok: true,
      document_id: documentId,
      version_id: version.id,
      filename: version.filename,
      linked_citations: Object.keys(resolved.links).length,
      unresolved_citations: resolved.unresolved.length,
      providers: resolved.providers,
      strategy: rawPlan.footnotes.length
        ? (record(rawPlan)?.strategy_used ?? null)
        : null,
      worker_telemetry: rawPlan.telemetry ?? null,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
