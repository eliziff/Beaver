import { Loader2, Scale } from "lucide-react";
import { FileTypeIcon } from "../../shared/FileTypeIcon";
import { displayCitationQuote, formatCitationPage } from "../../shared/types";
import type { Citation } from "../../shared/types";
import { RESPONSE_GLASS_ANNOTATION, RESPONSE_GLASS_SURFACE } from "./messageStyles";
type CitationSourceRow = {
    key: string;
    label: string;
    source: Citation;
    entries: Citation[];
};
function citationSourceKey(annotation: Citation): string {
    if (annotation.kind === "case") {
        return `case:${annotation.cluster_id}`;
    }
    if (annotation.kind === "a2aj") {
        return `a2aj:${annotation.url ?? annotation.citation ?? annotation.ref}`;
    }
    if (annotation.kind === "public_legal") {
        return `public:${annotation.provider}:${annotation.identifier}`;
    }
    return `document:${annotation.document_id}`;
}
function citationSourceLabel(annotation: Citation): string {
    if (annotation.kind === "case") {
        const caseName = annotation.case_name?.trim();
        const citation = annotation.citation?.trim();
        if (caseName && citation) return `${caseName}, ${citation}`;
        return caseName || citation || `Case ${annotation.cluster_id}`;
    }
    if (annotation.kind === "a2aj") {
        return annotation.name || annotation.citation || "A2AJ source";
    }
    if (annotation.kind === "public_legal") {
        return annotation.title || annotation.identifier;
    }
    return annotation.filename;
}
export function citationTooltip(annotation: Citation): string {
    const locator = formatCitationPage(annotation);
    const quote = displayCitationQuote(annotation);
    return locator ? `${locator}: "${quote}"` : `"${quote}"`;
}
function CitationSourceIcon({
    annotation,
}: {
    annotation: Citation;
}) {
    if (
        annotation.kind === "case" ||
        annotation.kind === "a2aj" ||
        annotation.kind === "public_legal"
    ) {
        return <Scale className="h-3.5 w-3.5 text-slate-600" />;
    }
    return (
        <FileTypeIcon fileType={annotation.filename} className="h-3.5 w-3.5" />
    );
}
function buildCitationSourceRows(
    citations: Citation[],
): CitationSourceRow[] {
    const rows = new Map<string, CitationSourceRow>();
    citations.forEach((annotation) => {
        const key = citationSourceKey(annotation);
        const existing = rows.get(key);
        if (existing) {
            existing.entries.push(annotation);
            return;
        }
        rows.set(key, {
            key,
            label: citationSourceLabel(annotation),
            source: annotation,
            entries: [annotation],
        });
    });
    return Array.from(rows.values());
}
function escapeHtmlText(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
function ensureTerminalPeriod(value: string): string {
    return /[.!?]$/.test(value.trim()) ? value.trim() : `${value.trim()}.`;
}
export function buildCitationAppendix(citations: Citation[]) {
    if (citations.length === 0) return { html: "", text: "" };
    let previousSourceKey: string | null = null;
    const text = ["", "Citations"];
    const html = ['<section class="copied-citations">', "<h3>Citations</h3>"];
    for (const annotation of citations) {
        const sourceKey = citationSourceKey(annotation);
        const label = ensureTerminalPeriod(
            sourceKey === previousSourceKey
                ? "Id."
                : citationSourceLabel(annotation),
        );
        previousSourceKey = sourceKey;
        const quote = displayCitationQuote(annotation).trim();
        text.push(`${annotation.ref} ${label}${quote ? ` "${quote}"` : ""}`);
        html.push(
            `<p><sup>${annotation.ref}</sup> ${escapeHtmlText(label)}${
                quote ? ` &quot;${escapeHtmlText(quote)}&quot;` : ""
            }</p>`,
        );
    }
    html.push("</section>");
    return { html: html.join(""), text: text.join("\n") };
}
export function CitationsBlock({
    citations,
    onCitationClick,
    onOpenSource,
    canOpenSource,
    showWhenEmpty = false,
    isLoading = false,
}: {
    citations: Citation[];
    onCitationClick?: (citation: Citation) => void;
    onOpenSource?: (citation: Citation) => void;
    canOpenSource?: (citation: Citation) => boolean;
    showWhenEmpty?: boolean;
    isLoading?: boolean;
}) {
    const rows = buildCitationSourceRows(citations);
    if (rows.length === 0 && !showWhenEmpty) return null;
    return (
        <div className="mt-2 mb-3">
            <div className={`overflow-hidden ${RESPONSE_GLASS_SURFACE}`}>
                <div className="flex items-center justify-between gap-3 bg-white/25 px-3 py-2">
                    <h3 className="text-base font-serif text-gray-900">
                        Citations
                    </h3>
                    {isLoading && (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />
                    )}
                </div>
                <div>
                    {rows.map((row) => {
                        const sourceIsClickable =
                            !!onOpenSource &&
                            (canOpenSource?.(row.source) ?? true);
                        return (
                            <div
                                key={row.key}
                                className="flex items-center gap-3 px-3 py-3"
                            >
                                <button
                                    type="button"
                                    onClick={() => onOpenSource?.(row.source)}
                                    disabled={!sourceIsClickable}
                                    className="flex min-w-0 flex-1 items-center gap-2 rounded-lg text-left text-sm font-serif text-gray-700 enabled:hover:text-gray-950 disabled:cursor-default"
                                >
                                    <CitationSourceIcon
                                        annotation={row.source}
                                    />
                                    <span className="truncate">
                                        {row.label}
                                    </span>
                                </button>
                                <div className="flex shrink-0 flex-wrap justify-end gap-1">
                                    {row.entries.map(
                                        (annotation, index) => (
                                            <button
                                                key={`${row.key}:${index}`}
                                                type="button"
                                                onClick={() =>
                                                    onCitationClick?.(
                                                        annotation,
                                                    )
                                                }
                                                className={
                                                    RESPONSE_GLASS_ANNOTATION
                                                }
                                                title={citationTooltip(
                                                    annotation,
                                                )}
                                            >
                                                {annotation.ref}
                                            </button>
                                        ),
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
