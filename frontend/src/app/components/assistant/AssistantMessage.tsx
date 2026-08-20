import { useRef, useState } from "react";
import { Check, Copy, Minimize2 } from "lucide-react";
import {
    type AutomationRunEvent,
    type Citation,
    type EditAnnotation,
    type EditResolveHandlers,
    type EditResolved,
    type ToolActivitySource,
} from "../shared/types";
import type {
    AssistantArtifact,
    AssistantMessageState,
} from "@/app/lib/assistantSession";
import { EditCard } from "./EditCard";
import {
    preprocessCitations,
    citationSourceKey,
    type CitationHistory,
} from "./message/citationUtils";
import { MarkdownContent } from "./message/MarkdownContent";
import { EditCardsSection } from "./message/EditCardsSection";
import { AutomationRunButton, automationRunKey } from "./AutomationRun";
import { ActivityDisclosure, ActivityRow, DocDownloadBlock } from "./message/EventBlocks";

interface Props {
    message: AssistantMessageState;
    isStreaming?: boolean;
    onCitationClick?: (citation: Citation) => void;
    citationTitle?: (citation: Citation) => string;
    showCopyAction?: boolean;
    onAutomationClick?: (run: AutomationRunEvent) => void;
    onReaderClick?: (readerId: string) => void;
    onSubagentSourceClick?: (source: ToolActivitySource) => void;
    minHeight?: string;
    onEditViewClick?: (ann: EditAnnotation, filename: string, changeNumber?: number) => void;
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

export function AssistantMessage({
    message,
    isStreaming = false,
    onCitationClick,
    citationTitle,
    showCopyAction = true,
    onAutomationClick,
    onReaderClick,
    onSubagentSourceClick,
    minHeight = "0px",
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
    const [resolvedOverrides, setResolvedOverrides] = useState<Record<string, string>>({});
    const handleEditResolved = (args: EditResolved) => {
        if (args.downloadUrl) {
            setResolvedOverrides((current) => ({ ...current, [args.documentId]: args.downloadUrl! }));
        }
        onEditResolved?.(args);
    };
    const inlineCitationTargets: Citation[] = [];
    const citationHistory: CitationHistory = { seen: new Set(), previous: null };
    const citationsByRef = new Map<number, Citation>();
    for (const citation of message.citations) {
        if (!citationsByRef.has(citation.ref)) citationsByRef.set(citation.ref, citation);
    }
    const dialogue = message.blocks.map((block) =>
        block.role === "assistant"
            ? {
                  ...block,
                  text: preprocessCitations(
                      block.text,
                      citationsByRef,
                      inlineCitationTargets,
                      citationHistory,
                  ),
              }
            : block,
    );
    const editedArtifacts = message.artifacts.filter(
        (artifact) => artifact.type === "edited",
    );
    const edits = editedArtifacts.flatMap((artifact) =>
        artifact.annotations.map((annotation) => ({
            annotation,
            filename: artifact.filename,
            editMode: artifact.editMode ?? "manual",
        })),
    );
    const pendingEdits = edits.filter(
        ({ annotation }) =>
            (resolvedEditStatuses?.[annotation.edit_id] ?? annotation.status) === "pending",
    );

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
                        if (url.origin === window.location.origin || ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return null;
                        return url.href;
                    } catch {
                        return null;
                    }
                };
                let previousCitation: HTMLElement | null = null;
                let previousSource = "";
                clone.querySelectorAll("[data-citation-ref]").forEach((element) => {
                    const citation = citationsByRef.get(Number(element.getAttribute("data-citation-ref")));
                    const source = citation ? citationSourceKey(citation) : "";
                    if (previousCitation?.parentElement === element.parentElement) {
                        let node = previousCitation.nextSibling;
                        let adjacent = true;
                        while (node && node !== element) {
                            if (node.nodeType !== Node.TEXT_NODE || !/^[\s\u200b]*$/u.test(node.textContent ?? "")) {
                                adjacent = false;
                                break;
                            }
                            node = node.nextSibling;
                        }
                        if (adjacent && node === element) element.before(source === previousSource ? " " : "; ");
                    }
                    const href = citation
                        ? externalHref("url" in citation ? citation.url : null) ?? externalHref(citation.external_url)
                        : null;
                    const replacement = document.createElement(href ? "a" : "span");
                    if (href) replacement.setAttribute("href", href);
                    replacement.append(...[...element.childNodes].map((node) => node.cloneNode(true)));
                    element.replaceWith(replacement);
                    previousCitation = replacement;
                    previousSource = source;
                });
                clone.querySelectorAll<HTMLAnchorElement>("a").forEach((link) => {
                    const href = externalHref(link.getAttribute("href"));
                    if (href) {
                        link.href = href;
                    } else {
                        const span = document.createElement("span");
                        span.append(...[...link.childNodes].map((node) => node.cloneNode(true)));
                        link.replaceWith(span);
                    }
                });
                const fontFamily = '"Times New Roman", Times, serif';
                for (const element of [clone, ...clone.querySelectorAll<HTMLElement>("*")]) {
                    element.style.background = "transparent";
                    element.style.color = "#000000";
                    element.style.fontFamily = fontFamily;
                }
                clone.querySelectorAll<HTMLAnchorElement>("a").forEach((link) => {
                    for (const element of [link, ...link.querySelectorAll<HTMLElement>("*")]) element.style.color = "#0000ee";
                    link.style.textDecoration = "underline";
                });
                html = clone.outerHTML;
                plainText = (clone.textContent || "").replaceAll("\u200b", "");
            }
            await navigator.clipboard.write([
                new ClipboardItem({
                    "text/html": new Blob([html], { type: "text/html" }),
                    "text/plain": new Blob([plainText], { type: "text/plain" }),
                }),
            ]);
            setIsCopied(true);
            setTimeout(() => setIsCopied(false), 2000);
        } catch {
            // Clipboard permissions are user-agent controlled.
        }
    };

    const activityClick = (activity: AssistantMessageState["activities"][number]) => {
        const action = activity.action;
        if (action?.type === "reader" && activity.status !== "running") {
            return onReaderClick ? () => onReaderClick(action.readerId) : undefined;
        }
        return undefined;
    };
    const editCards = edits.map(({ annotation, filename, editMode }, index) => (
        <EditCard
            key={annotation.edit_id}
            annotation={annotation}
            automatic={editMode === "auto"}
            changeNumber={index + 1}
            resolvedStatus={resolvedEditStatuses?.[annotation.edit_id]}
            isReloading={isStreaming || (isEditReloading?.(annotation.edit_id) ?? false)}
            onViewClick={(item) => onEditViewClick?.(item, filename, index + 1)}
            onResolveStart={onEditResolveStart}
            onResolved={handleEditResolved}
            onError={onEditError}
        />
    ));
    const documentCount = new Set(edits.map(({ annotation }) => annotation.document_id)).size;
    const automaticEdits = edits.length > 0 && edits.every(({ editMode }) => editMode === "auto");
    const downloadBlock = (artifact: AssistantArtifact) => {
        const onOpen = onOpenDocument && artifact.documentId
            ? () => onOpenDocument({
                  documentId: artifact.documentId!,
                  filename: artifact.filename,
                  versionId: artifact.versionId ?? null,
                  versionNumber: artifact.versionNumber ?? null,
              })
            : artifact.type === "edited" && onEditViewClick && artifact.annotations[0]
              ? () => onEditViewClick(artifact.annotations[0], artifact.filename)
              : undefined;
        return (
            <DocDownloadBlock
                key={artifact.id}
                filename={artifact.filename}
                download_url={
                    artifact.type === "edited" && artifact.documentId
                        ? resolvedOverrides[artifact.documentId] ?? artifact.downloadUrl
                        : artifact.downloadUrl
                }
                versionNumber={artifact.versionNumber ?? null}
                onOpen={onOpen}
                isReloading={artifact.type === "edited" && artifact.documentId ? isDocReloading?.(artifact.documentId) ?? false : false}
            />
        );
    };
    const lastAssistantBlock = dialogue.findLastIndex((block) => block.role === "assistant");
    const activityBusy = isStreaming || message.activities.some((activity) => activity.status === "running");
    return (
        <div style={{ minHeight }} className="w-full max-w-[46rem]">
            <div className="relative mt-2 w-full font-inter">
                {(message.contextCompacted || message.activities.length || message.automations.length || dialogue.length || edits.length || isStreaming) ? (
                    <div className="flex flex-col gap-4">
                        {message.automations.map((run) => (
                            <AutomationRunButton key={automationRunKey(run)} run={run} onOpen={onAutomationClick ?? (() => undefined)} />
                        ))}
                        {message.contextCompacted && (
                            <div role="status" className="flex items-center gap-2 px-1 font-serif text-sm text-gray-500">
                                <Minimize2 size={14} strokeWidth={1.75} aria-hidden="true" />
                                <span>Context compacted</span>
                            </div>
                        )}
                        {message.activities.length ? (
                            <ActivityDisclosure
                                isStreaming={activityBusy}
                                label={message.activities.at(-1)?.label ?? "Thinking"}
                            >
                                {message.activities.map((activity) => (
                                    <ActivityRow
                                        key={activity.id}
                                        activity={activity}
                                        onClick={activityClick(activity)}
                                        onSourceClick={onSubagentSourceClick}
                                    />
                                ))}
                            </ActivityDisclosure>
                        ) : isStreaming && !message.automations.length ? (
                            <ActivityDisclosure isStreaming label="Thinking" />
                        ) : null}
                        {dialogue.map((block, index) =>
                            block.role === "user" ? (
                                <div
                                    key={block.id}
                                    aria-label="Steering message"
                                    className="ml-auto w-fit max-w-[min(85%,42rem)] whitespace-pre-wrap rounded-[18px] bg-gray-200 px-4 py-2.5 text-base leading-6 text-gray-950"
                                >
                                    {block.text}
                                </div>
                            ) : (
                                <div key={block.id} className="w-fit max-w-full rounded-[18px] bg-gray-950 px-4 py-3 text-white shadow-sm">
                                    <MarkdownContent
                                        text={block.text}
                                        inlineCitationTargets={inlineCitationTargets}
                                        onCitationClick={onCitationClick}
                                        citationTitle={citationTitle}
                                        isStreaming={isStreaming}
                                        divRef={index === lastAssistantBlock ? contentDivRef : undefined}
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
                        ) : editCards}
                    </div>
                ) : null}
                {message.error && (
                    <p role="alert" aria-atomic="true" className="mt-2 font-serif text-base leading-7 text-red-700">
                        {message.error}
                    </p>
                )}
                {!isStreaming && message.artifacts.length > 0 && (
                    <div className="mt-2 mb-3 flex flex-col gap-2">
                        {message.artifacts.map(downloadBlock)}
                    </div>
                )}
                {showCopyAction && (
                    <div className="flex items-center justify-start gap-2 py-2 font-sans">
                        {!isStreaming && (
                            <button
                                type="button"
                                className="rounded p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
                                onClick={handleCopy}
                                title={isCopied ? "Response copied" : "Copy response"}
                                aria-label={isCopied ? "Response copied" : "Copy response"}
                            >
                                {isCopied ? <Check aria-hidden="true" className="h-3.5 w-3.5 text-green-600" /> : <Copy aria-hidden="true" className="h-3.5 w-3.5" />}
                            </button>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
