import { type FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
    ExternalLink,
    Loader2,
    Search,
} from "lucide-react";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { WorkProductAssistant } from "@/app/components/assistant/WorkProductAssistant";
import {
    actOnResearchSet,
    createResearchSet,
    deleteWorkProduct,
    duplicateWorkProduct,
    getLegalSourceCoverage,
    getResearchSet,
    listResearchSets,
    runResearchSetQuery,
    searchLegalSources,
    updateWorkProduct,
    type LegalSearchDocumentType,
    type LegalSourceCoverage,
    type LegalSourceSearchResult,
} from "@/app/lib/beaverApi";
import { legalSourceViewerHref, researchSetMetadata, type ResearchSetAction,
    type ResearchSetMetadata, type ResearchSetProduct, type ResearchSetState,
    type ResearchSourceReference } from "@/app/lib/researchSets";
import {
    LegalSourceViewer,
    type LegalSourceViewerProps,
} from "./LegalSourceViewer";
import { ModalSelect } from "@/app/components/modals/ModalSelect";
import { errorMessage, formatLongDate } from "@/app/lib/utils";
import { safeAssistantUrl } from "@/app/lib/safeAssistantUrl";
import { SearchBar } from "@/app/components/ui/search-bar";
import { ResearchSetWorkspace } from "./ResearchSetWorkspace";

const SOURCE_KINDS = {
    cases: [["court", "Courts"], ["tribunal", "Tribunals and boards"]],
    laws: [["legislation", "Statutes"], ["regulation", "Regulations"]],
    articles: [],
} as const;
const FILTER_LABEL = "min-w-0 text-xs font-medium text-gray-600";
const FILTER_INPUT =
    "mt-1 block h-9 w-full min-w-0 rounded-md border border-gray-300 bg-white px-2 text-sm font-normal text-gray-800";
const DATE_FILTERS = [["from", "From year"], ["to", "To year"]] as const;
type SourceTab = "all" | LegalSearchDocumentType;
const SOURCE_TABS: Array<[SourceTab, string]> = [
    ["all", "All"],
    ["cases", "Cases"],
    ["laws", "Legislation"],
    ["articles", "Journals"],
    ["hansard", "Hansard"],
];

const researchReference = (result: LegalSourceSearchResult): ResearchSourceReference => ({
    provider: result.provider, id: result.source_id ?? result.citation,
    kind: result.doc_type === "cases" ? "case" : result.doc_type === "laws"
        ? "legislation" : result.doc_type === "articles" ? "journal" : "hansard",
    title: result.name, citation: result.citation, date: result.date,
    collection: result.dataset, language: "en", url: result.url,
});

function SearchSnippet({ children }: { children: string }) {
    let emphasized = false;
    return children.split(/(<\/?em>)/giu).map((part, index) => {
        if (/^<em>$/iu.test(part)) {
            emphasized = true;
            return null;
        }
        if (/^<\/em>$/iu.test(part)) {
            emphasized = false;
            return null;
        }
        const text = part.replace(/<[^>]*>/gu, "");
        return emphasized ? (
            <mark key={index} className="rounded-sm bg-yellow-100 px-0.5 text-inherit">
                {text}
            </mark>
        ) : text;
    });
}

