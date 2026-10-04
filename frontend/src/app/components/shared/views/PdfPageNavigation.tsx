import { useId, useState } from "react";

function pageRange(start: string, end: string) {
    if (start === end) return start;
    if (/^\d+$/.test(start) && /^\d+$/.test(end) && start.length === end.length && Number(end) > Number(start)) {
        let prefix = 0;
        while (prefix < end.length - 2 && start[prefix] === end[prefix]) prefix++;
        end = end.slice(prefix);
    }
    return `${start}–${end}`;
}
const ROMAN = /^[ivxlcdm]+$/i;
/** The printed pages a source bears, as a range per kind: "i–iv, 584–625". */
function printedRanges(known: readonly string[]) {
    const roman = known.filter(label => ROMAN.test(label));
    const numbers = known.filter(label => /^\d+$/.test(label)).sort((a, b) => Number(a) - Number(b));
    const other = known.filter(label => !ROMAN.test(label) && !/^\d+$/.test(label));
    return [roman.length ? pageRange(roman[0], roman.at(-1)!) : "",
        numbers.length ? pageRange(numbers[0], numbers.at(-1)!) : "",
        other.length ? pageRange(other[0], other.at(-1)!) : ""].filter(Boolean).join(", ");
}

/** Labels are indexed by physical PDF page; repeated and missing labels are valid. */
export function PdfPageNavigation({ page, count, labels, disabled, onNavigate }: {
    page: number; count: number; labels?: readonly (string | null)[];
    disabled: boolean; onNavigate: (page: number) => void;
}) {
    const id = useId();
    const known = labels?.map(label => label?.trim()).filter((label): label is string => !!label) ?? [];
    // Each field shows the current page; what the reader types replaces it until Enter, Escape or leaving the field.
    const [pdfDraft, setPdfDraft] = useState<string | null>(null);
    const [printedDraft, setPrintedDraft] = useState<string | null>(null);
    const pdfInput = pdfDraft ?? String(page);
    const printed = labels?.[page - 1]?.trim() ?? "", printedInput = printedDraft ?? printed;
    // The printed field is there whenever the source prints its own page numbers, on every page, a cover
    // or front matter included (empty there); a source whose labels are its PDF numbers has none.
    const showPrinted = !!labels?.some((label, index) => !!label?.trim() && label.trim() !== String(index + 1));
    const [error, setError] = useState<{ kind: "pdf" | "printed"; text: string } | null>(null);
    // A new page or a new document drops what was being typed.
    const [previous, setPrevious] = useState({ page, labels });
    if (previous.page !== page || previous.labels !== labels) {
        setPrevious({ page, labels }); setPdfDraft(null); setPrintedDraft(null); setError(null);
    }
    const printedRange = printedRanges(known);
    function jump(kind: "pdf" | "printed") {
        if (disabled) return;
        setError(null);
        if (kind === "pdf") {
            const number = Number(pdfInput);
            if (!Number.isSafeInteger(number) || number < 1 || number > count) {
                setError({ kind, text: `Enter a PDF page from 1 to ${count}.` }); return;
            }
            setPdfDraft(null); onNavigate(number);
            return;
        }
        const value = printedInput.trim().toLowerCase();
        const found = value ? Array.from({ length: count }, (_, i) => i + 1)
            .filter(number => labels?.[number - 1]?.trim().toLowerCase() === value) : [];
        if (!found.length) { setError({ kind, text: `No page ${printedInput.trim()} · ${printedRange}` }); return; }
        // A label borne by more than one page (two instruments in one PDF): the next one after this page.
        setPrintedDraft(null); onNavigate(found.find(number => number > page) ?? found[0]);
    }
    const pdfRange = pageRange("1", String(count));
    const inputClass = "h-7 rounded border bg-app-surface px-1.5 text-center tabular-nums text-gray-950 placeholder:font-normal placeholder:text-gray-400 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-red-700 disabled:opacity-50";
    const edge = (kind: "pdf" | "printed") => error?.kind === kind ? "border-red-700" : "border-gray-200";
    return <div className="relative min-w-0 text-[0.8125rem] font-medium text-gray-700" onKeyDown={event => {
        // Escape takes back what was typed, and only that: the viewer stays open.
        if (event.key === "Escape" && (error || pdfDraft !== null || printedDraft !== null)) {
            event.stopPropagation(); event.preventDefault();
            setError(null); setPdfDraft(null); setPrintedDraft(null);
        }
    }}>
        <div className="flex flex-wrap items-center gap-x-3 rounded-lg border border-gray-200 bg-white px-2 py-1 shadow-sm">
            <label className="flex items-center gap-1">PDF
                {/* Fixed widths: a four-digit page or an abbreviated range such as 1421–45; printed "ii–iii, 585–625". */}
                <input aria-label={`PDF page, 1 to ${count}`} value={pdfInput} placeholder={pdfRange} inputMode="numeric" disabled={disabled}
                    aria-invalid={error?.kind === "pdf" || undefined} aria-describedby={error?.kind === "pdf" ? id : undefined}
                    className={`${inputClass} ${edge("pdf")} w-[calc(7ch+0.75rem)]`}
                    onChange={event => { setPdfDraft(event.target.value); setError(null); }}
                    onBlur={() => { if (!error) setPdfDraft(null); }}
                    onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); jump("pdf"); } }} />
            </label>
            {showPrinted && <label className="flex items-center gap-1">Printed
                <input aria-label={`Printed page, ${printedRange}`} value={printedInput} placeholder={printedRange} disabled={disabled}
                    aria-invalid={error?.kind === "printed" || undefined} aria-describedby={error?.kind === "printed" ? id : undefined}
                    className={`${inputClass} ${edge("printed")} w-[calc(15ch+0.75rem)]`}
                    onChange={event => { setPrintedDraft(event.target.value); setError(null); }}
                    onBlur={() => { if (!error) setPrintedDraft(null); }}
                    onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); jump("printed"); } }} />
            </label>}
        </div>
        {/* Over the page, so it moves nothing. */}
        {error && <p id={id} role="alert" className="absolute bottom-full left-0 mb-2 w-max max-w-[min(16rem,calc(100vw-2rem))] rounded-lg border border-red-700 bg-white px-2 py-1 text-red-800 shadow-sm">{error.text}</p>}
    </div>;
}
