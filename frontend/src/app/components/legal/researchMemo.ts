import type { Citation } from "@/app/lib/citations";
import { type ResearchSourceReference } from "@/app/lib/researchFiles";

export const RESEARCH_PASSAGE_DRAG = "application/x-beaver-research-passage";
export const RESEARCH_PASSAGE_REFERENCE_DRAG = "application/x-beaver-research-passage-reference";
export type MemoSourceReference = { reference: ResearchSourceReference;
  span?: { revision: string; start: number; end: number } };

export function memoCitation(href: string, label?: string): Citation | null {
  if (!href.startsWith("/sources/view?") && !href.startsWith("/library?")) return null;
  const params = new URLSearchParams(href.slice(href.indexOf("?") + 1));
  const provider = params.get("provider") ?? "a2aj";
  const kind = params.get("locator_kind");
  const common: Omit<Extract<Citation, { kind: "a2aj" }>, "kind" | "name"> = { ref: 1, citation: params.get("citation") ?? label,
    authority: params.get("authority") ?? undefined, short_authority: params.get("short_authority") ?? undefined,
    pinpoint: params.get("pinpoint"), locator_separator: params.get("locator_separator") === ", " ? ", " : " at ",
    source_class: params.get("doc_type") === "laws" ? "legislation" as const
      : ["articles", "hansard"].includes(params.get("doc_type") ?? "") ? "commentary" as const : "case" as const,
    ...(kind === "paragraph" || kind === "section" || kind === "page" || kind === "footnote"
      ? { locator_kind: kind, locator: params.get("locator") } : {}), quotes: [] };
  if (href.startsWith("/library?") && params.get("document_id")) return { ...common, kind: "document",
    document_id: params.get("document_id")!, version_id: params.get("version_id"), filename: params.get("title") ?? label ?? "Document",
    quotes: [{ quote: "", ...(kind === "page" ? { page: params.get("locator") ?? undefined } : {}),
      sheet: params.get("sheet") ?? undefined, cell: params.get("cells") ?? undefined }] };
  if (provider === "a2aj") return { ...common, kind: "a2aj", name: params.get("title") };
  if (["courtlistener", "tna", "govuk-et", "govinfo", "hansard", "journal"].includes(provider))
    return { ...common, kind: "public_legal", provider: provider as Extract<Citation, { kind: "public_legal" }>["provider"],
      identifier: params.get("source_id") ?? "", title: params.get("title") };
  return null;
}

export const citationMarkdown = (label: string, href: string) =>
  `[${label.replace(/[\r\n]+/gu, " ").replace(/([\\[\]])/gu, "\\$1")}](${href})`;
