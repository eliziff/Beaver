import { useState, type ReactNode } from "react";
import { ChevronDown, Download, Loader2 } from "lucide-react";
import { ThinkingSpinner } from "@/app/components/chat/thinking-spinner";
import { apiFetch } from "@/app/lib/beaverApi";
import { downloadBlob } from "@/app/lib/download";
import { RESPONSE_GLASS_SURFACE, withoutMarkdownNode } from "./messageStyles";
import { GfmMarkdown } from "./MarkdownContent";
import type { ActivityView } from "./eventUtils";

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
        <details className="group min-w-0">
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
    view,
    onClick,
}: {
    view: ActivityView;
    onClick?: () => void;
}) {
    const label = `${view.label}${view.busy && !view.markdown ? "..." : ""}`;
    const labelNode = onClick ? (
        <button
            type="button"
            onClick={onClick}
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
            <span
                aria-hidden="true"
                className="mt-1.5 grid size-2 shrink-0 place-items-center"
            >
                {view.busy ? (
                    <span className="size-1.5 animate-spin rounded-full border border-gray-400 border-t-transparent" />
                ) : (
                    <span
                        className={`size-1.5 rounded-full ${
                            view.error ? "bg-red-500" : "bg-gray-400"
                        }`}
                    />
                )}
            </span>
            <div className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">
                {view.markdown ? (
                    <>
                        {view.panelAction && onClick && (
                            <button
                                type="button"
                                onClick={onClick}
                                className="mb-1 rounded text-xs font-medium text-gray-700 underline decoration-gray-300 underline-offset-2 hover:decoration-gray-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
                            >
                                Open panel
                            </button>
                        )}
                        <div className="prose prose-sm max-w-none [&>*]:my-1 [&>*]:text-sm [&>*]:text-gray-600">
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
                                {view.markdown}
                            </GfmMarkdown>
                        </div>
                    </>
                ) : (
                    labelNode
                )}
                {view.detail && (
                    <p
                        className={`mt-0.5 text-xs ${
                            view.error ? "text-red-600" : "text-gray-500"
                        }`}
                    >
                        {view.detail}
                    </p>
                )}
                {!!view.items?.length && (
                    <ul className="mt-1.5 max-h-48 space-y-1 overflow-y-auto pr-1 text-xs text-gray-600">
                        {view.items.map((item, index) => (
                            <li
                                key={`${item.label}-${index}`}
                                className={item.error ? "text-red-600" : ""}
                            >
                                {item.url ? (
                                    <a
                                        href={item.url}
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
                        ))}
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
    const href = download_url.startsWith("/") ? download_url : null;
    const spinning = busy || isReloading;
    const handleDownload = async (event?: React.SyntheticEvent) => {
        event?.stopPropagation();
        event?.preventDefault();
        if (spinning || !href) return;
        setBusy(true);
        try {
            const response = await apiFetch(href);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            downloadBlob(await response.blob(), filename);
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
