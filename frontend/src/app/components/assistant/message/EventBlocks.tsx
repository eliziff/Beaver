import { createElement, useState, type ReactNode } from "react";
import {
    BadgeCheck,
    Bot,
    ChevronDown,
    Download,
    FilePlus2,
    Files,
    FileSearch,
    ListChecks,
    Loader2,
    Minimize2,
    Pencil,
    Search,
    Wrench,
} from "lucide-react";
import { ThinkingSpinner } from "@/app/components/chat/thinking-spinner";
import { apiBlobRequest } from "@/app/lib/beaverApi";
import { downloadBlob } from "@/app/lib/download";
import { RESPONSE_GLASS_SURFACE, withoutMarkdownNode } from "./messageStyles";
import {
    CitationPillMarkdown,
    GfmMarkdown,
} from "./MarkdownContent";
import {
    safeAssistantUrl,
    type AssistantActivity,
} from "@/app/lib/assistantSession";

function activityIcon(name: string) {
    if (name === "Grep" || /search|find|lookup/iu.test(name)) return Search;
    if (name === "Read" || /read|fetch/iu.test(name)) return FileSearch;
    if (name === "Edit" || /edit/iu.test(name)) return Pencil;
    if (/generate|created/iu.test(name)) return FilePlus2;
    if (name === "Glob") return Files;
    if (/workflow/iu.test(name)) return ListChecks;
    if (/subagent|delegate/iu.test(name)) return Bot;
    if (/verify|grounded/iu.test(name)) return BadgeCheck;
    if (name === "compaction") return Minimize2;
    return Wrench;
}

export function ActivityDisclosure({
    children,
    isStreaming,
    label,
}: {
    children?: ReactNode;
    isStreaming: boolean;
    label: string;
}) {
    const summary = `Activity — ${label}`;
    const status = (
        <span
            aria-hidden="true"
            className="grid size-4 shrink-0 place-items-center"
        >
            {isStreaming ? (
                <ThinkingSpinner size={14} />
            ) : (
                <span className="size-1.5 rounded-full bg-gray-400" />
            )}
        </span>
    );
    const content = (
        <>
            {status}
            <span className="min-w-0 truncate">
                <span className="text-gray-500">Activity</span>
                <span aria-hidden="true"> — </span>
                <span className="text-gray-700">{label}</span>
            </span>
        </>
    );
    if (children === undefined) {
        return (
            <div
                role="status"
                aria-label={summary}
                className="flex h-9 max-w-full items-center gap-2 px-1 font-serif text-sm text-gray-600"
            >
                {content}
            </div>
        );
    }
    return (
        <details className="group min-w-0" open>
            <summary
                role="button"
                aria-label={summary}
                className="flex h-9 max-w-full cursor-pointer list-none items-center gap-2 rounded-md px-1 font-serif text-sm text-gray-600 hover:text-gray-900 [&::-webkit-details-marker]:hidden"
            >
                {content}
                <ChevronDown
                    size={12}
                    className="shrink-0 -rotate-90 group-open:rotate-0"
                />
            </summary>
            <div
                role="list"
                className="ml-2 mt-1 flex flex-col gap-2.5 border-l border-gray-200 pb-1 pl-3"
            >
                {children}
            </div>
        </details>
    );
}

