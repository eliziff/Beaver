import { useState, type ReactNode } from "react";
import { Check, Minus, Quote, RectangleHorizontal, Rows3 } from "lucide-react";

export type CitationQuoteHeaderItem = {
    id: string;
    quote: string;
    eyebrow?: string | null;
    inlineDetail?: string | null;
    detail?: string | null;
    citationText?: string | null;
};
const QUOTE_CARD_SURFACE = "rounded-2xl bg-gray-100";
const VIEW_OPTIONS = [
    ["closed", "Minimize", Minus],
    ["single", "Single quote", RectangleHorizontal],
    ["list", "Quote list", Rows3],
] as const;
type ViewMode = (typeof VIEW_OPTIONS)[number][0];

interface Props {
    quotes: CitationQuoteHeaderItem[];
    error?: string | null;
    isLoading?: boolean;
    activeQuoteId?: string | null;
    currentIndex?: number;
    citationRef?: number;
    citationText?: string;
    onSelect?: (quote: CitationQuoteHeaderItem, index: number) => void;
    onIndexChange?: (index: number) => void;
}

export function CitationQuotesHeader({
    quotes,
    error = null,
    isLoading = false,
    activeQuoteId = null,
    currentIndex = 0,
    citationRef,
    citationText,
    onSelect,
    onIndexChange,
}: Props) {
    const [viewMode, setViewMode] = useState<ViewMode>("single");
    const [isCopied, setIsCopied] = useState(false);
    const [localIndex, setLocalIndex] = useState(currentIndex);
    const selectedIndex = onIndexChange ? currentIndex : localIndex;
    const hasMultipleQuotes = quotes.length > 1;
    const currentQuote = quotes[selectedIndex];
    const visibleMode =
        !hasMultipleQuotes && viewMode === "list" ? "single" : viewMode;
    const visibleQuotes =
        visibleMode === "list"
              ? quotes.map((quote, index) => ({ quote, index }))
              : currentQuote
              ? [{ quote: currentQuote, index: selectedIndex }]
              : [];

    async function copyCitation() {
        if (!currentQuote) return;
        try {
            const text =
                `"${currentQuote.quote.replace(/"/g, "'")}" ${currentQuote.citationText ?? citationText ?? ""}`.trim();
            await navigator.clipboard.writeText(text);
            setIsCopied(true);
            setTimeout(() => setIsCopied(false), 2000);
        } catch (error) {
            console.error("Failed to copy citation:", error);
        }
    }
    return (
        <div className="px-3">
            <div className="rounded-2xl border border-gray-200 bg-white shadow-sm">
                <div className="flex h-10 items-center justify-between px-2">
                    <p className="flex items-center gap-1.5 text-xs font-medium text-gray-700">
                        <span>Citation</span>
                        {typeof citationRef === "number" && (
                            <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-gray-200 px-1 text-[9px] font-medium text-gray-600">
                                {citationRef}
                            </span>
                        )}
                    </p>
                    <div className="flex items-center gap-2">
                        {hasMultipleQuotes && (
                            <div className="flex items-center gap-1">
                                <span className="mr-0.5 text-xs font-medium text-gray-500">
                                    Quotes
                                </span>
                                {quotes.map((quote, index) => (
                                    <button
                                        key={quote.id}
                                        type="button"
                                        aria-label={`Quote ${index + 1}`}
                                        aria-pressed={selectedIndex === index}
                                        onClick={() => {
                                            if (onIndexChange) onIndexChange(index);
                                            else setLocalIndex(index);
                                        }}
                                        className={`flex h-4 w-4 items-center justify-center rounded-full text-[9px] ${
                                            selectedIndex === index
                                                ? "bg-white font-medium text-gray-800 shadow-[0_1px_3px_rgba(0,0,0,0.22)]"
                                                : "bg-gray-200 text-gray-500 hover:bg-gray-300 hover:text-gray-700"
                                        }`}
                                    >
                                        {index + 1}
                                    </button>
                                ))}
                            </div>
                        )}
                        {currentQuote && (
                            <button
                                type="button"
                                aria-label="Copy quote and citation"
                                onClick={(event) => {
                                    event.stopPropagation();
                                    event.preventDefault();
                                    void copyCitation();
                                }}
                                className="flex h-6 items-center gap-1 rounded-full bg-white px-2 text-gray-600 shadow-[0_1px_3px_rgba(0,0,0,0.22)] hover:bg-gray-50"
                                title="Copy Quote and Citation"
                            >
                                {isCopied ? (
                                    <Check className="h-3 w-3 text-green-600" />
                                ) : (
                                    <Quote className="h-3 w-3" />
                                )}
                                <span
                                    className={`text-[10px] font-medium ${isCopied ? "text-green-600" : ""}`}
                                >
                                    {isCopied ? "Copied" : "Cite"}
                                </span>
                            </button>
                        )}
                        <div
                            className={`flex h-6 items-center gap-1 rounded-full bg-gray-200 p-1 ${
                                hasMultipleQuotes ? "w-16" : "w-11"
                            }`}
                        >
                            {VIEW_OPTIONS.slice(
                                0,
                                hasMultipleQuotes ? 3 : 2,
                            ).map(([mode, title, Icon]) => (
                                <button
                                    key={mode}
                                    type="button"
                                    onClick={() => setViewMode(mode)}
                                    className={`flex h-4 w-4 items-center justify-center rounded-full ${
                                        visibleMode === mode
                                            ? "bg-white text-gray-800 shadow-sm"
                                            : "text-gray-500 hover:text-gray-700"
                                    }`}
                                    title={title}
                                >
                                    <Icon className="h-3 w-3" />
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
                {visibleMode !== "closed" && (
                    <div className="px-2 pb-2">
                        {isLoading ? (
                            <div className={`px-3 py-2.5 ${QUOTE_CARD_SURFACE}`}>
                                <div className="h-3 w-28 rounded bg-gray-200" />
                                <div className="mt-2.5 h-3 w-full rounded bg-gray-200" />
                                <div className="mt-2 h-3 w-11/12 rounded bg-gray-200" />
                                <div className="mt-2 h-3 w-2/3 rounded bg-gray-200" />
                            </div>
                        ) : error ? (
                            <RelevantQuoteMessage tone="error">
                                {error}
                            </RelevantQuoteMessage>
                        ) : quotes.length > 0 ? (
                            visibleQuotes.length ? (
                                <div
                                    className={
                                        visibleMode === "list"
                                            ? "space-y-2"
                                            : "flex flex-col gap-2"
                                    }
                                >
                                    {visibleQuotes.map(({ quote, index }) => (
                                        <QuoteItem
                                            key={quote.id}
                                            quote={quote}
                                            isActive={
                                                activeQuoteId === quote.id
                                            }
                                            onClick={() =>
                                                onSelect?.(quote, index)
                                            }
                                        />
                                    ))}
                                </div>
                            ) : null
                        ) : (
                            <RelevantQuoteMessage>
                                No relevant quotes.
                            </RelevantQuoteMessage>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
function RelevantQuoteMessage({
    children,
    tone = "neutral",
}: {
    children: ReactNode;
    tone?: "neutral" | "error";
}) {
    return (
        <div className={`px-3 py-2.5 ${QUOTE_CARD_SURFACE}`}>
            <p
                className={`font-serif text-sm leading-6 ${
                    tone === "error" ? "text-red-700" : "text-gray-600"
                }`}
            >
                {children}
            </p>
        </div>
    );
}
function QuoteItem({
    quote,
    isActive,
    onClick,
}: {
    quote: CitationQuoteHeaderItem;
    isActive: boolean;
    onClick: () => void;
}) {
    const metaTone = isActive ? "text-red-900" : "text-gray-500";
    return (
        <button
            type="button"
            onClick={onClick}
            className={`w-full rounded-xl px-3 py-2.5 text-left ${
                isActive ? "bg-red-50" : "bg-gray-100 hover:bg-gray-200/70"
            }`}
        >
            <div className="flex flex-col gap-1.5">
                {quote.eyebrow && (
                    <p className={`font-serif text-xs ${metaTone}`}>
                        {quote.eyebrow}
                    </p>
                )}
                <p
                    className={`font-serif text-sm leading-6 ${
                        isActive ? "text-red-950" : "text-gray-700"
                    }`}
                >
                    &ldquo;{quote.quote.replace(/"/g, "'")}&rdquo;
                    {quote.inlineDetail && (
                        <span className={`text-sm ${metaTone}`}>
                            {" "}
                            ({quote.inlineDetail})
                        </span>
                    )}
                </p>
                {quote.detail && (
                    <p className={`font-serif text-xs ${metaTone}`}>
                        {quote.detail}
                    </p>
                )}
            </div>
        </button>
    );
}
