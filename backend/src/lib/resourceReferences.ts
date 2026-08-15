export type ResourceReference =
  | { kind: "document"; documentId: string; versionId: string }
  | { kind: "source"; provider: string; sourceId: string }
  | { kind: "project" | "workflow" | "job"; id: string };

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
  job: (id: string) => `job://${segment(id)}`,
};

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
      (scheme === "project" || scheme === "workflow" || scheme === "job") &&
      path.length === 0
    ) {
      return { kind: scheme, id: host };
    }
  } catch {
    // Not a resource reference.
  }
  return null;
}