export function ActivityRow({
    activity,
    onClick,
    onSourceClick,
}: {
    activity: AssistantActivity;
    onClick?: () => void;
    onSourceClick?: (source: NonNullable<AssistantActivity["sources"]>[number]) => void;
}) {
    const busy = activity.status === "running";
    const failed = activity.status === "error";
    const label = `${activity.label}${busy && !activity.markdown ? "..." : ""}`;
    const labelNode = onClick || (activity.source && onSourceClick) ? (
        <button
            type="button"
            onClick={() => {
                if (activity.source) onSourceClick?.(activity.source);
                else onClick?.();
            }}
            className="text-left font-medium hover:text-gray-800"
        >
            {label}
        </button>
    ) : (
        <span className="font-medium">{label}</span>
    );
    return (
        <div
            role="listitem"
            className="flex min-w-0 items-start gap-2 font-serif text-sm text-gray-600"
        >
            <span className={`mt-0.5 grid size-4 shrink-0 place-items-center ${
                failed ? "text-red-600" : "text-gray-500"
            }`}>
                {busy ? (
                    <Loader2 size={14} strokeWidth={1.75} className="animate-spin" aria-hidden="true" />
                ) : (
                    createElement(activityIcon(activity.tool), {
                        size: 14, strokeWidth: 1.75, "aria-hidden": true,
                    })
                )}
            </span>
            <div className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">
                {activity.markdown ? (
                    <>
                        {activity.action?.type === "reader" && <div className="mb-1">{labelNode}</div>}
                        <div className="prose prose-sm max-w-none [&>*]:my-1 [&>*]:text-sm [&>*]:text-gray-600 [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-sm [&_h4]:text-sm">
                            {activity.sources ? (
                                <CitationPillMarkdown
                                    text={activity.markdown}
                                    sources={activity.sources}
                                    onSourceClick={onSourceClick}
                                />
                            ) : (
                                <GfmMarkdown
                                    components={{
                                        code: (props) => (
                                            <code
                                                className="font-serif text-gray-700"
                                                {...withoutMarkdownNode(props)}
                                            />
                                        ),
                                    }}
                                >
                                    {activity.markdown}
                                </GfmMarkdown>
                            )}
                        </div>
                    </>
                ) : (
                    labelNode
                )}
                {activity.detail && (
                    <p
                        className={`mt-0.5 text-xs ${
                            failed ? "text-red-600" : "text-gray-500"
                        }`}
                    >
                        {activity.detail}
                    </p>
                )}
                {!!activity.items?.length && (
                    <ul className="mt-1.5 max-h-48 space-y-1 overflow-y-auto pr-1 text-xs text-gray-600">
                        {activity.items.map((item, index) => {
                            const href = safeAssistantUrl(item.url, { relative: false });
                            return (
                            <li
                                key={`${item.label}-${index}`}
                                className={item.error ? "text-red-600" : ""}
                            >
                                {href ? (
                                    <a
                                        href={href}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="hover:underline"
                                    >
                                        {item.label}
                                    </a>
                                ) : (
                                    item.label
                                )}
                                {item.detail && (
                                    <span className="text-gray-500">
                                        {" "}
                                        — {item.detail}
                                    </span>
                                )}
                            </li>
                            );
                        })}
                    </ul>
                )}
            </div>
        </div>
    );
}

export function DocDownloadBlock({
    filename,
    download_url,
    onOpen,
    isReloading = false,
    versionNumber,
}: {
    filename: string;
    download_url: string;
    onOpen?: () => void;
    isReloading?: boolean;
    versionNumber?: number | null;
}) {
    const [busy, setBusy] = useState(false);
    const extMatch = filename.match(/\.(\w+)$/);
    const ext = extMatch?.[1].toUpperCase() ?? "FILE";
    const basename = extMatch
        ? filename.slice(0, -extMatch[0].length)
        : filename;
    const candidateHref = safeAssistantUrl(download_url);
    const href = candidateHref?.startsWith("/") ? candidateHref : null;
    const spinning = busy || isReloading;
    const handleDownload = async (event?: React.SyntheticEvent) => {
        event?.stopPropagation();
        event?.preventDefault();
        if (spinning || !href) return;
        setBusy(true);
        try {
            const { blob } = await apiBlobRequest(href);
            downloadBlob(blob, filename);
        } finally {
            setBusy(false);
        }
    };
    const body = (
        <div className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                    <p className="text-wrap font-serif text-base text-gray-900">
                        {basename}
                    </p>
                    {Number.isFinite(versionNumber) &&
                        Number(versionNumber) > 0 && (
                            <span className="shrink-0 rounded-md border border-gray-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-gray-500">
                                V{versionNumber}
                            </span>
                        )}
                </div>
                <p className="mt-0.5 text-xs text-gray-500">{ext}</p>
            </div>
        </div>
    );
    const icon = (
        <button
            type="button"
            disabled={spinning}
            onClick={handleDownload}
            className="flex shrink-0 cursor-pointer items-center bg-white/25 px-6 text-gray-500 hover:bg-white/55 hover:text-gray-700 disabled:cursor-not-allowed disabled:text-gray-400 disabled:hover:bg-white/25"
            aria-label={`Download ${filename}`}
        >
            {spinning ? (
                <Loader2 size={13} className="animate-spin" />
            ) : (
                <Download size={13} />
            )}
        </button>
    );
    return (
        <div
            className={`flex w-full items-stretch overflow-hidden font-sans ${RESPONSE_GLASS_SURFACE}`}
        >
            {onOpen || !spinning ? (
                <button
                    type="button"
                    onClick={onOpen ?? handleDownload}
                    className="flex min-w-0 flex-1 cursor-pointer items-stretch text-left hover:bg-white/45"
                >
                    {body}
                </button>
            ) : (
                body
            )}
            {icon}
        </div>
    );
}
