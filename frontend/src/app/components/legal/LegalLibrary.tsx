import { type FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
    ExternalLink,
    Loader2,
    PanelsTopLeft,
    PanelRightClose,
    Search,
} from "lucide-react";
import { PageHeader } from "@/app/components/shared/PageHeader";
import {
  getLegalSourceCoverage,
  searchLegalSources,
  type LegalSearchDocumentType,
  type LegalSourceCoverage,
  type LegalSourceSearchResult,
} from "@/app/lib/api/legalSources";
import { researchSourceKey, type ResearchFile, type ResearchSource,
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
import { Button } from "@/app/components/ui/button";
import { TabList } from "@/app/components/ui/tabs";
import { ResearchLabelPicker } from "./ResearchLabelPicker";
import { ResearchWorkspaceHost } from "./ResearchWorkspaceHost";
import { SourcesWorkspace, useSourcesWorkspace } from "./SourcesWorkspace";

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
/** Free-text filters that only some source categories carry: name, label, placeholder, grid span. */
const TEXT_FILTERS: Partial<Record<SourceTab, ReadonlyArray<readonly [string, string, string, string]>>> = {
    articles: [["author", "Author", "Any author", "@min-[48rem]:col-span-2"],
        ["journal", "Journal", "Any journal or abbreviation", "@min-[48rem]:col-span-2"]],
    hansard: [["speaker", "Speaker", "Any speaker", "@min-[28rem]:col-span-2 @min-[48rem]:col-span-4"]],
};

function FilterSelect({ id, label, value, allLabel, options, onChange, span }: {
    id: string; label: string; value: string; allLabel: string; span?: string;
    options: { value: string; label: string }[]; onChange: (value: string) => void;
}) {
    return <label htmlFor={id} className={span ? `${FILTER_LABEL} ${span}` : FILTER_LABEL}>
        {label}
        <ModalSelect id={id} value={value} searchable ariaLabel={label} onChange={onChange}
            options={[{ value: "", label: allLabel }, ...options]} className="mt-1 h-9! px-2 font-normal" />
    </label>;
}

const researchReference = (result: LegalSourceSearchResult): ResearchSourceReference => {
    const { snippet: _snippet, authors: _authors, speaker: _speaker,
        passageStart: _passageStart, passageEnd: _passageEnd, authority: _authority, ...reference } = result;
    return reference;
};

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

type LibraryProps = {
    embedded?: boolean; projectId?: string;
    onResearchFileChange?: (file: ResearchFile | null) => void;
    researchRefreshKey?: string | null;
    researchFileId?: string | null;
    onOpenSource?: (tab: LegalSourceTab) => void;
};
export function LegalLibraryPage(props: LibraryProps) {
    const [params, setParams] = useSearchParams();
    const location = useLocation();
    const id = props.researchFileId ?? (props.embedded ? null : params.get("research_file"));
    // The full page keeps the open workspace in the URL so a reload or a shared link lands on it.
    const changed = (file: ResearchFile | null) => { props.onResearchFileChange?.(file);
        if (!props.embedded && file && params.get("research_file") !== file.document.id)
            setParams({ research_file: file.document.id }, { replace: true }); };
    return <SourcesWorkspace fileId={id} projectId={props.projectId} restoreLast={!id}
        selection={props.embedded ? undefined : location.state?.researchSelection}
        refreshKey={props.researchRefreshKey} onChange={changed}>
        <LegalLibraryContent {...props} researchFileId={id} />
    </SourcesWorkspace>;
}
function LegalLibraryContent({ embedded = false, projectId, onOpenSource, researchFileId }: LibraryProps) {
    const { file: researchFile, mutations, selection } = useSourcesWorkspace();
    const [results, setResults] = useState<LegalSourceSearchResult[]>([]);
    const [searched, setSearched] = useState(false);
    const [notInstalled, setNotInstalled] = useState(false);
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
    const [researchOpen, setResearchOpen] = useState(!!researchFileId);
    const [researchRail, setResearchRail] = useState<HTMLElement | null>(null);
    const [readingSource, setReadingSource] = useState<LegalSourceTab | null>(null);
    const [sourceDropNonce, setSourceDropNonce] = useState(0);
    const [researchBusy, setResearchBusy] = useState(false);
    const { docType, jurisdiction, sourceKind, dataset } = filters;
    const updateFilters = (next: Partial<typeof filters>) =>
        setFilters((current) => ({ ...current, ...next }));
    useEffect(() => {
        getLegalSourceCoverage().then(setCoverage).catch(() => undefined);
    }, []);
    useEffect(() => { if (researchFileId) setResearchOpen(true); }, [researchFileId]);
    const sourceIndex = useMemo(() => new Map(Object.values(researchFile?.state.sources ?? {})
        .map((source) => [researchSourceKey(source.reference), source])), [researchFile]);
    const sourceInFile = (result: LegalSourceSearchResult) =>
        sourceIndex.get(researchSourceKey(researchReference(result)));
    const legalTab = (ref: ResearchSourceReference, citation: string,
        extra: Partial<LegalSourceTab>): LegalSourceTab => ({ kind: "legal",
            id: `legal:${ref.provider}:${ref.id}`, provider: ref.provider === "journal" ? "journal" : "a2aj",
            citation, sourceId: ref.id, name: ref.title ?? null,
            dataset: ref.collection ?? null, language: ref.language ?? "en",
            docType: ref.kind === "legislation" ? "laws" : ref.kind === "journal" ? "articles" : "cases",
            researchFileId: researchFile?.document.id, ...extra });
    function readSavedSource(source: ResearchSource, locator?: string) {
        const ref = source.reference;
        const tab = legalTab(ref, ref.citation || ref.id, { researchSourceId: source.id, initialLocator: locator });
        if (embedded && onOpenSource) onOpenSource(tab);
        else setReadingSource(tab);
    }
    async function saveResult(result: LegalSourceSearchResult, file = researchFile) {
        if (!file) throw new Error("Choose or create a workspace first");
        setResearchBusy(true);
        try {
            const next = await mutations.act({ type: "source", reference: researchReference(result),
                labelIds: (selection.labelIds ?? []).filter((id) => file.state.labels[id]?.scope === "source") });
            if (!next.sourceId) throw new Error("Saved source was not returned");
            return { file: next, itemId: next.sourceId };
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
    async function runSearch(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const query = searchQuery.trim();
        if (!query) return;
        setSearching(true);
        setSearched(false);
        setNotInstalled(false);
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
                        type === "articles" || docType === "all" || !dataset
                            ? undefined
                            : [dataset],
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
            const found = settled.flatMap((item) => item.status === "fulfilled" ? item.value.results : []);
            setNotInstalled(settled.some((item) => item.status === "fulfilled" && item.value.status === "not_installed"));
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
    const workspace = <ResearchWorkspaceHost embedded={embedded} open={researchOpen}
        rail={researchRail} onReadSource={readSavedSource}
        selectedSourceId={readingSource?.researchSourceId ?? undefined}
        onOpenChange={setResearchOpen} projectId={projectId}
        sourceDropNonce={sourceDropNonce} />;
    return (
        <div className="relative flex h-full min-w-0">
        <div className="flex min-w-0 flex-1 flex-col">
            {!embedded && <PageHeader breadcrumbs={[{ label: "Sources", onClick: readingSource ? () => setReadingSource(null) : undefined },
                ...(readingSource ? [{ label: "Source" }] : [])]}
                actions={readingSource ? [{ label: "Workspace", title: "Open research workspace",
                    icon: <PanelsTopLeft className="size-4" />, onClick: () => setResearchOpen(true) }]
                    : undefined} />}
            {embedded && researchOpen && <div className="flex min-w-0 items-center gap-2 border-b border-gray-200 p-3">
                <span ref={setResearchRail} className="block min-w-0 flex-1" />
                {researchFile && <Link to={`/sources?research_file=${encodeURIComponent(researchFile.document.id)}`}
                    aria-label="Open full research view" title="Open full research view"
                    className="grid size-9 shrink-0 place-items-center rounded-md border border-gray-300 bg-white text-gray-600 hover:bg-gray-50">
                    <ExternalLink className="size-4" aria-hidden="true" />
                </Link>}
                <Button variant="outline" size="icon-sm" className="size-9" aria-label="Close workspace" title="Close workspace"
                    onClick={() => { setResearchOpen(false); setReadingSource(null); }}>
                    <PanelRightClose aria-hidden className="size-4" />
                </Button>
            </div>}
            {readingSource && <section aria-label="Source reader" className="min-h-0 min-w-0 flex-1">
                <LegalSourceViewer key={readingSource.id} {...readingSource} navigationRequest={readingSource}
                    onOpenResearch={(intent) => { setResearchOpen(true);
                        if (intent) setSourceDropNonce((value) => value + 1); }} />
            </section>}
            <div hidden={!!readingSource || embedded && researchOpen}
                className={`${readingSource || embedded && researchOpen ? "hidden" : ""} min-h-0 flex-1 overflow-y-auto ${embedded ? "p-3" : "px-4 py-5 sm:px-6"}`}
            >
                <div className="mx-auto max-w-5xl">
                    <div className="space-y-4">
                    <form autoComplete="off"
                        onSubmit={runSearch}
                        className="@container rounded-lg border border-gray-200 bg-white p-4"
                    >
                        <TabList value={docType} onValueChange={(value) => updateFilters({
                            docType: value, jurisdiction: "", sourceKind: "", dataset: "" })}
                            options={SOURCE_TABS.map(([value, label]) => ({ value, label }))}
                            ariaLabel="Source category"
                            className="mb-3" />
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
                            <Button type="submit" disabled={searching}>
                                {searching ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                    <Search className="h-4 w-4" />
                                )}
                                Search
                            </Button>
                            <Button type="button" variant="outline" onClick={() => setResearchOpen(true)}
                                aria-expanded={researchOpen} aria-label="Open research workspace"
                                title={researchFile?.document.filename.replace(/\.research\.md$/iu, "") ?? "Workspace"}
                                className="gap-2">
                                Workspace
                                <PanelsTopLeft className="size-4" aria-hidden="true" />
                            </Button>
                        </div>
                        {docType !== "all" && (
                            <div className="mt-3 grid gap-2 @min-[28rem]:grid-cols-2 @min-[48rem]:grid-cols-4">
                                {(docType === "cases" || docType === "laws") && <>
                                    <FilterSelect id="legal-jurisdiction" label="Jurisdiction" value={jurisdiction}
                                        allLabel="All jurisdictions"
                                        onChange={(value) => updateFilters({ jurisdiction: value, dataset: "" })}
                                        options={jurisdictions.map(([code, name]) => ({ value: code, label: name }))} />
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
                                    <FilterSelect id="legal-dataset" span="@min-[48rem]:col-span-2"
                                        label={docType === "cases" ? "Court or tribunal" : "Collection"}
                                        value={dataset}
                                        allLabel={docType === "cases" ? "All courts and tribunals" : "All statutes and regulations"}
                                        onChange={(value) => updateFilters({ dataset: value })}
                                        options={availableSources.map((item) => ({ value: item.dataset, label: item.description }))} />
                                </>}
                                {(TEXT_FILTERS[docType] ?? []).map(([name, label, placeholder, span]) => (
                                    <label key={name} className={`${FILTER_LABEL} ${span}`}>
                                        {label}
                                        <input
                                            type="search"
                                            name={name}
                                            placeholder={placeholder}
                                            className={FILTER_INPUT}
                                        />
                                    </label>
                                ))}
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
                                <label className={`${FILTER_LABEL} @min-[28rem]:col-span-2`}>
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
                        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                            {error}
                        </p>
                    )}
                    {searched && (
                        <section>
                            {notInstalled && <p role="status" className="text-sm text-gray-600">Hansard is not installed.</p>}
                            {results.length ? <div className="grid gap-2">
                                {results.map((result) => {
                                    const sourceHref = safeAssistantUrl(result.url, {
                                        relative: false,
                                    });
                                    const sourceCitation = result.citation || (result.kind === "hansard"
                                        ? [result.date, result.speaker].filter(Boolean).join(" — ") : "") || result.id;
                                    const citation = result.provider === "journal" && result.title
                                        ? sourceCitation.replace(result.title, "")
                                            .replace(/(?:“”|""|‘’|'')/gu, "")
                                            .replace(/^[\s"'“”‘’.,:;–—-]+/u, "").replace(/\s{2,}/gu, " ").trim()
                                        : sourceCitation;
                                    const metadata = [
                                        result.title && result.title !== citation
                                            ? citation
                                            : null,
                                        result.collection,
                                        formatLongDate(result.date ?? null),
                                    ].filter(Boolean);
                                    const saved = sourceInFile(result);
                                    return (
                                        <article
                                            key={`${result.provider}:${result.id ?? ""}:${result.collection}:${result.citation}`}
                                            className="rounded-md border border-gray-200 bg-white p-4"
                                        >
                                        <div className={`flex flex-col gap-3 ${embedded ? "" : "sm:flex-row sm:items-start"}`}>
                                            <div className="flex min-w-0 flex-1 items-center gap-3">
                                                <ResearchLabelPicker file={researchFile} size="lg"
                                                    kind="source" itemId={saved?.id}
                                                    labelIds={saved?.labelIds ?? []} note={saved?.note}
                                                    title={result.title || sourceCitation}
                                                    disabled={researchBusy}
                                                    mutations={mutations} onError={setError} sourceReference={researchReference(result)}
                                                    onSourceDrag={() => { setResearchOpen(true); setSourceDropNonce((value) => value + 1); }}
                                                    onNeedFile={() => setResearchOpen(true)}
                                                    prepare={saved ? undefined : (file) => saveResult(result, file)} />
                                                <div className="min-w-0 flex-1">
                                                <h3 className="mt-0.5 text-base font-semibold text-gray-900">
                                                    {result.title || sourceCitation}
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
                                                {result.provider !== "hansard" && <button type="button"
                                                    onClick={() => (embedded && onOpenSource ? onOpenSource : setReadingSource)(
                                                        legalTab(researchReference(result), sourceCitation, {
                                                            id: `legal:${result.provider}:${result.id ?? result.citation}`,
                                                            researchSourceId: saved?.id,
                                                        }))} aria-label={`View ${result.title || sourceCitation}`} className="inline-flex h-8 items-center justify-center rounded-md bg-brand px-3 text-xs font-medium text-white hover:bg-brand-dark">
                                                        View
                                                    </button>}
                                                {sourceHref && (
                                                    <a
                                                        href={sourceHref}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        aria-label={`Site: View original source for ${result.title || sourceCitation}`}
                                                        title={`View original source for ${result.title || sourceCitation}`}
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
                            </div> : !notInstalled && !error && <p role="status" className="rounded-md border border-dashed border-gray-300 p-6 text-center text-sm text-gray-600">
                                No sources matched this search. Try fewer terms or a different source category.
                            </p>}
                        </section>
                    )}
                    </div>
                </div>
            </div>
        {(readingSource || embedded && researchOpen) && error && <p role="alert" className="px-6 py-2 text-sm text-red-700">{error}</p>}
        {embedded && workspace}
        </div>
        {!embedded && workspace}
        </div>
    );
}

export function LegalLibrarySourcePage(props: LegalSourceViewerProps) {
    return <SourcesWorkspace fileId={props.researchFileId} projectId={props.projectId} restoreLast={!props.researchFileId}>
        <LegalLibrarySourceContent {...props} />
    </SourcesWorkspace>;
}
function LegalLibrarySourceContent(viewerProps: LegalSourceViewerProps) {
    const navigate = useNavigate();
    const [researchOpen, setResearchOpen] = useState(!!viewerProps.researchFileId);
    const [sourceDropNonce, setSourceDropNonce] = useState(0);
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
                    onOpenResearch={(intent) => { setResearchOpen(true);
                        if (intent) setSourceDropNonce((value) => value + 1); }} /></div>
            </div>
        </div>
        <ResearchWorkspaceHost embedded={false} open={researchOpen}
            onOpenChange={setResearchOpen} projectId={viewerProps.projectId} sourceDropNonce={sourceDropNonce} />
        </div>
    );
}
