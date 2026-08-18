import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  legalSourcePassageUrl,
  legalSourceProviderFamily,
  readLegalSourcePassage,
  resolveLegalSource,
} from "./legalSourceRegistry";
import type { LegalSourceKind, LegalSourceLocator } from "./legalSources";
import { addLocalVersion, getLocalVersionFile } from "./localDocumentStore";
import { runLegalPdf } from "./legalPdfProcess";

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
        kind: intent.locator_kind,
        value: intent.locator.trim(),
      } satisfies LegalSourceLocator;
}

function sourceKind(intent: DocxCitationIntent): LegalSourceKind | null {
  if (intent.kind === "journal") return "journal";
  if (intent.kind === "statute") return "legislation";
  return ["case", "unreported"].includes(intent.kind) ? "case" : null;
}

async function resolveIntent(
  intent: DocxCitationIntent,
): Promise<{ provider: string; url: string } | null> {
  const text = citationText(intent);
  const kind = sourceKind(intent);
  if (!text || !kind) return null;
  const resolved = await resolveLegalSource({
    text,
    kind,
    alternateTexts: [intent.citation_with_style, intent.short_form]
      .map(clean)
      .filter(Boolean),
  });
  if (resolved.status !== "found") return null;
  const passage = await readLegalSourcePassage({
    source: resolved.value,
    locator: locator(intent) ?? undefined,
    contextBlocks: 0,
  });
  if (passage.status !== "found") return null;
  const selected = passage.values.filter(({ role }) =>
    locator(intent) ? role === "selected" : role === "document",
  );
  if (selected.length !== 1) return null;
  const url = legalSourcePassageUrl(selected[0], quotes(intent));
  return url
    ? { provider: legalSourceProviderFamily(selected[0]), url }
    : null;
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

type SavedVersion = {
  id: string;
  filename: string;
  version_number?: number;
  file_type?: string;
  source_sha256?: string;
  parentVersionId?: string;
};

export async function linkDocxCitations(input: {
  documentId: string;
  sourceVersionId: string;
  filename: string;
  bytes: Buffer;
  saveVersion: (input: {
    sourceVersionId: string;
    filename: string;
    bytes: Buffer;
  }) => Promise<SavedVersion | null>;
}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "beaver-docx-links-"));
  try {
    const inputPath = path.join(temporary, "source.docx");
    const planPath = path.join(temporary, "plan.json");
    const linksPath = path.join(temporary, "links.json");
    const outputPath = path.join(temporary, "linked.docx");
    await writeFile(inputPath, input.bytes);
    await runLegalPdf(
      [
        "docx-link-plan",
        inputPath,
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
        inputPath,
        "--plan",
        planPath,
        "--links",
        linksPath,
        "--output",
        outputPath,
      ],
    );
    const original = input.filename.replace(/\.docx$/iu, "");
    const filename = `${original} - linked.docx`;
    const outputBytes = await readFile(outputPath);
    const version = await input.saveVersion({
      sourceVersionId: input.sourceVersionId,
      filename,
      bytes: outputBytes,
    });
    if (!version) throw new Error("Document disappeared before saving");
    const downloadUrl =
      `/single-documents/${encodeURIComponent(input.documentId)}/file` +
      `?version_id=${encodeURIComponent(version.id)}`;
    return {
      ok: true,
      receipt: "mike-document:v1",
      action: "revised",
      document_id: input.documentId,
      parent_version_id:
        ("parentVersionId" in version ? version.parentVersionId : undefined) ??
        input.sourceVersionId,
      version_id: version.id,
      version_number: version.version_number,
      filename: version.filename,
      file_type: version.file_type ?? "docx",
      source_sha256: version.source_sha256,
      download_url: downloadUrl,
      annotations: [],
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

export async function linkLocalDocxCitations(
  userId: string,
  documentId: string,
  options: {
    saveVersion?: Parameters<typeof linkDocxCitations>[0]["saveVersion"];
  } = {},
) {
  const file = await getLocalVersionFile(userId, documentId);
  if (!file) throw new Error("Document not found");
  if (file.fileType.toLowerCase() !== "docx") {
    throw new Error("Citation linking currently requires a DOCX document");
  }
  return linkDocxCitations({
    documentId,
    sourceVersionId: file.version.id,
    filename: file.document.filename,
    bytes: await readFile(file.path),
    saveVersion: options.saveVersion ?? (async ({ filename, bytes }) =>
      addLocalVersion({ userId, documentId, filename, bytes })),
  });
}
