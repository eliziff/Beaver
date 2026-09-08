import type { ResearchSourceReference } from "./researchContract";
import type { LegalSourceReference } from "./legalSources/reference";

export type ResourceReference =
  | { kind: "document"; documentId: string; versionId: string }
  | { kind: "source"; provider: string; sourceId: string }
  | { kind: "project" | "workflow"; id: string };

export const RESOURCE_LOCATOR_KINDS = [
  "page",
  "paragraph",
  "footnote",
  "section",
  "subsection",
  "provision_paragraph",
  "subparagraph",
  "clause",
  "subclause",
  "schedule",
  "article",
] as const;

const DOCUMENT_RESOURCE = "document://[^/?#]+/version/[^/?#]+";
export const DOCUMENT_RESOURCE_PATTERN = `^${DOCUMENT_RESOURCE}$`;
export const DOCUMENT_OR_DRAFT_PATTERN = `^(?:${DOCUMENT_RESOURCE}|draft-[1-9][0-9]*)$`;
export const READABLE_RESOURCE_PATTERN = `^(?:${DOCUMENT_RESOURCE}|source://[^/?#]+/[^/?#]+|workflow://[^/?#]+|draft-[1-9][0-9]*|[eq]_[A-Za-z0-9_-]+|evidence|queries|selection|findings)$`;

const segment = (value: string) => {
  if (!value) throw new Error("Resource reference segments cannot be empty");
  return encodeURIComponent(value);
};

export const resourceReference = {
  document: (documentId: string, versionId: string) =>
    `document://${segment(documentId)}/version/${segment(versionId)}`,
  source: (provider: string, sourceId: string) =>
    `source://${segment(provider)}/${segment(sourceId)}`,
  project: (id: string) => `project://${segment(id)}`,
  workflow: (id: string) => `workflow://${segment(id)}`,
};

export const legalSourceResource = (source: LegalSourceReference) =>
  resourceReference.source(source.provider, source.provider === "a2aj" ? JSON.stringify([
    source.id, source.kind === "legislation" ? "laws" : "cases",
    source.collection ?? "", source.language ?? "en",
  ]) : JSON.stringify([source.id, source.kind, source.family ?? "", source.part ?? "",
    source.collection === source.provider ? "" : source.collection ?? "", source.language ?? "en"]));

export function parseResourceReference(raw: string): ResourceReference | null {
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.port || url.search || url.hash) {
      return null;
    }
    const scheme = url.protocol.slice(0, -1);
    const host = decodeURIComponent(url.hostname);
    const path = url.pathname === ""
      ? []
      : url.pathname.slice(1).split("/").map(decodeURIComponent);
    if (!host || path.some((part) => !part)) return null;
    if (scheme === "document" && path.length === 2 && path[0] === "version") {
      return { kind: "document", documentId: host, versionId: path[1] };
    }
    if (scheme === "source" && path.length === 1) {
      return { kind: "source", provider: host, sourceId: path[0] };
    }
    if (
      (scheme === "project" || scheme === "workflow") &&
      path.length === 0
    ) {
      return { kind: scheme, id: host };
    }
  } catch {
    // Not a resource reference.
  }
  return null;
}

export const researchSourceKey = (value: ResearchSourceReference) => value.kind === "document"
  ? resourceReference.document(value.id, value.versionId) : legalSourceResource(value);
