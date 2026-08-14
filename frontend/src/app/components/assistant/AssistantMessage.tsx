import { useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import {
    citationPinpoint,
    formatCitationPage,
    type AssistantEvent,
    type Citation,
    type DocumentCitation,
    type EditAnnotation,
    type EditResolveHandlers,
    type EditResolved,
} from "../shared/types";
import { EditCard } from "./EditCard";
import {
    activityView,
    dedupeActivityEntries,
} from "./message/eventUtils";
import {
    preprocessCitations,
    internalCaseHref,
    citationSourceKey,
    type CitationHistory,
} from "./message/citationUtils";
import { citationPillParts } from "./message/CitationSources";
import { MarkdownContent } from "./message/MarkdownContent";
import { EditCardsSection } from "./message/EditCardsSection";
import {
    AutomationRunButton,
    automationRunKey,
} from "./AutomationRun";
import {
    ActivityDisclosure,
    ActivityRow,
    DocDownloadBlock,
} from "./message/EventBlocks";
interface Props {
    events?: AssistantEvent[];
    isStreaming?: boolean;
    isError?: boolean;
    errorMessage?: string;
    citations?: Citation[];
    onCitationClick?: (citation: Citation) => void;
    citationTitle?: (citation: Citation) => string;
    showCopyAction?: boolean;
    onCaseClick?: (
        citation: Extract<AssistantEvent, { type: "case_citation" }>,
    ) => void;
    onAutomationClick?: (
        run: Extract<AssistantEvent, { type: "automation_run" }>,
    ) => void;
    onSubagentClick?: (
        run: Extract<AssistantEvent, { type: "subagent_run" }>,
    ) => void;
    onSubagentSourceClick?: (
        source: NonNullable<
            Extract<AssistantEvent, { type: "subagent_run" }>["sources"]
        >[number],
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
    onEditResolveStart?: EditResolveHandlers["onResolveStart"];
    onEditResolved?: EditResolveHandlers["onResolved"];
    onEditError?: EditResolveHandlers["onError"];
    isDocReloading?: (documentId: string) => boolean;
    isEditReloading?: (editId: string) => boolean;
    resolvedEditStatuses?: Record<string, "accepted" | "rejected">;
}
type EventOf<T extends AssistantEvent["type"]> = Extract<
    AssistantEvent,
    { type: T }
>;

export function AssistantMessage({
    events,
    isStreaming = false,
    isError = false,
    errorMessage,
    citations = [],
    onCitationClick,
    citationTitle,
    showCopyAction = true,
    onCaseClick,
    onAutomationClick,
    onSubagentClick,
    onSubagentSourceClick,
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
    const handleEditResolved = (args: EditResolved) => {
        if (args.downloadUrl)
            setResolvedOverrides((prev) => ({
                ...prev,
                [args.documentId]: args.downloadUrl!,
            }));
        onEditResolved?.(args);
    };
    const isDocumentCitation = (
        citation: Citation,
    ): citation is DocumentCitation => !citation.kind || citation.kind === "document";
    const inlineCitationTargets: Citation[] = [];
    const citationHistory: CitationHistory = {
        seen: new Set(),
        previous: null,
    };
    const citationsByRef = new Map<number, Citation>();
    const documentCitations = new Map<string, Citation>();
    for (const citation of citations) {
        if (!citationsByRef.has(citation.ref))
            citationsByRef.set(citation.ref, citation);
        if (
            isDocumentCitation(citation) &&
            !documentCitations.has(citation.filename)
        )
            documentCitations.set(citation.filename, citation);
    }
    const caseCitations = new Map<string, EventOf<"case_citation">>();
    const caseOpinions = new Map<number, EventOf<"case_opinions">["case"]>();
    const rawActivityEntries: { event: AssistantEvent; index: number }[] = [];
    const automationByRun = new Map<string, EventOf<"automation_run">>();
    const dialogueEntries: (
        | { role: "assistant"; index: number; text: string }
        | { role: "user"; index: number; text: string }
    )[] = [];
    const latestEditedByDoc = new Map<string, EventOf<"doc_edited">>();
    const createdDownloads: EventOf<"doc_created">[] = [];
    const askResponses = new Map<number, EventOf<"ask_inputs_response">>();
    const edits: {
        annotation: EditAnnotation;
        filename: string;
        editMode: "manual" | "auto";
    }[] = [];
    const pendingEdits: typeof edits = [];
    let pendingAskIndex: number | undefined;
    let eventErrorMessage: string | undefined;
    for (const [index, event] of (events ?? []).entries()) {
        if (event.type === "error") {
            eventErrorMessage ??= event.message;
            continue;
        }
        if (event.type === "ask_inputs_response") {
            if (pendingAskIndex !== undefined) {
                askResponses.set(pendingAskIndex, event);
                pendingAskIndex = undefined;
            }
            continue;
        }
        if (event.type === "ask_inputs") pendingAskIndex = index;
        if (event.type === "case_citation") {
            const hrefKey = internalCaseHref(event.cluster_id);
            if (hrefKey) caseCitations.set(hrefKey, event);
            continue;
        }
        if (event.type === "case_opinions") {
            caseOpinions.set(event.cluster_id, event.case);
            continue;
        }
        if (event.type === "automation_run") {
            const key = automationRunKey(event);
            automationByRun.set(key, {
                ...automationByRun.get(key),
                ...event,
            });
            rawActivityEntries.push({ event, index });
            continue;
        }
        if (event.type === "content") {
            dialogueEntries.push({
                role: "assistant",
                index,
                text: preprocessCitations(
                    event.text,
                    citationsByRef,
                    inlineCitationTargets,
                    citationHistory,
                ),
            });
            continue;
        }
        if (event.type === "steering") {
            dialogueEntries.push({ role: "user", index, text: event.text });
            continue;
        }
        if (event.type === "doc_edited" && !event.isStreaming) {
            if (event.download_url)
                latestEditedByDoc.set(event.document_id, event);
            for (const annotation of event.annotations) {
                const edit = {
                    annotation,
                    filename: event.filename,
                    editMode: event.edit_mode,
                };
                edits.push(edit);
                if (
                    (resolvedEditStatuses?.[annotation.edit_id] ??
                        annotation.status) === "pending"
                )
                    pendingEdits.push(edit);
            }
        } else if (event.type === "doc_created" && event.download_url) {
            createdDownloads.push(event);
        }
        if (event.type !== "reasoning" || event.text.trim())
            rawActivityEntries.push({ event, index });
    }
    const handleCopy = async () => {
        try {
            let html = "";
            let plainText = "";
            if (contentDivRef.current) {
                const clone = contentDivRef.current.cloneNode(true) as HTMLElement;
                const externalHref = (value: string | null | undefined) => {
                    if (!value) return null;
                    try {
                        const url = new URL(value, window.location.href);
                        if (!/^https?:$/u.test(url.protocol)) return null;
                        if (
                            url.origin === window.location.origin ||
                            ["localhost", "127.0.0.1", "::1"].includes(
                                url.hostname,
                            )
                        )
                            return null;
                        return url.href;
                    } catch {
                        return null;
                    }
                };
                let previousCitation: HTMLElement | null = null;
                let previousSource = "";
                clone.querySelectorAll("[data-citation-ref]").forEach((el) => {
                    const citation = citationsByRef.get(
                        Number(el.getAttribute("data-citation-ref")),
                    );
                    const source = citation ? citationSourceKey(citation) : "";
                    if (
                        previousCitation?.parentElement === el.parentElement &&
                        (() => {
                            let node = previousCitation.nextSibling;
                            while (node && node !== el) {
                                if (
                                    node.nodeType !== Node.TEXT_NODE ||
                                    !/^[\s\u200b]*$/u.test(node.textContent ?? "")
                                )
                                    return false;
                                node = node.nextSibling;
                            }
                            return node === el;
                        })()
                    ) {
                        el.before(source === previousSource ? " " : "; ");
                    }
                    const href = citation
                        ? externalHref(
                              "url" in citation ? citation.url : null,
                          ) ?? externalHref(citation.external_url)
                        : null;
                    const replacement = document.createElement(
                        href ? "a" : "span",
                    );
                    if (href) replacement.setAttribute("href", href);
                    if (citation) {
                        const subsequent =
                            citation.display_form === "pinpoint" ||
                            citation.display_form === "supra";
                        const pinpoint = citationPinpoint(citation);
                        const parts = subsequent
                            ? {
                                  styleOfCause: null,
                                  rest: `${
                                      "citation" in citation && citation.citation
                                          ? citation.citation
                                          : formatCitationPage(citation)
                                  }${pinpoint ? ` at ${pinpoint}` : ""}`,
                              }
                            : citationPillParts(citation);
                        if (parts.styleOfCause) {
                            const style = document.createElement("em");
                            style.textContent = parts.styleOfCause;
                            replacement.append(style);
                        }
                        const rest = document.createElement("span");
                        rest.textContent = parts.rest;
                        replacement.append(rest);
                    } else {
                        replacement.innerHTML = el.innerHTML;
                    }
                    el.replaceWith(replacement);
                    previousCitation = replacement;
                    previousSource = source;
                });
                clone.querySelectorAll<HTMLAnchorElement>("a").forEach((link) => {
                    const href = externalHref(link.getAttribute("href"));
                    if (href) {
                        link.href = href;
                        return;
                    }
                    const span = document.createElement("span");
                    span.innerHTML = link.innerHTML;
                    link.replaceWith(span);
                });
                const fontFamily = '"Times New Roman", Times, serif';
                for (const el of [
                    clone,
                    ...clone.querySelectorAll<HTMLElement>("*"),
                ]) {
                    el.style.background = "transparent";
                    el.style.color = "#000000";
                    el.style.fontFamily = fontFamily;
                }
                clone.querySelectorAll<HTMLAnchorElement>("a").forEach((link) => {
                    for (const el of [
                        link,
                        ...link.querySelectorAll<HTMLElement>("*"),
                    ])
                        el.style.color = "#0000ee";
                    link.style.textDecoration = "underline";
                });
                html = clone.outerHTML;
                plainText = (clone.textContent || "").replaceAll("\u200b", "");
            }
            await navigator.clipboard.write([
                new ClipboardItem({
                    "text/html": new Blob([html], { type: "text/html" }),
                    "text/plain": new Blob([plainText], {
                        type: "text/plain",
                    }),
                }),
            ]);
            setIsCopied(true);
            setTimeout(() => setIsCopied(false), 2000);
        } catch {
        }
    };
    const activityRows = [];
    let activityIsStreaming = isStreaming;
    for (const entry of dedupeActivityEntries(rawActivityEntries)) {
        if (entry.event.type === "automation_run") continue;
        const view = activityView(entry.event, {
            response:
                entry.event.type === "ask_inputs"
                    ? askResponses.get(entry.index)
                    : undefined,
            caseCitations,
            events,
            index: entry.index,
        });
        if (!view) continue;
        activityRows.push({ ...entry, view });
        activityIsStreaming ||= !!view.busy;
    }
    const activityClick = (event: AssistantEvent) => {
        if (
            event.type === "subagent_run" &&
            event.status !== "running" &&
            onSubagentClick
        ) {
            return () => onSubagentClick(event);
        }
        if (event.type === "workflow_applied" && onWorkflowClick)
            return () => onWorkflowClick(event.workflow_id);
        if (event.type !== "doc_read" || event.isStreaming) return;
        const citation = documentCitations.get(event.filename);
        return citation && onCitationClick
            ? () => onCitationClick(citation)
            : undefined;
    };
    const editCards = edits.map(({ annotation, filename, editMode }, index) => {
        const changeNumber = index + 1;
        return (
            <EditCard
                key={`editcard-${annotation.edit_id}`}
                annotation={annotation}
                automatic={editMode === "auto"}
                changeNumber={changeNumber}
                resolvedStatus={resolvedEditStatuses?.[annotation.edit_id]}
                isReloading={
                    isStreaming ||
                    (isEditReloading?.(annotation.edit_id) ?? false)
                }
                onViewClick={(item) =>
                    onEditViewClick?.(item, filename, changeNumber)
                }
                onResolveStart={onEditResolveStart}
                onResolved={handleEditResolved}
                onError={onEditError}
            />
        );
    });
    const documentCount = new Set(
        edits.map(({ annotation }) => annotation.document_id),
    ).size;
    const automaticEdits =
        edits.length > 0 && edits.every(({ editMode }) => editMode === "auto");
    const downloadBlock = (
        event: EventOf<"doc_edited"> | EventOf<"doc_created">,
        key?: string | number,
    ) => {
        const edited = event.type === "doc_edited";
        const documentId = event.document_id;
        const onOpen =
            onOpenDocument && documentId
                ? () =>
                      onOpenDocument({
                          documentId,
                          filename: event.filename,
                          versionId: event.version_id ?? null,
                          versionNumber: event.version_number ?? null,
                      })
                : edited && onEditViewClick && event.annotations[0]
                  ? () => onEditViewClick(event.annotations[0], event.filename)
                  : undefined;
        return (
            <DocDownloadBlock
                key={key}
                filename={event.filename}
                download_url={
                    edited
                        ? resolvedOverrides[event.document_id] ??
                          event.download_url
                        : event.download_url
                }
                versionNumber={event.version_number ?? null}
                onOpen={onOpen}
                isReloading={
                    edited
                        ? (isDocReloading?.(event.document_id) ?? false)
                        : false
                }
            />
        );
    };
    const responseError =
        errorMessage ??
        eventErrorMessage ??
        (isError ? "Response failed." : null);
    const lastAssistantDialogue = dialogueEntries.findLastIndex(
        (entry) => entry.role === "assistant",
    );
    return (
        <div style={{ minHeight }} className="w-full max-w-[46rem]">
            <div className="relative mt-2 w-full font-inter">
                {(events?.length || isStreaming) ? (
                    <div className="flex flex-col gap-4">
                        {[...automationByRun.values()].map((event) => (
                            <AutomationRunButton
                                key={automationRunKey(event)}
                                run={event}
                                onOpen={onAutomationClick ?? (() => undefined)}
                            />
                        ))}
                        {activityRows.length > 0 ? (
                            <ActivityDisclosure
                                isStreaming={activityIsStreaming}
                                label={
                                    activityRows[activityRows.length - 1]?.view
                                        .label ?? "Thinking"
                                }
                            >
                                {activityRows.map(({ event, index, view }) => (
                                    <ActivityRow
                                        key={index}
                                        view={view}
                                        onClick={activityClick(event)}
                                        onSourceClick={onSubagentSourceClick}
                                    />
                                ))}
                            </ActivityDisclosure>
                        ) : isStreaming && automationByRun.size === 0 ? (
                            <ActivityDisclosure isStreaming label="Thinking" />
                        ) : null}
                        {dialogueEntries.map((entry, dialogueIndex) =>
                            entry.role === "user" ? (
                                <div
                                    key={`s-${entry.index}`}
                                    aria-label="Steering message"
                                    className="ml-auto w-fit max-w-[min(85%,42rem)] whitespace-pre-wrap rounded-[18px] bg-gray-200 px-4 py-2.5 text-base leading-6 text-gray-950"
                                >
                                    {entry.text}
                                </div>
                            ) : (
                                <div
                                    key={`c-${entry.index}`}
                                    className="w-fit max-w-full rounded-[18px] bg-gray-950 px-4 py-3 text-white shadow-sm"
                                >
                                    <MarkdownContent
                                        text={entry.text}
                                        inlineCitationTargets={inlineCitationTargets}
                                        caseCitations={caseCitations}
                                        caseOpinions={caseOpinions}
                                        onCitationClick={onCitationClick}
                                        citationTitle={citationTitle}
                                        onCaseClick={onCaseClick}
                                        divRef={
                                            dialogueIndex === lastAssistantDialogue
                                                ? contentDivRef
                                                : undefined
                                        }
                                    />
                                </div>
                            ),
                        )}
                        {editCards.length > 1 ? (
                            <EditCardsSection
                                pending={pendingEdits}
                                documentCount={documentCount}
                                cards={editCards}
                                resolvedCount={edits.length - pendingEdits.length}
                                automatic={automaticEdits}
                                disabled={isStreaming}
                                onViewClick={onEditViewClick}
                                onResolveStart={onEditResolveStart}
                                onResolved={handleEditResolved}
                                onError={onEditError}
                            />
                        ) : (
                            editCards
                        )}
                    </div>
                ) : null}
                {responseError && (
                    <p
                        role="alert"
                        aria-atomic="true"
                        className="mt-2 text-base font-serif leading-7 text-red-700"
                    >
                        {responseError}
                    </p>
                )}
                {!isStreaming &&
                    [...latestEditedByDoc.values()].map((event) => (
                        <div
                            key={`edited-download-${event.document_id}`}
                            className="flex flex-col gap-2 mt-2 mb-3"
                        >
                            {downloadBlock(event)}
                        </div>
                    ))}
                {!isStreaming && createdDownloads.length > 0 && (
                    <div className="flex flex-col gap-2 mt-2 mb-3">
                        {createdDownloads.map((event, index) =>
                            downloadBlock(event, index),
                        )}
                    </div>
                )}
                {showCopyAction && (
                    <div className="flex items-center gap-2 py-2 font-sans justify-start">
                    {!isStreaming && (
                        <button
                            type="button"
                            className="p-1.5 rounded text-gray-500 hover:text-gray-700 hover:bg-gray-100"
                            onClick={handleCopy}
                            title={isCopied ? "Response copied" : "Copy response"}
                            aria-label={isCopied ? "Response copied" : "Copy response"}
                        >
                            {isCopied ? (
                                <Check aria-hidden="true" className="h-3.5 w-3.5 text-green-600" />
                            ) : (
                                <Copy aria-hidden="true" className="h-3.5 w-3.5" />
                            )}
                        </button>
                    )}
                    </div>
                )}
            </div>
        </div>
    );
}