export function LegalLibraryPage({ embedded = false }: { embedded?: boolean }) {
    const [results, setResults] = useState<LegalSourceSearchResult[]>([]);
    const [searchQuery, setSearchQuery] = useState("");
    const [coverage, setCoverage] = useState<LegalSourceCoverage[]>([]);
    const [filters, setFilters] = useState({
        docType: "all" as SourceTab,
        jurisdiction: "",
        sourceKind: "",
        dataset: "",
    });
    const [searching, setSearching] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [sets, setSets] = useState<ResearchSetMetadata[] | null>(null);
    const [activeSetId, setActiveSetId] = useState<string | null>(null);
    const [activeSet, setActiveSet] = useState<ResearchSetProduct | null>(null);
    const [researchBusy, setResearchBusy] = useState(false);
    const [assistantOpen, setAssistantOpen] = useState(false);
    const [researchChats, setResearchChats] = useState<Record<string, string>>({});
    const { docType, jurisdiction, sourceKind, dataset } = filters;
    const updateFilters = (next: Partial<typeof filters>) =>
        setFilters((current) => ({ ...current, ...next }));
    useEffect(() => {
        getLegalSourceCoverage().then(setCoverage).catch(() => undefined);
        listResearchSets().then((items) => {
            setSets(items); const id = items[0]?.id;
            if (id) { setActiveSetId(id); void getResearchSet(id).then(setActiveSet)
                .catch((reason) => setError(errorMessage(reason, "Could not open saved research"))); }
        }).catch(() => { setSets([]); setActiveSet(null); });
    }, []);

    const replaceSet = (next: ResearchSetProduct) => {
        setSets((current) => [researchSetMetadata(next),
            ...(current ?? []).filter(({ id }) => id !== next.id)]);
        setActiveSet(next); setActiveSetId(next.id);
        return next;
    };
    async function selectSet(id: string) {
        setActiveSetId(id); setActiveSet(null); setResearchBusy(true);
        try { setActiveSet(await getResearchSet(id)); }
        catch (reason) { setError(errorMessage(reason, "Could not open saved research")); }
        finally { setResearchBusy(false); }
    }
    async function createSet() {
        replaceSet(await createResearchSet({ title: "Untitled research" }));
    }
    async function researchAction(action: ResearchSetAction) {
        if (!activeSet) return;
        setResearchBusy(true);
        try { replaceSet(await actOnResearchSet(activeSet.id, activeSet.revision, action)); }
        finally { setResearchBusy(false); }
    }
    async function updateSet(change: { title?: string; projectId?: string | null }) {
        if (!activeSet) return;
        replaceSet(await updateWorkProduct<ResearchSetState>(activeSet.id,
            { revision: activeSet.revision, ...change }));
    }
    async function duplicateSet() {
        if (activeSet) replaceSet(await duplicateWorkProduct<ResearchSetState>(activeSet.id));
    }
    async function deleteSet() {
        if (!activeSet) return;
        await deleteWorkProduct(activeSet.id);
        const next = (sets ?? []).filter(({ id }) => id !== activeSet.id);
        setSets(next); setActiveSetId(next[0]?.id ?? null);
        setActiveSet(next[0] ? await getResearchSet(next[0].id) : null);
    }
    async function saveResult(result: LegalSourceSearchResult) {
        setResearchBusy(true);
        try {
            const destination = activeSet ?? replaceSet(await createResearchSet({ title: "Saved research" }));
            replaceSet(await actOnResearchSet(destination.id, destination.revision, { type: "source",
                reference: researchReference(result) }));
        } finally { setResearchBusy(false); }
    }
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
    const selectedDatasets = dataset ? [dataset] : undefined;
    async function runSearch(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const query = searchQuery.trim();
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
                    author: type === "articles"
                        ? form.get("author")?.toString().trim() || undefined
                        : undefined,
                    journal: type === "articles"
                        ? form.get("journal")?.toString().trim() || undefined
                        : undefined,
                    speaker: type === "hansard"
                        ? form.get("speaker")?.toString().trim() || undefined
                        : undefined,
                    startDate: form.get("from")
                        ? `${form.get("from")}-01-01`
                        : undefined,
                    endDate: form.get("to")
                        ? `${form.get("to")}-12-31`
                        : undefined,
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
    return (
        <div className="relative flex h-full min-w-0">
        <div className="flex min-w-0 flex-1 flex-col">
            {!embedded && <PageHeader breadcrumbs={[{ label: "Sources" }]} />}
            <div
                className={`min-h-0 flex-1 overflow-y-auto ${embedded ? "p-3" : "px-4 py-5 sm:px-6"}`}
            >
                <div className="mx-auto max-w-5xl">
                    <div className="space-y-4">
                    <form
                        onSubmit={runSearch}
                        className="rounded-lg border border-gray-200 bg-white p-4"
                    >
                        <div
                            className="mb-3 flex flex-wrap gap-1 rounded-lg bg-gray-100 p-1 sm:inline-flex"
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
                            <SearchBar name="query" required value={searchQuery}
                                onValueChange={setSearchQuery} booleanSearch
                                aria-label="Search sources"
                                wrapperClassName="h-10 flex-1 focus-within:border-brand"
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
                                    } />
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
                        {docType !== "all" && (
                            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                                {(docType === "cases" || docType === "laws") && <>
                                    <label
                                        htmlFor="legal-jurisdiction"
                                        className={FILTER_LABEL}
                                    >
                                        Jurisdiction
                                        <ModalSelect
                                            id="legal-jurisdiction"
                                            value={jurisdiction}
                                            searchable
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
                                            searchable
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
                                </>}
                                {docType === "articles" && <>
                                    <label className={`${FILTER_LABEL} lg:col-span-2`}>
                                        Author
                                        <input
                                            type="search"
                                            name="author"
                                            placeholder="Any author"
                                            className={FILTER_INPUT}
                                        />
                                    </label>
                                    <label className={`${FILTER_LABEL} lg:col-span-2`}>
                                        Journal
                                        <input
                                            type="search"
                                            name="journal"
                                            placeholder="Any journal or abbreviation"
                                            className={FILTER_INPUT}
                                        />
                                    </label>
                                </>}
                                {docType === "hansard" && (
                                    <label className={`${FILTER_LABEL} sm:col-span-2 lg:col-span-4`}>
                                        Speaker
                                        <input
                                            type="search"
                                            name="speaker"
                                            placeholder="Any speaker"
                                            className={FILTER_INPUT}
                                        />
                                    </label>
                                )}
                                {DATE_FILTERS.map(([name, label]) => (
                                    <label key={name} className={FILTER_LABEL}>
                                        {label}
                                        <input
                                            type="text"
                                            inputMode="numeric"
                                            pattern="[0-9]{4}"
                                            minLength={4}
                                            maxLength={4}
                                            name={name}
                                            placeholder="Any year"
                                            title="Enter a four-digit year"
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
                    <details className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                        <summary className="cursor-pointer text-sm font-semibold text-gray-900">
                            Saved research{sets ? ` · ${sets.length}` : ""}
                        </summary>
                        <div className="mt-3">
                            <ResearchSetWorkspace key={activeSetId ?? "none"} sets={sets} product={activeSet}
                                busy={researchBusy} onSelect={(id) => void selectSet(id)} onCreate={createSet}
                                onRename={(title) => updateSet({ title })} onDuplicate={duplicateSet}
                                onDelete={deleteSet} onAction={researchAction}
                                onMove={(projectId) => updateSet({ projectId })}
                                onQuery={(input) => {
                                    if (!activeSet) return Promise.reject(new Error("Choose a research set"));
                                    return runResearchSetQuery(activeSet.id,
                                        { ...input, revision: activeSet.revision }).then((result) => {
                                            replaceSet(result.product); return result;
                                        });
                                }} onAssistant={() => setAssistantOpen(true)} />
                        </div>
                    </details>
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
                                    const sourceHref = safeAssistantUrl(result.url, {
                                        relative: false,
                                    });
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
                                        <div className={`flex flex-col gap-3 ${embedded ? "" : "sm:flex-row sm:items-start"}`}>
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
                                                        <SearchSnippet>{result.snippet}</SearchSnippet>
                                                    </p>
                                                )}
                                            </div>
                                            <div className="flex shrink-0 flex-wrap gap-2">
                                                {result.provider !== "hansard" && (
                                                    <Link
                                                        to={legalSourceViewerHref(researchReference(result))}
                                                        className="inline-flex h-8 items-center justify-center rounded-md bg-brand px-3 text-xs font-medium text-white hover:bg-brand-dark"
                                                    >
                                                        View
                                                    </Link>
                                                )}
                                                <button type="button" disabled={researchBusy}
                                                    onClick={() => void saveResult(result)}
                                                    className="inline-flex h-8 items-center justify-center rounded-md border border-gray-300 bg-white px-3 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                                                    Save
                                                </button>
                                                {sourceHref && (
                                                    <a
                                                        href={sourceHref}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        aria-label="View original source"
                                                        title="View original source"
                                                        className="inline-flex h-8 items-center justify-center gap-1 rounded-md border border-gray-300 bg-white px-3 text-xs font-medium text-gray-700 hover:border-gray-400 hover:bg-gray-50"
                                                    >
                                                        Site
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
                    </div>
                </div>
            </div>
        </div>
        {assistantOpen && activeSet && <WorkProductAssistant product={activeSet}
            chatId={researchChats[activeSet.id]}
            onChatIdChange={(id) => setResearchChats((current) => ({ ...current,
                [activeSet.id]: id }))}
            onClose={() => setAssistantOpen(false)}
            onTurnComplete={() => void getResearchSet(activeSet.id).then(replaceSet)} />}
        </div>
    );
}

export function LegalLibrarySourcePage({
    ...viewerProps
}: LegalSourceViewerProps) {
    const navigate = useNavigate();
    return (
        <div className="flex h-full min-h-0 flex-col">
            <PageHeader
                breadcrumbs={[
                    {
                        label: "Sources",
                        onClick: () => navigate("/sources"),
                    },
                    { label: "Source" },
                ]}
            />
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <div className="min-h-0 flex-1"><LegalSourceViewer {...viewerProps} /></div>
            </div>
        </div>
    );
}
