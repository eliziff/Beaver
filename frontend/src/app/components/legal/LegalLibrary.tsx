"use client";
import { type FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
    ExternalLink,
    LibraryBig,
    Loader2,
    Search,
    Trash2,
} from "lucide-react";
import { PageHeader } from "@/app/components/shared/PageHeader";
import {
    deleteLegalSource,
    getLegalSourceCoverage,
    listLegalLibrary,
    saveLegalSource,
    searchLegalSources,
    type LegalDocumentType,
    type LegalSearchDocumentType,
    type LegalSourceCoverage,
    type LegalSourceReference,
    type LegalSourceSearchResult,
} from "@/app/lib/beaverApi";
import { LegalSourceMarkingPanel } from "./LegalSourceMarkingPanel";
import {
    legalSourceKindLabel,
    LegalSourceViewer,
    type LegalSourceViewerProps,
} from "./LegalSourceViewer";
import { ModalSelect } from "@/app/components/modals/ModalSelect";
import { formatLongDate } from "@/app/lib/utils";

const SOURCE_KINDS = {
    cases: [["court", "Courts"], ["tribunal", "Tribunals and boards"]],
    laws: [["legislation", "Statutes"], ["regulation", "Regulations"]],
    articles: [],
} as const;
const FILTER_LABEL = "min-w-0 text-xs font-medium text-gray-600";
const FILTER_INPUT =
    "mt-1 block h-9 w-full min-w-0 rounded-md border border-gray-300 bg-white px-2 text-sm font-normal text-gray-800";
const DATE_FILTERS = [["from", "From"], ["to", "To"]] as const;
type SourceTab = "all" | LegalSearchDocumentType;
const SOURCE_TABS: Array<[SourceTab, string]> = [
    ["all", "All"],
    ["cases", "Cases"],
    ["laws", "Legislation"],
    ["articles", "Journals"],
    ["hansard", "Hansard"],
];

function errorMessage(reason: unknown, fallback: string) {
    return reason instanceof Error ? reason.message : fallback;
}

function directSourceHref(result: LegalSourceSearchResult) {
    const query = new URLSearchParams({
        provider: result.provider,
        citation: result.citation,
        doc_type: result.doc_type,
        language: "en",
    });
    if (result.dataset) query.set("dataset", result.dataset);
    if (result.source_id) query.set("source_id", result.source_id);
    return `/sources/view?${query}`;
}

function savedSourceKey(source: {
    provider: string;
    citation: string;
    dataset: string | null;
}) {
    return JSON.stringify([source.provider, source.dataset, source.citation]);
}

