import {
    citationPinpoint,
    displayCitationQuote,
    formatCitationPage,
} from "../../shared/types";
import type { Citation } from "../../shared/types";
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
function citationSourceLabel(annotation: Citation): string {
    if (annotation.authority?.trim()) return annotation.authority.trim();
    if (annotation.kind === "a2aj") {
        const name = annotation.name?.trim();
        const citation = annotation.citation?.trim();
        if (name && citation && name.toLowerCase() !== citation.toLowerCase())
            return `${name}, ${citation}`;
        return name || citation || "A2AJ source";
    }
    if (annotation.kind === "public_legal") {
        const title = annotation.title?.trim();
        const citation = annotation.citation?.trim();
        if (title && citation && title.toLowerCase() !== citation.toLowerCase())
            return `${title}, ${citation}`;
        return title || citation || annotation.identifier;
    }
    if (annotation.kind === "tabular")
        return `${annotation.col_name} · ${annotation.doc_name}`;
    return annotation.filename;
}
function citationPillLabel(annotation: Citation): string {
    const source = citationSourceLabel(annotation);
    const pinpoint = citationPinpoint(annotation);
    if (annotation.display_form === "pinpoint" && pinpoint) return pinpoint;
    if (annotation.display_form === "supra") {
        const style = caseName(annotation);
        const short = annotation.short_authority?.trim() ||
            (style ? shortCaseName(style) : source);
        return `${short}, supra${pinpoint ? ` at ${pinpoint}` : ""}`;
    }
    if (!pinpoint || source.toLowerCase().includes(pinpoint.toLowerCase()))
        return source;
    const separator = annotation.locator_separator ??
        ("locator_kind" in annotation && annotation.locator_kind === "paragraph"
            ? " at "
            : ", ");
    return `${source}${separator}${pinpoint}`;
}

export function citationPillParts(annotation: Citation): {
    styleOfCause: string | null;
    rest: string;
} {
    const label = citationPillLabel(annotation);
    const style = caseName(annotation);
    if (!style || annotation.display_form === "pinpoint")
        return { styleOfCause: null, rest: label };
    const shown = annotation.display_form === "supra" ? shortCaseName(style) : style;
    return {
        styleOfCause: shown,
        rest: label.startsWith(shown) ? label.slice(shown.length) : `, ${label}`,
    };
}
export function citationTooltip(annotation: Citation): string {
    const locator = citationPillLabel(annotation) || formatCitationPage(annotation);
    const quote = displayCitationQuote(annotation);
    return locator ? `${locator}: "${quote}"` : `"${quote}"`;
}
