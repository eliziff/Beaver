import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
    ExternalLink,
    Loader2,
    PanelsTopLeft,
    Search,
} from "lucide-react";
import { PageHeader } from "@/app/components/shared/PageHeader";
import {
    actOnResearchFile,
    createResearchFile,
    getResearchFile,
    getLegalSourceCoverage,
    searchLegalSources,
    type LegalSearchDocumentType,
    type LegalSourceCoverage,
    type LegalSourceSearchResult,
} from "@/app/lib/beaverApi";
import { legalSourceViewerHref, type ResearchFile,
    type ResearchSourceReference } from "@/app/lib/researchFiles";
import {
    LegalSourceViewer,
    type LegalSourceTab,
    type LegalSourceViewerProps,
} from "./LegalSourceViewer";
import { ModalSelect } from "@/app/components/modals/ModalSelect";
import { errorMessage, formatLongDate } from "@/app/lib/utils";
import { safeAssistantUrl } from "@/app/lib/safeAssistantUrl";
import { SearchBar } from "@/app/components/ui/search-bar";
import { ResearchLabelPicker } from "./ResearchLabelPicker";
import { ResearchWorkspaceHost } from "./ResearchWorkspaceHost";

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

export function LegalLibraryPage({ embedded = false, projectId, onResearchFileChange,
    onOpenSource }: {
    embedded?: boolean; projectId?: string;
    onResearchFileChange?: (file: ResearchFile | null) => void;
    onOpenSource?: (tab: LegalSourceTab) => void;
}) {
    const [params] = useSearchParams();
    const requestedResearchFileId = embedded ? null : params.get("research_file");
    const [results, setResults] = useState<LegalSourceSearchResult[]>([]);
    const [searched, setSearched] = useState(false);
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
    const [researchFile, setResearchFile] = useState<ResearchFile | null>(null);
    const [researchOpen, setResearchOpen] = useState(!!requestedResearchFileId);
    const [researchBusy, setResearchBusy] = useState(false);
    const publishResearchFile = useCallback((file: ResearchFile | null) => {
        setResearchFile(file); onResearchFileChange?.(file);
    }, [onResearchFileChange]);
    const { docType, jurisdiction, sourceKind, dataset } = filters;
    const updateFilters = (next: Partial<typeof filters>) =>
        setFilters((current) => ({ ...current, ...next }));
    useEffect(() => {
        getLegalSourceCoverage().then(setCoverage).catch(() => undefined);
    }, []);
    useEffect(() => {
        if (!requestedResearchFileId) return;
        let current = true;
        void getResearchFile(requestedResearchFileId).then((file) => {
            if (current) publishResearchFile(file);
        }, (reason) => { if (current) setError(errorMessage(reason, "Could not open research file")); });
        return () => { current = false; };
    }, [publishResearchFile, requestedResearchFileId]);
    const sourceIndex = useMemo(() => new Map(Object.values(researchFile?.state.sources ?? {})
        .map((source) => [`${source.reference.provider}\0${source.reference.id}`, source])), [researchFile]);
    const sourceInFile = (result: LegalSourceSearchResult, file = researchFile) => file === researchFile
        ? sourceIndex.get(`${result.provider}\0${result.source_id ?? result.citation}`)
        : file && Object.values(file.state.sources).find(({ reference }) => reference.provider === result.provider &&
            reference.id === (result.source_id ?? result.citation));
    async function saveResult(result: LegalSourceSearchResult, file = researchFile) {
        setResearchBusy(true);
        try {
            const destination = file ?? await createResearchFile({ title: "Research", projectId });
            const next = await actOnResearchFile(destination.document.id, destination.versionId,
                { type: "source", reference: researchReference(result) });
            publishResearchFile(next);
            return { file: next, itemId: sourceInFile(result, next)!.id };
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
        setSearched(false);
        setError(null);
        try {
            const documentTypes: LegalSearchDocumentType[] =
                docType === "all"
                    ? ["cases", "laws", "articles", "hansard"]
                    : [docType];
            const settled = await Promise.allSettled(
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
            const found = settled.flatMap((item) => item.status === "fulfilled" ? item.value : []);
            setResults(found);
            const failed = settled.filter((item) => item.status === "rejected").length;
            if (failed) setError(found.length
                ? `${failed} source ${failed === 1 ? "collection is" : "collections are"} temporarily unavailable.`
                : "Search failed. Source collections are temporarily unavailable.");
        } catch (reason) {
            setError(errorMessage(reason, "Search failed"));
        } finally {
            setSearching(false);
            setSearched(true);
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
                        className="@container rounded-lg border border-gray-200 bg-white p-4"
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
                        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 @min-[42rem]:grid-cols-[minmax(0,1fr)_auto_auto]">
                            <SearchBar name="query" required value={searchQuery}
                                onValueChange={setSearchQuery} booleanSearch
                                aria-label="Search sources"
                                wrapperClassName="col-span-2 min-w-0 @min-[42rem]:col-span-1"
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
                                className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-gray-950 px-4 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-45"
                            >
                                {searching ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                    <Search className="h-4 w-4" />
                                )}
                                Search
                            </button>
                            <button type="button" onClick={() => setResearchOpen(true)}
                                aria-expanded={researchOpen} aria-label="Open research workspace"
                                className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-gray-300 bg-white px-4 text-sm font-medium text-gray-800 hover:bg-gray-50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50">
                                Workspace
                                <PanelsTopLeft className="size-4" aria-hidden="true" />
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
                    {error && (
                        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                            {error}
                        </p>
                    )}
                    {searched && (
                        <section>
                            <h2 className="mb-2 text-base font-semibold text-gray-900">
                                {results.length ? `${results.length} search results` : "No search results"}
                            </h2>
                            {results.length ? <div className="grid gap-2">
                                {results.map((result) => {
                                    const sourceHref = safeAssistantUrl(result.url, {
                                        relative: false,
                                    });
                                    const citation = result.provider === "journal" && result.name
                                        ? result.citation.replace(`“${result.name}”`, "")
                                            .replace(/\s{2,}/gu, " ").trim()
                                        : result.citation;
                                    const metadata = [
                                        result.name && result.name !== citation
                                            ? citation
                                            : null,
                                        result.dataset,
                                        formatLongDate(result.date),
                                    ].filter(Boolean);
                                    const saved = sourceInFile(result);
                                    return (
                                        <article
                                            key={`${result.provider}:${result.source_id ?? ""}:${result.dataset}:${result.citation}`}
                                            className="rounded-md border border-gray-200 bg-white p-4"
                                        >
                                        <div className={`flex flex-col gap-3 ${embedded ? "" : "sm:flex-row sm:items-start"}`}>
                                            <div className="flex min-w-0 flex-1 items-center gap-3">
                                                <ResearchLabelPicker file={researchFile}
                                                    kind="source" itemId={saved?.id}
                                                    labelIds={saved?.labelIds ?? []} badge={saved?.badge} badgeColor={saved?.badgeColor} note={saved?.note}
                                                    title={result.name || result.citation} buttonLabel={saved?.badge}
                                                    disabled={researchBusy} onChange={publishResearchFile}
                                                    prepareFile={researchFile ? undefined : async () => {
                                                        const next = await createResearchFile({ title: "Research", projectId });
                                                        publishResearchFile(next); return next;
                                                    }}
                                                    prepare={saved ? undefined : (file) => saveResult(result, file)} />
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
                                            </div>
                                            <div className="flex shrink-0 flex-wrap gap-2">
                                                {result.provider !== "hansard" && (embedded && onOpenSource
                                                    ? <button type="button" onClick={() => onOpenSource({
                                                        kind: "legal",
                                                        id: `legal:${result.provider}:${result.source_id ?? result.citation}`,
                                                        provider: result.provider === "journal" ? "journal" : "a2aj",
                                                        sourceId: result.source_id,
                                                        citation: result.citation,
                                                        name: result.name,
                                                        dataset: result.dataset,
                                                        docType: result.doc_type === "hansard" ? "auto" : result.doc_type,
                                                        language: "en",
                                                        researchFileId: researchFile?.document.id,
                                                        researchSourceId: saved?.id,
                                                    })} className="inline-flex h-8 items-center justify-center rounded-md bg-brand px-3 text-xs font-medium text-white hover:bg-brand-dark">
                                                        View
                                                    </button>
                                                    : <Link
                                                        to={legalSourceViewerHref(researchReference(result), saved && researchFile
                                                            ? { fileId: researchFile.document.id, sourceId: saved.id } : undefined)}
                                                        className="inline-flex h-8 items-center justify-center rounded-md bg-brand px-3 text-xs font-medium text-white hover:bg-brand-dark"
                                                    >
                                                        View
                                                    </Link>)}
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
                            </div> : <p role="status" className="rounded-md border border-dashed border-gray-300 p-6 text-center text-sm text-gray-600">
                                No sources matched this search. Try fewer terms or a different source category.
                            </p>}
                        </section>
                    )}
                    </div>
                </div>
            </div>
        </div>
        <ResearchWorkspaceHost embedded={embedded} open={researchOpen}
            onOpenChange={setResearchOpen} file={researchFile} projectId={projectId}
            onChange={publishResearchFile} />
        </div>
    );
}

export function LegalLibrarySourcePage({
    ...viewerProps
}: LegalSourceViewerProps) {
    const navigate = useNavigate();
    const [researchFile, setResearchFile] = useState<ResearchFile | null | undefined>();
    const [researchOpen, setResearchOpen] = useState(!!viewerProps.researchFileId);
    return (
        <div className="flex h-full min-h-0 min-w-0">
        <div className="flex min-w-0 flex-1 flex-col">
            <PageHeader
                breadcrumbs={[
                    {
                        label: "Sources",
                        onClick: () => navigate("/sources"),
                    },
                    { label: "Source" },
                ]}
                actions={[{ icon: <PanelsTopLeft className="size-4" aria-hidden="true" />,
                    label: "Workspace", title: "Open research workspace", onClick: () => setResearchOpen(true) }]}
            />
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <div className="min-h-0 flex-1"><LegalSourceViewer {...viewerProps}
                    researchFile={researchFile} onResearchFileChange={setResearchFile}
                    onOpenResearch={() => setResearchOpen(true)} /></div>
            </div>
        </div>
        <ResearchWorkspaceHost embedded={false} open={researchOpen}
            onOpenChange={setResearchOpen} file={researchFile ?? null}
            projectId={viewerProps.projectId} onChange={setResearchFile} />
        </div>
    );
}
