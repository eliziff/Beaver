"use client";
import { useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import type { AssistantEvent, Citation, EditAnnotation } from "../shared/types";
import { EditCard } from "./EditCard";
import { PreResponseWrapper } from "./PreResponseWrapper";
import {
    activityLabel,
    dedupeActivityEntries,
    toolCallLabel,
} from "./message/eventUtils";
import { preprocessCitations, internalCaseHref } from "./message/citationUtils";
import { MarkdownContent } from "./message/MarkdownContent";
import { CitationsBlock, buildCitationAppendix } from "./message/CitationSources";
import { EditCardsSection } from "./message/EditCardsSection";
import {
    AutomationRunButton,
    automationRunKey,
} from "./AutomationRun";
import {
    AskInputsBlock,
    CourtListenerBlock,
    DocCreatedBlock,
    DocDownloadBlock,
    DocEditedBlock,
    DocFindBlock,
    DocReadBlock,
    EventBlock,
    ReasoningBlock,
    WorkflowAppliedBlock,
    type CourtListenerBlockItem,
} from "./message/EventBlocks";
interface Props {
    events?: AssistantEvent[];
    isStreaming?: boolean;
    isError?: boolean;
    errorMessage?: string;
    citations?: Citation[];
    citationStatus?: "started" | "partial" | "final";
    onCitationClick?: (citation: Citation) => void;
    onOpenCitationSource?: (citation: Citation) => void;
    onCaseClick?: (
        citation: Extract<AssistantEvent, { type: "case_citation" }>,
    ) => void;
    onAutomationClick?: (
        run: Extract<AssistantEvent, { type: "automation_run" }>,
    ) => void;
    minHeight?: string;
    onWorkflowClick?: (workflowId: string) => void;
    onEditViewClick?: (
        ann: EditAnnotation,
        filename: string,
        changeNumber?: number,
    ) => void;
    onOpenDocument?: (args: {
        documentId: string;
        filename: string;
        versionId: string | null;
        versionNumber: number | null;
    }) => void;
    onEditResolveStart?: (args: {
        editId: string;
        documentId: string;
        verb: "accept" | "reject";
    }) => void;
    onEditResolved?: (args: {
        editId: string;
        documentId: string;
        status: "accepted" | "rejected";
        versionId: string | null;
        downloadUrl: string | null;
    }) => void;
    onEditError?: (args: {
        editId: string;
        documentId: string;
        versionId: string | null;
        message: string;
    }) => void;
    isDocReloading?: (documentId: string) => boolean;
    isEditReloading?: (editId: string) => boolean;
    resolvedEditStatuses?: Record<string, "accepted" | "rejected">;
}
export function AssistantMessage({
    events,
    isStreaming = false,
    isError = false,
    errorMessage,
    citations = [],
    citationStatus,
    onCitationClick,
    onOpenCitationSource,
    onCaseClick,
    onAutomationClick,
    minHeight = "0px",
    onWorkflowClick,
    onEditViewClick,
    onOpenDocument,
    onEditResolveStart,
    onEditResolved,
    onEditError,
    isDocReloading,
    isEditReloading,
    resolvedEditStatuses,
}: Props) {
    const contentDivRef = useRef<HTMLDivElement | null>(null);
    const [isCopied, setIsCopied] = useState(false);
    const [resolvedOverrides, setResolvedOverrides] = useState<
        Record<string, string>
    >({});
    const handleEditResolved = (args: {
        editId: string;
        documentId: string;
        status: "accepted" | "rejected";
        versionId: string | null;
        downloadUrl: string | null;
    }) => {
        if (args.downloadUrl) {
            setResolvedOverrides((prev) => ({
                ...prev,
                [args.documentId]: args.downloadUrl as string,
            }));
        }
        onEditResolved?.(args);
    };
    const topLevelErrorMessage =
        errorMessage ??
        (
            (events ?? []).find((event) => event.type === "error") as
                | Extract<AssistantEvent, { type: "error" }>
                | undefined
        )?.message ??
        (isError ? "Response failed." : null) ??
        null;
    const isRenderableEvent = (event: AssistantEvent) =>
        event.type !== "error" &&
        event.type !== "ask_inputs_response" &&
        event.type !== "case_citation" &&
        event.type !== "case_opinions" &&
        event.type !== "doc_download";
    const lastContentIdx = events
        ? events.reduce(
              (last, e, idx) => (e.type === "content" ? idx : last),
              -1,
          )
        : -1;
    const inlineCitationTargets: Citation[] = [];
    const caseCitations = new Map<
        string,
        Extract<AssistantEvent, { type: "case_citation" }>
    >();
    const caseOpinions = new Map<
        number,
        Extract<AssistantEvent, { type: "case_opinions" }>["case"]
    >();
    const processedTexts: string[] = [];
    if (events) {
        for (let i = 0; i < events.length; i++) {
            const event = events[i];
            if (event.type === "case_citation") {
                const hrefKey = internalCaseHref(event.cluster_id);
                if (hrefKey) caseCitations.set(hrefKey, event);
            } else if (event.type === "case_opinions") {
                caseOpinions.set(event.cluster_id, event.case);
            }
            processedTexts.push(
                event.type === "content"
                    ? preprocessCitations(
                          event.text,
                          citations,
                          inlineCitationTargets,
                      )
                    : "",
            );
        }
    }
    const handleOpenCitationSource = (citation: Citation) => {
        if (onOpenCitationSource) {
            onOpenCitationSource(citation);
            return;
        }
        if (
            citation.kind === "case" ||
            citation.kind === "a2aj" ||
            citation.kind === "public_legal" ||
            !onOpenDocument
        )
            return;
        onOpenDocument({
            documentId: citation.document_id,
            filename: citation.filename,
            versionId: citation.version_id ?? null,
            versionNumber: citation.version_number ?? null,
        });
    };
    const canOpenCitationSource = (citation: Citation) =>
        !!onOpenCitationSource ||
        (citation.kind !== "case" &&
            citation.kind !== "a2aj" &&
            citation.kind !== "public_legal" &&
            !!onOpenDocument);
    const showCitationBlock =
        !!citationStatus || (!isStreaming && citations.length > 0);
    const handleCopy = async () => {
        try {
            let html = "";
            let plainText = "";
            if (contentDivRef.current) {
                const clone = contentDivRef.current.cloneNode(
                    true,
                ) as HTMLElement;
                clone.querySelectorAll("[data-citation-ref]").forEach((el) => {
                    const ref = el.getAttribute("data-citation-ref");
                    if (!ref) return;
                    const sup = document.createElement("sup");
                    sup.textContent = ref;
                    el.replaceWith(sup);
                });
                html = clone.innerHTML;
                plainText = clone.textContent || "";
            }
            const appendix = buildCitationAppendix(citations);
            html += appendix.html;
            plainText += appendix.text;
            const item = new ClipboardItem({
                "text/html": new Blob([html], { type: "text/html" }),
                "text/plain": new Blob([plainText], { type: "text/plain" }),
            });
            await navigator.clipboard.write([item]);
            setIsCopied(true);
            setTimeout(() => setIsCopied(false), 2000);
        } catch {
        }
    };
    const rawActivityEntries: { event: AssistantEvent; index: number }[] = [];
    const automationByRun = new Map<
        string,
        {
            event: Extract<AssistantEvent, { type: "automation_run" }>;
            index: number;
        }
    >();
    const contentEntries: {
        event: Extract<AssistantEvent, { type: "content" }>;
        index: number;
    }[] = [];
    events?.forEach((event, index) => {
        if (!isRenderableEvent(event)) return;
        if (event.type === "automation_run") {
            const key = automationRunKey(event);
            const previous = automationByRun.get(key);
            automationByRun.set(key, {
                event: previous
                    ? { ...previous.event, ...event }
                    : event,
                index,
            });
            rawActivityEntries.push({ event, index });
        } else if (event.type === "content") {
            contentEntries.push({ event, index });
        } else if (event.type !== "reasoning" || event.text.trim()) {
            rawActivityEntries.push({ event, index });
        }
    });
    const activityEntries = dedupeActivityEntries(rawActivityEntries).filter(
        ({ event }) => event.type !== "automation_run",
    );
    const automationEntries = [...automationByRun.values()];
    const activityEvents = activityEntries.map(({ event }) => event);
    const latestActivityLabel = [...activityEvents]
        .reverse()
        .map(activityLabel)
        .find((label): label is string => !!label);
    const askInputsResponseFor = (askInputsIdx: number) => {
        if (!events) return undefined;
        for (let i = askInputsIdx + 1; i < events.length; i++) {
            const candidate = events[i];
            if (candidate.type === "ask_inputs") return undefined;
            if (candidate.type === "ask_inputs_response") return candidate;
        }
        return undefined;
    };
    const hasPendingAskInput = activityEntries.some(
        ({ event, index }) =>
            event.type === "ask_inputs" && !askInputsResponseFor(index),
    );
    const activityIsStreaming =
        isStreaming ||
        hasPendingAskInput ||
        activityEvents.some(
            (event) => "isStreaming" in event && !!event.isStreaming,
        );
    const renderEvent = (
        event: AssistantEvent,
        i: number,
        allEvents: AssistantEvent[],
        globalIdx: number,
    ) => {
        const nextEvent = allEvents[i + 1];
        const showConnector =
            nextEvent !== undefined && nextEvent.type !== "content";
        if (event.type === "reasoning") {
            return (
                <ReasoningBlock
                    key={globalIdx}
                    text={event.text}
                    isStreaming={!!event.isStreaming}
                    showConnector={showConnector}
                />
            );
        }
        if (event.type === "tool_call_start") {
            return (
                <EventBlock
                    key={globalIdx}
                    showConnector={showConnector}
                    isStreaming
                >
                    <span className="font-medium">
                        {toolCallLabel(event.name)}
                    </span>
                </EventBlock>
            );
        }
        if (event.type === "thinking") {
            return (
                <EventBlock
                    key={globalIdx}
                    showConnector={showConnector}
                    isStreaming
                >
                    <span>Thinking...</span>
                </EventBlock>
            );
        }
        if (event.type === "mcp_tool_call") {
            const isError = event.status === "error";
            const label = event.connector_name
                ? `${event.connector_name}: ${toolCallLabel(event.tool_name)}`
                : toolCallLabel(event.openai_tool_name);
            return (
                <EventBlock
                    key={globalIdx}
                    showConnector={showConnector}
                    isStreaming={event.isStreaming}
                    dotColor={isError ? "red" : "gray"}
                >
                    <span className="font-medium">
                        {event.isStreaming ? "Using connector..." : label}
                    </span>
                    {isError && event.error && (
                        <p className="mt-0.5 text-xs text-red-600">
                            {event.error}
                        </p>
                    )}
                </EventBlock>
            );
        }
        if (event.type === "doc_read") {
            const ann = citations.find(
                (a) =>
                    a.kind !== "case" &&
                    a.kind !== "a2aj" &&
                    a.kind !== "public_legal" &&
                    a.filename === event.filename,
            );
            return (
                <DocReadBlock
                    key={globalIdx}
                    filename={event.filename}
                    isStreaming={event.isStreaming}
                    onClick={
                        !event.isStreaming && ann && onCitationClick
                            ? () => onCitationClick(ann)
                            : undefined
                    }
                    showConnector={showConnector}
                />
            );
        }
        if (event.type === "doc_find") {
            return (
                <DocFindBlock
                    key={globalIdx}
                    filename={event.filename}
                    query={event.query}
                    totalMatches={event.total_matches}
                    isStreaming={!!event.isStreaming}
                    showConnector={showConnector}
                />
            );
        }
        if (event.type === "doc_created") {
            return (
                <DocCreatedBlock
                    key={globalIdx}
                    filename={event.filename}
                    isStreaming={event.isStreaming}
                    showConnector={showConnector}
                />
            );
        }
        if (event.type === "doc_edited") {
            return (
                <DocEditedBlock
                    key={globalIdx}
                    filename={event.filename}
                    isStreaming={event.isStreaming}
                    hasError={!!event.error}
                    showConnector={showConnector}
                />
            );
        }
        if (event.type === "workflow_applied") {
            return (
                <WorkflowAppliedBlock
                    key={globalIdx}
                    title={event.title}
                    showConnector={showConnector}
                    onClick={
                        onWorkflowClick
                            ? () => onWorkflowClick(event.workflow_id)
                            : undefined
                    }
                />
            );
        }
        if (event.type === "ask_inputs") {
            const response = askInputsResponseFor(globalIdx);
            return (
                <AskInputsBlock
                    key={globalIdx}
                    event={event}
                    response={response}
                    showConnector={showConnector}
                />
            );
        }
        if (event.type === "courtlistener_search_case_law") {
            const count = event.result_count ?? 0;
            const detail = event.isStreaming
                ? event.query
                    ? `for "${event.query}"`
                    : undefined
                : event.error
                  ? event.error
                  : `${count} ${count === 1 ? "result" : "results"}${event.query ? ` for "${event.query}"` : ""}`;
            return (
                <CourtListenerBlock
                    key={globalIdx}
                    label={
                        event.isStreaming
                            ? "Searching case law"
                            : event.error
                              ? "Case law search failed"
                              : "Searched case law"
                    }
                    detail={detail}
                    isStreaming={!!event.isStreaming}
                    hasError={!!event.error}
                    showConnector={showConnector}
                />
            );
        }
        if (event.type === "courtlistener_get_cases") {
            const caseCount = event.case_count ?? event.cluster_ids.length;
            const displayLabel = `${caseCount} ${
                caseCount === 1 ? "case" : "cases"
            }`;
            const detail = event.error ? event.error : undefined;
            const items: CourtListenerBlockItem[] =
                event.cases?.map((caseItem) => ({
                    caseName: caseItem.case_name,
                    citation: caseItem.citation,
                    url: caseItem.url ?? null,
                })) ??
                event.cluster_ids.map((clusterId) => {
                    const citation = caseCitations.get(`us-case-${clusterId}`);
                    return {
                        caseName: citation?.case_name ?? null,
                        citation: citation?.citation ?? `Cluster ${clusterId}`,
                        url: citation?.url ?? null,
                    };
                });
            return (
                <CourtListenerBlock
                    key={globalIdx}
                    label={
                        event.isStreaming
                            ? `Fetching ${displayLabel}`
                            : event.error
                              ? "Case fetch failed"
                              : `Fetched ${displayLabel}`
                    }
                    detail={detail}
                    isStreaming={!!event.isStreaming}
                    hasError={!!event.error}
                    showConnector={showConnector}
                    items={items.length > 0 ? items : undefined}
                />
            );
        }
        if (event.type === "courtlistener_find_in_case") {
            const searches = event.searches ?? [];
            if (searches.length > 0) {
                const matches =
                    event.total_matches ??
                    searches.reduce(
                        (sum, search) => sum + (search.total_matches ?? 0),
                        0,
                    );
                const caseIds = new Set(
                    searches.map(
                        (search) =>
                            search.cluster_id ??
                            `${search.case_name ?? ""}|${search.citation ?? ""}`,
                    ),
                );
                const caseCount = caseIds.size || searches.length;
                const searchLabel = `${searches.length} ${
                    searches.length === 1 ? "search" : "searches"
                } in ${caseCount} ${caseCount === 1 ? "case" : "cases"}`;
                const detail = event.isStreaming
                    ? undefined
                    : event.error
                      ? event.error
                      : `(${matches} ${matches === 1 ? "match" : "matches"})`;
                const items: CourtListenerBlockItem[] = searches.map(
                    (search) => ({
                        caseName: search.case_name ?? null,
                        citation:
                            search.citation ??
                            (search.cluster_id
                                ? `Cluster ${search.cluster_id}`
                                : null),
                        url: null,
                        query: search.query,
                        totalMatches: search.total_matches ?? 0,
                        hasError: !!search.error,
                    }),
                );
                return (
                    <CourtListenerBlock
                        key={globalIdx}
                        label={
                            event.isStreaming
                                ? `Running ${searchLabel}`
                                : event.error
                                  ? "Case searches failed"
                                  : `Ran ${searchLabel}`
                        }
                        detail={detail}
                        isStreaming={!!event.isStreaming}
                        hasError={!!event.error}
                        showConnector={showConnector}
                        items={items.length > 0 ? items : undefined}
                    />
                );
            }
            const matches = event.total_matches ?? 0;
            const caseLabel =
                [event.case_name, event.citation].filter(Boolean).join(", ") ||
                (event.cluster_id ? `cluster ${event.cluster_id}` : "case");
            const detail = event.isStreaming
                ? event.query
                    ? `for "${event.query}" in ${caseLabel}`
                    : caseLabel
                : event.error
                  ? event.error
                  : `${matches} ${matches === 1 ? "match" : "matches"}${event.query ? ` for "${event.query}"` : ""} in ${caseLabel}`;
            return (
                <CourtListenerBlock
                    key={globalIdx}
                    label={
                        event.isStreaming
                            ? "Searching case"
                            : event.error
                              ? "Case search failed"
                              : "Searched case"
                    }
                    detail={detail}
                    isStreaming={!!event.isStreaming}
                    hasError={!!event.error}
                    showConnector={showConnector}
                />
            );
        }
        if (event.type === "courtlistener_read_case") {
            const count = event.opinion_count ?? 0;
            const caseLabel =
                [event.case_name, event.citation].filter(Boolean).join(", ") ||
                "case";
            const detail = event.isStreaming
                ? undefined
                : event.error
                  ? event.error
                  : count > 0
                    ? `(${count} ${count === 1 ? "opinion" : "opinions"})`
                    : undefined;
            return (
                <CourtListenerBlock
                    key={globalIdx}
                    label={
                        event.isStreaming
                            ? `Reading case ${caseLabel}`
                            : event.error
                              ? `Case read failed ${caseLabel}`
                              : `Read case ${caseLabel}`
                    }
                    detail={detail}
                    isStreaming={!!event.isStreaming}
                    hasError={!!event.error}
                    showConnector={showConnector}
                />
            );
        }
        if (event.type === "courtlistener_verify_citations") {
            const citations = event.citation_count ?? 0;
            const matches = event.match_count ?? 0;
            const citationLabel = `${citations} ${citations === 1 ? "citation" : "citations"}`;
            const detail = event.isStreaming
                ? undefined
                : event.error
                  ? event.error
                  : `(${matches} ${matches === 1 ? "match" : "matches"})`;
            const items: CourtListenerBlockItem[] = [];
            if (events) {
                for (let j = globalIdx + 1; j < events.length; j++) {
                    const e = events[j];
                    if (e.type !== "case_citation") break;
                    items.push({
                        caseName: e.case_name,
                        citation: e.citation,
                        url: e.url || null,
                    });
                }
            }
            return (
                <CourtListenerBlock
                    key={globalIdx}
                    label={
                        event.isStreaming
                            ? `Verifying ${citationLabel}`
                            : event.error
                              ? "Citation verification failed"
                              : `Verified ${citationLabel}`
                    }
                    detail={detail}
                    isStreaming={!!event.isStreaming}
                    hasError={!!event.error}
                    showConnector={showConnector}
                    items={items.length > 0 ? items : undefined}
                />
            );
        }
        return null;
    };
    return (
        <div style={{ minHeight }}>
            <div className="relative mt-2 w-full font-inter">
                {events && events.length > 0 ? (
                    <div className="flex flex-col gap-4">
                        {activityEntries.length > 0 && (
                            <PreResponseWrapper
                                isStreaming={activityIsStreaming}
                                label={latestActivityLabel ?? "Thinking"}
                            >
                                {activityEntries.map(({ event, index }, i) =>
                                    renderEvent(
                                        event,
                                        i,
                                        activityEvents,
                                        index,
                                    ),
                                )}
                            </PreResponseWrapper>
                        )}
                        {automationEntries.map(({ event }) => (
                            <AutomationRunButton
                                key={automationRunKey(event)}
                                run={event}
                                onOpen={onAutomationClick ?? (() => undefined)}
                            />
                        ))}
                        {contentEntries.map(({ index }) => (
                            <div key={`c-${index}`}>
                                <MarkdownContent
                                    text={processedTexts[index]}
                                    inlineCitationTargets={
                                        inlineCitationTargets
                                    }
                                    caseCitations={caseCitations}
                                    caseOpinions={caseOpinions}
                                    onCitationClick={onCitationClick}
                                    onCaseClick={onCaseClick}
                                    divRef={
                                        index === lastContentIdx
                                            ? contentDivRef
                                            : undefined
                                    }
                                />
                            </div>
                        ))}
                        {!isStreaming &&
                            (() => {
                                const editedEvents = events.filter(
                                    (e) =>
                                        e.type === "doc_edited" &&
                                        !e.isStreaming,
                                ) as Extract<
                                    AssistantEvent,
                                    { type: "doc_edited" }
                                >[];
                                const pending: {
                                    annotation: EditAnnotation;
                                    filename: string;
                                }[] = [];
                                const filenameByDocId = new Map<
                                    string,
                                    string
                                >();
                                const statusOf = (ann: EditAnnotation) =>
                                    resolvedEditStatuses?.[ann.edit_id] ??
                                    ann.status;
                                for (const e of editedEvents) {
                                    filenameByDocId.set(
                                        e.document_id,
                                        e.filename,
                                    );
                                    for (const ann of e.annotations) {
                                        if (statusOf(ann) === "pending") {
                                            pending.push({
                                                annotation: ann,
                                                filename: e.filename,
                                            });
                                        }
                                    }
                                }
                                let cardIndex = 0;
                                const cards = editedEvents.flatMap((e) =>
                                    e.annotations.map((ann) => {
                                        const changeNumber = ++cardIndex;
                                        return (
                                            <EditCard
                                                key={`editcard-${ann.edit_id}`}
                                                annotation={ann}
                                                changeNumber={changeNumber}
                                                resolvedStatus={
                                                    resolvedEditStatuses?.[
                                                        ann.edit_id
                                                    ]
                                                }
                                                isReloading={
                                                    isEditReloading?.(
                                                        ann.edit_id,
                                                    ) ?? false
                                                }
                                                onViewClick={(a) =>
                                                    onEditViewClick?.(
                                                        a,
                                                        e.filename,
                                                        changeNumber,
                                                    )
                                                }
                                                onResolveStart={
                                                    onEditResolveStart
                                                }
                                                onResolved={handleEditResolved}
                                                onError={onEditError}
                                            />
                                        );
                                    }),
                                );
                                const resolvedCount = editedEvents.reduce(
                                    (acc, e) =>
                                        acc +
                                        e.annotations.filter(
                                            (a) => statusOf(a) !== "pending",
                                        ).length,
                                    0,
                                );
                                if (cards.length <= 1) {
                                    return cards;
                                }
                                return (
                                    <EditCardsSection
                                        pending={pending}
                                        filenameByDocId={filenameByDocId}
                                        cards={cards}
                                        resolvedCount={resolvedCount}
                                        onViewClick={onEditViewClick}
                                        onResolveStart={onEditResolveStart}
                                        onResolved={handleEditResolved}
                                        onError={onEditError}
                                    />
                                );
                            })()}
                    </div>
                ) : null}
                {isStreaming &&
                    activityEntries.length === 0 &&
                    automationEntries.length === 0 && (
                    <PreResponseWrapper isStreaming label="Thinking" />
                )}
                {topLevelErrorMessage && (
                    <p className="mt-2 text-base font-serif leading-7 text-red-700">
                        {topLevelErrorMessage}
                    </p>
                )}
                {events &&
                    !isStreaming &&
                    (() => {
                        const edited = events.filter(
                            (
                                e,
                            ): e is Extract<
                                AssistantEvent,
                                { type: "doc_edited" }
                            > =>
                                e.type === "doc_edited" &&
                                !e.isStreaming &&
                                !!e.download_url,
                        );
                        const latestByDoc = new Map<
                            string,
                            (typeof edited)[number]
                        >();
                        for (const e of edited)
                            latestByDoc.set(e.document_id, e);
                        return Array.from(latestByDoc.values()).map((e) => (
                            <div
                                key={`edited-download-${e.document_id}`}
                                className="flex flex-col gap-2 mt-2 mb-3"
                            >
                                <DocDownloadBlock
                                    filename={e.filename}
                                    download_url={
                                        resolvedOverrides[e.document_id] ??
                                        e.download_url
                                    }
                                    versionNumber={e.version_number ?? null}
                                    onOpen={
                                        onOpenDocument
                                            ? () =>
                                                  onOpenDocument({
                                                      documentId: e.document_id,
                                                      filename: e.filename,
                                                      versionId:
                                                          e.version_id ?? null,
                                                      versionNumber:
                                                          e.version_number ??
                                                          null,
                                                  })
                                            : onEditViewClick &&
                                                e.annotations[0]
                                              ? () =>
                                                    onEditViewClick(
                                                        e.annotations[0],
                                                        e.filename,
                                                    )
                                              : undefined
                                    }
                                    isReloading={
                                        isDocReloading?.(e.document_id) ?? false
                                    }
                                />
                            </div>
                        ));
                    })()}
                {events &&
                    !isStreaming &&
                    events.some(
                        (e) => e.type === "doc_created" && e.download_url,
                    ) && (
                        <div className="flex flex-col gap-2 mt-2 mb-3">
                            {(
                                events.filter(
                                    (e) =>
                                        e.type === "doc_created" &&
                                        e.download_url,
                                ) as Extract<
                                    AssistantEvent,
                                    { type: "doc_created" }
                                >[]
                            ).map((e, i) => {
                                const documentId = e.document_id;
                                const versionId = e.version_id ?? null;
                                const versionNumber = e.version_number ?? null;
                                const canOpen =
                                    !!onOpenDocument && !!documentId;
                                return (
                                    <DocDownloadBlock
                                        key={i}
                                        filename={e.filename}
                                        download_url={e.download_url}
                                        versionNumber={versionNumber}
                                        onOpen={
                                            canOpen
                                                ? () =>
                                                      onOpenDocument!({
                                                          documentId:
                                                              documentId!,
                                                          filename: e.filename,
                                                          versionId,
                                                          versionNumber,
                                                      })
                                                : undefined
                                        }
                                    />
                                );
                            })}
                        </div>
                    )}
                {showCitationBlock && (
                    <CitationsBlock
                        citations={citations}
                        onCitationClick={onCitationClick}
                        onOpenSource={handleOpenCitationSource}
                        canOpenSource={canOpenCitationSource}
                        showWhenEmpty={!!citationStatus}
                        isLoading={
                            citationStatus === "started" ||
                            citationStatus === "partial"
                        }
                    />
                )}
                <div className="flex items-center gap-2 py-2 font-sans justify-start">
                    {!isStreaming && (
                        <button
                            className="p-1.5 rounded text-gray-500 hover:text-gray-700 hover:bg-gray-100"
                            onClick={handleCopy}
                        >
                            {isCopied ? (
                                <Check className="h-3.5 w-3.5 text-green-600" />
                            ) : (
                                <Copy className="h-3.5 w-3.5" />
                            )}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
