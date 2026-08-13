import { citationPinpoint, type Citation } from "../../shared/types";

export type CitationHistory = {
    seen: Set<string>;
    previous: string | null;
};

export function citationSourceKey(annotation: Citation): string {
    if (annotation.kind === "case") return `case:${annotation.cluster_id}`;
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

function usesSupra(annotation: Citation): boolean {
    return (
        annotation.kind === "case" ||
        annotation.source_class === "case" ||
        annotation.source_class === "legislation" ||
        annotation.source_class === "commentary" ||
        (annotation.kind === "public_legal" && annotation.provider === "journal")
    );
}

export function preprocessCitations(
    text: string,
    citations: Map<number, Citation>,
    inlineCitationTargets: Citation[],
    history: CitationHistory = { seen: new Set(), previous: null },
): string {
    return text.replace(/\[(\d+(?:,\s*\d+)*)\]/g, (full, refsStr) => {
        const refs = (refsStr as string)
            .split(",")
            .map((s: string) => parseInt(s.trim(), 10));
        const tokens = refs.flatMap((ref: number) => {
            const citation = citations.get(ref);
            if (!citation) return [];
            const sourceKey = citationSourceKey(citation);
            const displayForm =
                sourceKey === history.previous && citationPinpoint(citation)
                    ? "pinpoint"
                    : history.seen.has(sourceKey) && usesSupra(citation)
                      ? "supra"
                      : "full";
            const idx = inlineCitationTargets.length;
            inlineCitationTargets.push({
                ...citation,
                display_form: displayForm,
            });
            history.seen.add(sourceKey);
            history.previous = sourceKey;
            return [`\`§${idx}§\`\u200B`];
        });
        return tokens.length > 0 ? tokens.join("") : full;
    });
}
export function internalCaseHref(
    value: string | number | null | undefined,
): string | null {
    if (typeof value === "number") return `us-case-${value}`;
    if (!value) return null;
    const match = value.match(/^us-case-(\d+)$/);
    return match ? `us-case-${match[1]}` : null;
}
