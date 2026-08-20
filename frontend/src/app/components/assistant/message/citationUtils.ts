import { citationPinpoint, type Citation } from "../../shared/types";

export type CitationHistory = {
    seen: Set<string>;
    previous: string | null;
};

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
            const canUseSupra = citation.source_class === "case" ||
                citation.source_class === "legislation" ||
                citation.source_class === "commentary" ||
                (citation.kind === "public_legal" && citation.provider === "journal");
            const displayForm =
                sourceKey === history.previous && citationPinpoint(citation)
                    ? "pinpoint"
                    : history.seen.has(sourceKey) && canUseSupra
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
