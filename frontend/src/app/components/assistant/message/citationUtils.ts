import { citationPinpoint, type Citation } from "@/app/lib/citations";

// Citation groups are inline: consuming a newline can join two table rows.
export const CITATION_MARKERS = /(?<!\\)\[(?:\d+(?:,[ \t]*\d+)*)\](?:[ \t]*\[(?:\d+(?:,[ \t]*\d+)*)\])*(?!\()/gu;

export function citationSourceKey(annotation: Citation): string {
    if (annotation.kind === "a2aj") {
        const identity = annotation.citation?.trim().toLocaleLowerCase();
        return `a2aj:${identity || annotation.url?.split("#", 1)[0] || annotation.ref}`;
    }
    if (annotation.kind === "public_legal")
        return `public:${annotation.provider}:${annotation.identifier}`;
    if (annotation.kind === "tabular")
        return `tabular:${annotation.review_id}:${annotation.col_index}:${annotation.row_index}`;
    return `document:${annotation.document_id}:${annotation.version_id ?? ""}`;
}

export function uniqueCitations(citations: Citation[]): Citation[] {
    return [...new Map(citations.map((citation) => [
        `${citationSourceKey(citation)}:${citationPinpoint(citation)}`, citation,
    ])).values()];
}

export function preprocessCitations(
    text: string,
    citations: Map<number, Citation>,
    inlineCitationTargets: Citation[],
): string {
    return text.replace(CITATION_MARKERS, (full) => {
        const selected = (full.match(/\d+/g) ?? [])
            .flatMap((ref) => citations.get(Number(ref)) ?? []);
        const tokens = uniqueCitations(selected).map((citation) => {
            const idx = inlineCitationTargets.length;
            inlineCitationTargets.push(citation);
            return [`\`§${idx}§\`\u200B`];
        });
        return tokens.length > 0 ? tokens.join("") : full;
    });
}
