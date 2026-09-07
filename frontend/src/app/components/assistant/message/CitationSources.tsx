import {
  citationPinpoint,
  displayCitationQuote,
  formatCitationPage,
  type Citation,
} from "@/app/lib/citations";

function caseName(annotation: Citation): string | null {
    if (annotation.kind === "a2aj" && annotation.source_class === "case")
        return annotation.name?.trim() || null;
    if (
        annotation.kind === "public_legal" &&
        annotation.source_class === "case"
    )
        return annotation.title?.trim() || null;
    return null;
}

function shortCaseName(value: string): string {
    const parties = value.split(/\s+v(?:\.|ersus)?\s+/iu);
    if (parties.length < 2) return value;
    const left = parties[0].replace(/[,.;]+$/u, "").trim();
    const right = parties[1].replace(/[,.;].*$/u, "").trim();
    return /^(?:R|The (?:King|Queen|Crown)|United States|State)$/iu.test(left)
        ? right || left
        : left;
}
function citationSourceLabel(annotation: Citation, sourceOnly = false): string {
    const authority = annotation.authority?.trim();
    // A repeat cite is a short form carrying the new pinpoint, never the full
    // citation again: "Grant at para 44" after "R. v. Grant, 2009 SCC 32".
    if (!sourceOnly && annotation.short_form) {
        const style = caseName(annotation);
        return style ? shortCaseName(style) : annotation.short_authority?.trim() || authority || "";
    }
    if (!sourceOnly && authority) return authority;
    if (annotation.kind === "a2aj") {
        const name = annotation.name?.trim();
        const citation = annotation.citation?.trim();
        if (name && citation && name.toLowerCase() !== citation.toLowerCase())
            return `${name}, ${citation}`;
        return name || citation || authority || "A2AJ source";
    }
    if (annotation.kind === "public_legal") {
        const title = annotation.title?.trim();
        const citation = annotation.citation?.trim();
        if (title && citation && title.toLowerCase() !== citation.toLowerCase())
            return `${title}, ${citation}`;
        return title || citation || authority || annotation.identifier;
    }
    if (annotation.kind === "tabular")
        return `${annotation.col_name} · ${annotation.doc_name}`;
    return annotation.filename;
}
function citationPillLabel(annotation: Citation, sourceOnly = false): string {
    const source = citationSourceLabel(annotation, sourceOnly);
    if (sourceOnly) return source;
    const pinpoint = citationPinpoint(annotation);
    if (!pinpoint || source.toLowerCase().includes(pinpoint.toLowerCase()))
        return source;
    const separator = annotation.locator_separator ??
        ("locator_kind" in annotation && annotation.locator_kind === "paragraph"
            ? " at "
            : ", ");
    return `${source}${separator}${pinpoint}`;
}

export function citationPillParts(annotation: Citation, sourceOnly = false): {
    styleOfCause: string | null;
    rest: string;
} {
    const label = citationPillLabel(annotation, sourceOnly);
    const full = caseName(annotation);
    const style = full && !sourceOnly && annotation.short_form ? shortCaseName(full) : full;
    if (!style) return { styleOfCause: null, rest: label };
    return {
        styleOfCause: style,
        rest: label.startsWith(style) ? label.slice(style.length) : `, ${label}`,
    };
}
export function citationTooltip(annotation: Citation): string {
    const locator = citationPillLabel(annotation) || formatCitationPage(annotation);
    const full = displayCitationQuote(annotation).replace(/\s+/gu, " ").trim();
    const quote = full.length > 200 ? `${full.slice(0, 200)}…` : full;
    return quote ? locator ? `${locator}: "${quote}"` : `"${quote}"` : locator;
}