export function LegalLibraryPage() {
    const router = useRouter();
    const [references, setReferences] = useState<LegalSourceReference[] | null>(
        null,
    );
    const [results, setResults] = useState<LegalSourceSearchResult[]>([]);
    const [coverage, setCoverage] = useState<LegalSourceCoverage[]>([]);
    const [filters, setFilters] = useState({
        docType: "all" as SourceTab,
        jurisdiction: "",
        sourceKind: "",
        dataset: "",
    });
    const [searching, setSearching] = useState(false);
    const [savingCitation, setSavingCitation] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const { docType, jurisdiction, sourceKind, dataset } = filters;
    const updateFilters = (next: Partial<typeof filters>) =>
        setFilters((current) => ({ ...current, ...next }));
    useEffect(() => {
        listLegalLibrary()
            .then(setReferences)
            .catch((reason: unknown) => {
                setReferences([]);
                setError(errorMessage(reason, "Could not load legal sources"));
            });
        getLegalSourceCoverage().then(setCoverage).catch(() => undefined);
    }, []);
    const typeCoverage = coverage.filter((item) => item.docType === docType);
    const jurisdictions = Array.from(
        new Map(
            typeCoverage.map(({ jurisdictionCode, jurisdiction }) => [
                jurisdictionCode,
                jurisdiction,
            ]),
        ),
    ).sort((left, right) => left[1].localeCompare(right[1]));
    const availableSources = typeCoverage.filter(
        (item) =>
            (!jurisdiction || item.jurisdictionCode === jurisdiction) &&
            (!sourceKind || item.sourceKind === sourceKind),
    );
    const selectedDatasets = dataset
        ? [dataset]
        : availableSources.map((item) => item.dataset);
    const savedSources = new Set(references?.map(savedSourceKey));
    async function runSearch(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const query = form.get("query")?.toString().trim() ?? "";
        if (!query) return;
        setSearching(true);
        setError(null);
        try {
            const documentTypes: LegalSearchDocumentType[] =
                docType === "all"
                    ? ["cases", "laws", "articles", "hansard"]
                    : [docType];
            const found = await Promise.all(
                documentTypes.map((type) =>
                    searchLegalSources({
                    query,
                    docType: type,
                    datasets:
                        type === "articles" || docType === "all"
                            ? undefined
                            : selectedDatasets,
                    startDate: form.get("from")?.toString() || undefined,
                    endDate: form.get("to")?.toString() || undefined,
                    sortResults: (form.get("sort")?.toString() || "default") as
                        | "default"
                        | "newest_first"
                        | "oldest_first",
                    }),
                ),
            );
            setResults(found.flat());
        } catch (reason) {
            setError(errorMessage(reason, "Search failed"));
        } finally {
            setSearching(false);
        }
    }
    async function saveResult(result: LegalSourceSearchResult) {
        if (result.doc_type === "hansard") return;
        setSavingCitation(result.citation);
        setError(null);
        try {
            const saved = await saveLegalSource({
                citation: result.citation,
                docType: result.doc_type,
                dataset: result.dataset,
                sourceId: result.source_id,
            });
            setReferences((current) =>
                current?.some((item) => item.id === saved.id)
                    ? current
                    : [...(current ?? []), saved],
            );
        } catch (reason) {
            setError(errorMessage(reason, "Could not save legal source"));
        } finally {
            setSavingCitation(null);
        }
    }
    async function remove(reference: LegalSourceReference) {
        try {
            await deleteLegalSource(reference.id);
            setReferences((current) =>
                (current ?? []).filter((item) => item.id !== reference.id),
            );
        } catch (reason) {
            setError(errorMessage(reason, "Could not remove legal source"));
        }
    }
    return (
        <div className="flex h-full min-h-0 flex-col">
            <PageHeader
                breadcrumbs={[{ label: "Sources" }]}
            />
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
                <div className="mx-auto max-w-5xl space-y-6">
                    <form
                        onSubmit={runSearch}
                        className="rounded-lg border border-gray-200 bg-white p-4"
                    >
                        <div
                            className="mb-3 grid grid-cols-5 rounded-lg bg-gray-100 p-1 sm:inline-grid"
                            aria-label="Source category"
                        >
                            {SOURCE_TABS.map(([value, label]) => (
                                <button
                                    key={value}
                                    type="button"
                                    aria-pressed={docType === value}
                                    onClick={() =>
                                        updateFilters({
                                            docType: value,
                                            jurisdiction: "",
                                            sourceKind: "",
                                            dataset: "",
                                        })
                                    }
                                    className={`h-8 rounded-md px-3 text-sm font-medium transition-colors ${
                                        docType === value
                                            ? "bg-white text-gray-900 shadow-sm"
                                            : "text-gray-600 hover:text-gray-900"
                                    }`}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                        <div className="flex flex-col gap-2 sm:flex-row">
                            <label className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-md border border-gray-300 bg-white px-3 focus-within:border-brand">
                                <Search className="h-4 w-4 shrink-0 text-gray-400" />
                                <span className="sr-only">Search sources</span>
                                <input
                                    name="query"
                                    required
                                    placeholder={
                                        docType === "all"
                                            ? "Search cases, legislation, journals, and Hansard"
                                            : docType === "hansard"
                                              ? "Speaker, subject, or Hansard text"
                                            : docType === "laws"
                                            ? "Statute title, citation, or provision"
                                            : docType === "articles"
                                              ? "Article title, author, journal, or citation"
                                            : "Case name, citation, or legal concept"
                                    }
                                    className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none"
                                />
                            </label>
                            <button
                                type="submit"
                                disabled={searching}
                                className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-brand px-5 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-45"
                            >
                                {searching ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                    <Search className="h-4 w-4" />
                                )}
                                Search
                            </button>
                        </div>
                        {docType !== "all" &&
                            docType !== "articles" &&
                            docType !== "hansard" && (
                            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                                <label
                                    htmlFor="legal-jurisdiction"
                                    className={FILTER_LABEL}
                                >
                                    Jurisdiction
                                    <ModalSelect
                                        id="legal-jurisdiction"
                                        value={jurisdiction}
                                        onChange={(value) =>
                                            updateFilters({
                                                jurisdiction: value,
                                                dataset: "",
                                            })
                                        }
                                        options={[
                                            {
                                                value: "",
                                                label: "All jurisdictions",
                                            },
                                            ...jurisdictions.map(
                                                ([code, name]) => ({
                                                    value: code,
                                                    label: name,
                                                }),
                                            ),
                                        ]}
                                        className="mt-1 !h-9 px-2 font-normal"
                                    />
                                </label>
                                <label className={FILTER_LABEL}>
                                    Source type
                                    <select
                                        value={sourceKind}
                                        onChange={(event) =>
                                            updateFilters({
                                                sourceKind: event.target.value,
                                                dataset: "",
                                            })
                                        }
                                        className={FILTER_INPUT}
                                    >
                                        <option value="">All source types</option>
                                        {SOURCE_KINDS[docType].map(
                                            ([value, label]) => (
                                                <option key={value} value={value}>
                                                    {label}
                                                </option>
                                            ),
                                        )}
                                    </select>
                                </label>
                                <label
                                    htmlFor="legal-dataset"
                                    className={`${FILTER_LABEL} lg:col-span-2`}
                                >
                                    {docType === "cases"
                                        ? "Court or tribunal"
                                        : "Collection"}
                                    <ModalSelect
                                        id="legal-dataset"
                                        value={dataset}
                                        onChange={(value) =>
                                            updateFilters({ dataset: value })
                                        }
                                        options={[
                                            {
                                                value: "",
                                                label:
                                                    docType === "cases"
                                                        ? "All courts and tribunals"
                                                        : "All statutes and regulations",
                                            },
                                            ...availableSources.map((item) => ({
                                                value: item.dataset,
                                                label: item.description,
                                            })),
                                        ]}
                                        className="mt-1 !h-9 px-2 font-normal"
                                    />
                                </label>
                                {DATE_FILTERS.map(([name, label]) => (
                                    <label key={name} className={FILTER_LABEL}>
                                        {label}
                                        <input
                                            type="date"
                                            name={name}
                                            className={FILTER_INPUT}
                                        />
                                    </label>
                                ))}
                                <label className={`${FILTER_LABEL} sm:col-span-2`}>
                                    Sort
                                    <select
                                        name="sort"
                                        defaultValue="default"
                                        className={FILTER_INPUT}
                                    >
                                        <option value="default">
                                            Most relevant
                                        </option>
                                        <option value="newest_first">
                                            Newest first
                                        </option>
                                        <option value="oldest_first">
                                            Oldest first
                                        </option>
                                    </select>
                                </label>
                            </div>
                        )}
                    </form>
                    {error && (
                        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                            {error}
                        </p>
                    )}
                    {results.length > 0 && (
                        <section>
                            <h2 className="mb-2 text-base font-semibold text-gray-900">
                                Search results
                            </h2>
                            <div className="grid gap-2">
                                {results.map((result) => {
                                    const saved = savedSources.has(
                                        savedSourceKey(result),
                                    );
                                    const metadata = [
                                        result.name && result.name !== result.citation
                                            ? result.citation
                                            : null,
                                        result.dataset,
                                        formatLongDate(result.date),
                                    ].filter(Boolean);
                                    return (
                                        <article
                                            key={`${result.provider}:${result.source_id ?? ""}:${result.dataset}:${result.citation}`}
                                            className="rounded-md border border-gray-200 bg-white p-4"
                                        >
                                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                                            <div className="min-w-0 flex-1">
                                                <h3 className="mt-0.5 text-base font-semibold text-gray-900">
                                                    {result.name ||
                                                        result.citation}
                                                </h3>
                                                {!!metadata.length && (
                                                    <p className="mt-1 text-sm leading-5 text-gray-600">
                                                        {metadata.join(" · ")}
                                                    </p>
                                                )}
                                                {result.snippet && (
                                                    <p className="mt-2 line-clamp-3 text-sm leading-6 text-gray-600">
                                                        {result.snippet}
                                                    </p>
                                                )}
                                            </div>
                                            <div className="flex shrink-0 flex-wrap gap-2">
                                                {result.provider !== "hansard" && (
                                                    <Link
                                                        href={directSourceHref(result)}
                                                        className="inline-flex h-8 items-center justify-center rounded-md bg-brand px-3 text-xs font-medium text-white hover:bg-brand-dark"
                                                    >
                                                        View
                                                    </Link>
                                                )}
                                                {result.provider !== "hansard" && (
                                                    <button
                                                    type="button"
                                                    disabled={
                                                        savingCitation ===
                                                            result.citation ||
                                                        saved
                                                    }
                                                    onClick={() =>
                                                        void saveResult(result)
                                                    }
                                                    className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 text-xs font-medium text-gray-800 hover:border-brand disabled:text-gray-400"
                                                >
                                                    {savingCitation ===
                                                    result.citation ? (
                                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                    ) : (
                                                        <LibraryBig className="h-3.5 w-3.5" />
                                                    )}
                                                    {saved ? "Saved" : "Save"}
                                                    </button>
                                                )}
                                                {result.url && (
                                                    <a
                                                        href={result.url}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="inline-flex h-8 items-center justify-center gap-1 rounded-md px-2 text-xs font-medium text-gray-600 underline decoration-gray-300 underline-offset-2 hover:text-brand"
                                                    >
                                                        View original source
                                                        <ExternalLink className="h-3.5 w-3.5" />
                                                    </a>
                                                )}
                                            </div>
                                        </div>
                                        </article>
                                    );
                                })}
                            </div>
                        </section>
                    )}
                    <section>
                        <h2 className="mb-2 text-base font-semibold text-gray-900">
                            Saved sources
                        </h2>
                        {references === null ? (
                            <div className="flex justify-center py-10">
                                <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
                            </div>
                        ) : references.length ? (
                            <div className="overflow-hidden rounded-lg border border-gray-200 bg-white/60">
                                {references.map((reference) => {
                                    const href = `/sources/${reference.id}`;
                                    return (
                                        <div
                                            key={reference.id}
                                            className="flex items-center gap-3 border-b border-gray-100 px-4 py-3 last:border-b-0 hover:bg-brand-soft/50"
                                        >
                                            <LibraryBig className="h-4 w-4 shrink-0 text-brand" />
                                            <Link
                                                href={href}
                                                className="min-w-0 flex-1"
                                            >
                                                <p className="truncate text-sm font-medium text-gray-900">
                                                    {reference.citation}
                                                </p>
                                                <p className="mt-0.5 text-xs text-gray-500">
                                                    {[
                                                        legalSourceKindLabel(
                                                            reference.doc_type,
                                                        ),
                                                        reference.dataset,
                                                    ]
                                                        .filter(Boolean)
                                                        .join(" · ")}
                                                </p>
                                            </Link>
                                            <a
                                                href={href}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="rounded p-1.5 text-gray-400 hover:bg-white hover:text-brand"
                                                aria-label={`Open ${reference.citation} in a new tab`}
                                                title="Open in new tab"
                                            >
                                                <ExternalLink className="h-4 w-4" />
                                            </a>
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    void remove(reference)
                                                }
                                                className="rounded p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-700"
                                                aria-label={`Remove ${reference.citation} from Sources`}
                                                title="Remove from Sources"
                                            >
                                                <Trash2 className="h-4 w-4" />
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        ) : (
                            <p className="rounded-lg border border-dashed border-gray-200 py-10 text-center text-sm text-gray-500">
                                Search above to add a legal source.
                            </p>
                        )}
                    </section>
                </div>
            </div>
        </div>
    );
}
export function LegalLibrarySourcePage({
    markingId,
    ...viewerProps
}: LegalSourceViewerProps & { markingId?: string }) {
    const router = useRouter();
    const [markingOpen, setMarkingOpen] = useState(false);
    return (
        <div className="flex h-full min-h-0 flex-col">
            <PageHeader
                breadcrumbs={[
                    {
                        label: "Sources",
                        onClick: () => router.push("/sources"),
                    },
                    { label: "Source" },
                ]}
                actions={
                    markingId
                        ? [
                              {
                                  label: markingOpen ? "Close" : "Mark",
                                  title: markingOpen
                                      ? "Close source marks"
                                      : "Mark source",
                                  onClick: () =>
                                      setMarkingOpen((open) => !open),
                              },
                          ]
                        : undefined
                }
            />
            <div className="relative flex min-h-0 flex-1">
                <div className="min-h-0 min-w-0 flex-1">
                    <LegalSourceViewer {...viewerProps} />
                </div>
                {markingId && markingOpen && (
                    <aside
                        aria-label="Project source marks"
                        className="absolute inset-y-0 right-0 z-10 w-full max-w-sm overflow-y-auto border-l border-gray-200 bg-gray-50 p-3 md:static md:z-0 md:w-80 md:max-w-none"
                    >
                        <LegalSourceMarkingPanel sourceId={markingId} />
                    </aside>
                )}
            </div>
        </div>
    );
}
