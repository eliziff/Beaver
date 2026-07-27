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
import { TableToolbar } from "@/app/components/shared/TableToolbar";
import { LIBRARY_TABS } from "@/app/components/library/LibraryWorkspace";
import {
    deleteLegalSource,
    listLegalLibrary,
    saveLegalSource,
    searchLegalSources,
    type LegalDocumentType,
    type LegalSourceReference,
    type LegalSourceSearchResult,
} from "@/app/lib/mikeApi";
import { LegalSourceViewer } from "./LegalSourceViewer";

function libraryRoute(tab: (typeof LIBRARY_TABS)[number]["id"]) {
    return tab === "files" ? "/library" : `/library/${tab}`;
}

function sourceKindLabel(docType: LegalDocumentType) {
    return docType === "laws"
        ? "Legislation"
        : docType === "articles"
          ? "Journal article"
          : "Decision";
}

export function LegalLibraryPage() {
    const router = useRouter();
    const [references, setReferences] = useState<LegalSourceReference[]>([]);
    const [results, setResults] = useState<LegalSourceSearchResult[]>([]);
    const [query, setQuery] = useState("");
    const [docType, setDocType] = useState<LegalDocumentType>("cases");
    const [loadingLibrary, setLoadingLibrary] = useState(true);
    const [searching, setSearching] = useState(false);
    const [savingCitation, setSavingCitation] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        listLegalLibrary()
            .then((loaded) => {
                if (!cancelled) setReferences(loaded);
            })
            .catch((reason: unknown) => {
                if (!cancelled) {
                    setError(
                        reason instanceof Error
                            ? reason.message
                            : "Could not load legal sources",
                    );
                }
            })
            .finally(() => {
                if (!cancelled) setLoadingLibrary(false);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    async function runSearch(event: FormEvent) {
        event.preventDefault();
        if (!query.trim()) return;
        setSearching(true);
        setError(null);
        try {
            setResults(
                await searchLegalSources({
                    query: query.trim(),
                    docType,
                }),
            );
        } catch (reason) {
            setError(
                reason instanceof Error ? reason.message : "Search failed",
            );
        } finally {
            setSearching(false);
        }
    }

    async function saveAndOpen(result: LegalSourceSearchResult) {
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
                current.some((item) => item.id === saved.id)
                    ? current
                    : [...current, saved],
            );
            router.push(`/library/legal/${saved.id}`);
        } catch (reason) {
            setError(
                reason instanceof Error
                    ? reason.message
                    : "Could not save legal source",
            );
        } finally {
            setSavingCitation(null);
        }
    }

    async function remove(reference: LegalSourceReference) {
        try {
            await deleteLegalSource(reference.id);
            setReferences((current) =>
                current.filter((item) => item.id !== reference.id),
            );
        } catch (reason) {
            setError(
                reason instanceof Error
                    ? reason.message
                    : "Could not remove legal source",
            );
        }
    }

    return (
        <div className="flex h-full min-h-0 flex-col">
            <PageHeader
                breadcrumbs={[
                    { label: "Library" },
                    { label: "Legal Sources" },
                ]}
            />
            <TableToolbar
                items={LIBRARY_TABS}
                active="legal"
                onChange={(tab) => router.push(libraryRoute(tab))}
            />

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
                <div className="mx-auto max-w-5xl space-y-6">
                    <form
                        onSubmit={runSearch}
                        className="rounded-xl border border-gray-200 bg-white/65 p-4 shadow-sm backdrop-blur-xl"
                    >
                        <div className="mb-3">
                            <h1 className="font-serif text-xl text-gray-900">
                                Find a Canadian legal source
                            </h1>
                            <p className="mt-1 text-xs text-gray-500">
                                Search cases, legislation, and locally indexed
                                journal articles. Saving stores only a
                                lightweight source pointer.
                            </p>
                        </div>
                        <div className="flex flex-col gap-2 sm:flex-row">
                            <select
                                value={docType}
                                onChange={(event) =>
                                    setDocType(
                                        event.target.value as LegalDocumentType,
                                    )
                                }
                                aria-label="Legal source type"
                                className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 outline-none focus:border-brand"
                            >
                                <option value="cases">Cases</option>
                                <option value="laws">Legislation</option>
                                <option value="articles">
                                    Journal articles
                                </option>
                            </select>
                            <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 focus-within:border-brand">
                                <Search className="h-4 w-4 shrink-0 text-gray-400" />
                                <span className="sr-only">Search A2AJ</span>
                                <input
                                    value={query}
                                    onChange={(event) =>
                                        setQuery(event.target.value)
                                    }
                                    placeholder={
                                        docType === "laws"
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
                                disabled={searching || !query.trim()}
                                className="inline-flex items-center justify-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-45"
                            >
                                {searching ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                    <Search className="h-4 w-4" />
                                )}
                                Search
                            </button>
                        </div>
                    </form>

                    {error ? (
                        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                            {error}
                        </p>
                    ) : null}

                    {results.length > 0 ? (
                        <section>
                            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                                Search results
                            </h2>
                            <div className="grid gap-2">
                                {results.map((result) => (
                                    <article
                                        key={`${result.provider}:${result.source_id ?? ""}:${result.dataset}:${result.citation}`}
                                        className="rounded-lg border border-gray-200 bg-white/60 p-4"
                                    >
                                        <div className="flex items-start gap-3">
                                            <div className="min-w-0 flex-1">
                                                <p className="text-[11px] font-semibold uppercase tracking-wide text-brand">
                                                    {sourceKindLabel(
                                                        result.doc_type,
                                                    )}
                                                </p>
                                                <h3 className="mt-0.5 font-serif text-base text-gray-900">
                                                    {result.name ||
                                                        result.citation}
                                                </h3>
                                                <p className="mt-1 font-serif text-sm italic text-gray-600">
                                                    {result.citation}
                                                </p>
                                                <p className="mt-1 text-xs text-gray-400">
                                                    {[
                                                        result.dataset,
                                                        result.date,
                                                    ]
                                                        .filter(Boolean)
                                                        .join(" / ")}
                                                </p>
                                                {result.snippet ? (
                                                    <p className="mt-2 line-clamp-3 font-serif text-sm leading-6 text-gray-600">
                                                        {result.snippet}
                                                    </p>
                                                ) : null}
                                            </div>
                                            <button
                                                type="button"
                                                disabled={
                                                    savingCitation ===
                                                    result.citation
                                                }
                                                onClick={() =>
                                                    void saveAndOpen(result)
                                                }
                                                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-brand bg-brand-soft px-2.5 py-1.5 text-xs font-medium text-brand hover:bg-brand hover:text-white disabled:opacity-50"
                                            >
                                                {savingCitation ===
                                                result.citation ? (
                                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                ) : (
                                                    <LibraryBig className="h-3.5 w-3.5" />
                                                )}
                                                Save & open
                                            </button>
                                        </div>
                                    </article>
                                ))}
                            </div>
                        </section>
                    ) : null}

                    <section>
                        <div className="mb-2 flex items-center justify-between">
                            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                                Saved sources
                            </h2>
                            <span className="text-xs text-gray-400">
                                {references.length}
                            </span>
                        </div>
                        {loadingLibrary ? (
                            <div className="flex justify-center py-10">
                                <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
                            </div>
                        ) : references.length ? (
                            <div className="overflow-hidden rounded-lg border border-gray-200 bg-white/60">
                                {references.map((reference) => {
                                    const href = `/library/legal/${reference.id}`;
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
                                                <p className="truncate font-serif text-sm text-gray-900">
                                                    {reference.citation}
                                                </p>
                                                <p className="mt-0.5 text-[11px] text-gray-400">
                                                    {[
                                                        sourceKindLabel(
                                                            reference.doc_type,
                                                        ),
                                                        reference.dataset,
                                                        reference.language.toUpperCase(),
                                                    ]
                                                        .filter(Boolean)
                                                        .join(" / ")}
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
                                                aria-label={`Remove ${reference.citation} from Library`}
                                                title="Remove from Library"
                                            >
                                                <Trash2 className="h-4 w-4" />
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        ) : (
                            <p className="rounded-lg border border-dashed border-gray-200 py-10 text-center font-serif text-sm text-gray-400">
                                Search above to add a legal source.
                            </p>
                        )}
                    </section>
                </div>
            </div>
        </div>
    );
}

export function LegalLibraryDocumentPage({
    referenceId,
}: {
    referenceId: string;
}) {
    const router = useRouter();
    return (
        <div className="flex h-full min-h-0 flex-col">
            <PageHeader
                breadcrumbs={[
                    {
                        label: "Library",
                        onClick: () => router.push("/library"),
                    },
                    {
                        label: "Legal Sources",
                        onClick: () => router.push("/library/legal"),
                    },
                    { label: "Source" },
                ]}
            />
            <div className="min-h-0 flex-1">
                <LegalSourceViewer referenceId={referenceId} />
            </div>
        </div>
    );
}
