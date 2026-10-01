import { useId, useRef, useState } from "react";

/** Labels are indexed by physical PDF page; repeated and missing labels are valid. */
export function PdfPageNavigation({ page, count, labels, disabled, onNavigate }: {
    page: number; count: number; labels?: readonly (string | null)[];
    disabled: boolean; onNavigate: (page: number) => void;
}) {
    const id = useId();
    const printedRef = useRef<HTMLInputElement>(null);
    const printed = labels?.[page - 1]?.trim() ?? "";
    const known = labels?.map(label => label?.trim()).filter(Boolean) ?? [];
    const hasUnknownLabels = Array.from({ length: count }, (_, i) => !labels?.[i]?.trim()).some(Boolean);
    const [pdfInput, setPdfInput] = useState(String(page));
    const [printedInput, setPrintedInput] = useState(printed);
    const [matches, setMatches] = useState<number[]>([]);
    const [error, setError] = useState("");
    const [previous, setPrevious] = useState({ page, labels });
    if (previous.page !== page || previous.labels !== labels) {
        setPrevious({ page, labels }); setPdfInput(String(page)); setPrintedInput(printed);
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
            onNavigate(number);
        } else {
            const value = printedInput.trim();
            const found = value ? Array.from({ length: count }, (_, i) => i + 1)
                .filter(number => labels?.[number - 1]?.trim() === value) : [];
            if (!found.length) setError("No known printed page matches. Try a PDF page number.");
            else if (found.length === 1 && !hasUnknownLabels) onNavigate(found[0]);
            else setMatches(found);
        }
    }
    // The range sits inside the field as a faint suffix, so the page and its bounds read as one input.
    const field = "flex h-7 items-center rounded border border-gray-200 pe-1.5 focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-red-700";
    const range = "pointer-events-none select-none font-normal text-gray-400 tabular-nums";
    const inputClass = "h-full w-9 bg-transparent px-1 text-end tabular-nums text-gray-950 outline-none disabled:opacity-50";
    return <div className="relative min-w-0 text-[0.8125rem] font-medium text-gray-700" onKeyDown={event => {
        if (event.key === "Escape") {
            if (matches.length) printedRef.current?.focus();
            setMatches([]); setError(""); setPdfInput(String(page)); setPrintedInput(printed);
        }
    }}>
        <div className="flex items-center gap-x-3">
            <label className="flex items-center gap-1">PDF
                <span className={field}>
                    <input aria-label={`PDF page, 1 to ${count}`} value={pdfInput} inputMode="numeric" disabled={disabled}
                        aria-describedby={error ? id : undefined} className={inputClass}
                        onChange={event => { setPdfInput(event.target.value); setError(""); setMatches([]); }}
                        onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); jump("pdf"); } }} />
                    <span className={range} aria-hidden="true">/ 1–{count}</span>
                </span>
            </label>
            {known.length > 0 && <label className="flex items-center gap-1">Printed
                <span className={field}>
                    <input ref={printedRef} aria-label={`Printed page, ${known[0]} to ${known.at(-1)}`} value={printedInput} placeholder="—" disabled={disabled}
                        aria-describedby={error ? id : undefined} className={`${inputClass} !w-12 placeholder:text-gray-500`}
                        onChange={event => { setPrintedInput(event.target.value); setError(""); setMatches([]); }}
                        onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); jump("printed"); } }} />
                    <span className={range} aria-hidden="true">/ {known[0]}–{known.at(-1)}</span>
                </span>
            </label>}
        </div>
        {(error || matches.length > 0) && <div className="absolute bottom-full left-0 mb-2 max-h-48 w-[min(16rem,calc(100vw-2rem))] overflow-auto rounded-lg border border-gray-200 bg-white p-2 text-gray-900 shadow-sm">
            {error ? <p id={id} role="alert">{error}</p> : <div role="group" aria-label={`PDF pages matching printed ${printedInput.trim()}`}>
                <p role="status" className="px-2 py-1">Choose a PDF page for printed {printedInput.trim()}</p>
                {hasUnknownLabels &&
                    <p className="px-2 pb-1 text-gray-600">Other occurrences may be undetected.</p>}
                {matches.map(number => <button key={number} type="button" disabled={disabled}
                    className="block min-h-8 w-full rounded px-2 text-left hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-red-700"
                    onClick={() => { setMatches([]); onNavigate(number); printedRef.current?.focus(); }}>
                    PDF {number}
                </button>)}
            </div>}
        </div>}
    </div>;
}
