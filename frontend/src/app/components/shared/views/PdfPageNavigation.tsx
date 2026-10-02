import { useId, useRef, useState } from "react";

/** Labels are indexed by physical PDF page; repeated and missing labels are valid. */
export function PdfPageNavigation({ page, count, labels, disabled, onNavigate }: {
    page: number; count: number; labels?: readonly (string | null)[];
    disabled: boolean; onNavigate: (page: number) => void;
}) {
    const id = useId();
    const printedRef = useRef<HTMLInputElement>(null);
    const known = labels?.map(label => label?.trim()).filter(Boolean) ?? [];
    const hasUnknownLabels = Array.from({ length: count }, (_, i) => !labels?.[i]?.trim()).some(Boolean);
    // Each field shows the current page; what the reader types replaces it until Enter, Escape or leaving the field.
    const [pdfDraft, setPdfDraft] = useState<string | null>(null);
    const [printedDraft, setPrintedDraft] = useState<string | null>(null);
    const pdfInput = pdfDraft ?? String(page);
    const printedInput = printedDraft ?? (labels?.[page - 1]?.trim() ?? "");
    const [matches, setMatches] = useState<number[]>([]);
    const [error, setError] = useState("");
    // A new page or a new document drops what was being typed or chosen.
    const [previous, setPrevious] = useState({ page, labels });
    if (previous.page !== page || previous.labels !== labels) {
        setPrevious({ page, labels }); setPdfDraft(null); setPrintedDraft(null);
        setMatches([]); setError("");
    }
    function jump(kind: "pdf" | "printed") {
        if (disabled) return;
        setError(""); setMatches([]);
        if (kind === "pdf") {
            const number = Number(pdfInput);
            if (!Number.isSafeInteger(number) || number < 1 || number > count) {
                setError(`Enter a PDF page from 1 to ${count}.`); return;
            }
            setPdfDraft(null); onNavigate(number);
        } else {
            const value = printedInput.trim();
            const found = value ? Array.from({ length: count }, (_, i) => i + 1)
                .filter(number => labels?.[number - 1]?.trim() === value) : [];
            if (!found.length) setError("No known printed page matches. Try a PDF page number.");
            else if (found.length === 1 && !hasUnknownLabels) { setPrintedDraft(null); onNavigate(found[0]); }
            else setMatches(found);
        }
    }
    // An emptied field shows its page range as a faint placeholder; the width fits that range so it never shifts.
    const pdfRange = `1–${count}`, printedRange = `${known[0]}–${known.at(-1)}`;
    const inputClass = "h-7 rounded border border-gray-200 px-1.5 text-end tabular-nums text-gray-950 placeholder:font-normal placeholder:text-gray-400 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-red-700 disabled:opacity-50";
    const width = (range: string) => ({ width: `calc(${range.length + 1}ch + 0.75rem)` });
    return <div className="relative min-w-0 text-[0.8125rem] font-medium text-gray-700" onKeyDown={event => {
        if (event.key === "Escape") {
            if (matches.length) printedRef.current?.focus();
            setMatches([]); setError(""); setPdfDraft(null); setPrintedDraft(null);
        }
    }}>
        <div className="flex flex-wrap items-center gap-x-3 rounded-lg border border-gray-200 bg-white px-2 py-1 shadow-sm">
            <label className="flex items-center gap-1">PDF
                <input aria-label={`PDF page, 1 to ${count}`} value={pdfInput} placeholder={pdfRange} inputMode="numeric" disabled={disabled}
                    aria-describedby={error ? id : undefined} className={inputClass} style={width(pdfRange)}
                    onChange={event => { setPdfDraft(event.target.value); setError(""); setMatches([]); }}
                    onBlur={() => { if (!error) setPdfDraft(null); }}
                    onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); jump("pdf"); } }} />
            </label>
            {known.length > 0 && <label className="flex items-center gap-1">Printed
                <input ref={printedRef} aria-label={`Printed page, ${known[0]} to ${known.at(-1)}`} value={printedInput} placeholder={printedRange} disabled={disabled}
                    aria-describedby={error ? id : undefined} className={inputClass} style={width(printedRange)}
                    onChange={event => { setPrintedDraft(event.target.value); setError(""); setMatches([]); }}
                    onBlur={() => { if (!error && !matches.length) setPrintedDraft(null); }}
                    onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); jump("printed"); } }} />
            </label>}
        </div>
        {(error || matches.length > 0) && <div className="absolute bottom-full left-0 mb-2 max-h-48 w-[min(16rem,calc(100vw-2rem))] overflow-auto rounded-lg border border-gray-200 bg-white p-2 text-gray-900 shadow-sm">
            {error ? <p id={id} role="alert">{error}</p> : <div role="group" aria-label={`PDF pages matching printed ${printedInput.trim()}`}>
                <p role="status" className="px-2 py-1">Choose a PDF page for printed {printedInput.trim()}</p>
                {hasUnknownLabels &&
                    <p className="px-2 pb-1 text-gray-600">Other occurrences may be undetected.</p>}
                {matches.map(number => <button key={number} type="button" disabled={disabled}
                    className="block min-h-8 w-full rounded px-2 text-left hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-red-700"
                    onClick={() => { setMatches([]); setPrintedDraft(null); onNavigate(number); printedRef.current?.focus(); }}>
                    PDF {number}
                </button>)}
            </div>}
        </div>}
    </div>;
}
