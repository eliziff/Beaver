import { useState, type ClipboardEvent } from "react";
import { Check, Copy, Library } from "lucide-react";
import { FileTypeIcon } from "../shared/FileTypeIcon";
import { GfmMarkdown } from "./message/MarkdownContent";
interface Props {
    content: string;
    files?: { filename: string; document_id?: string }[];
    workflow?: { id: string; title: string };
}
export function UserMessage({ content, files, workflow }: Props) {
    const [copied, setCopied] = useState(false);
    const hasFiles = files && files.length > 0;
    const copyMessage = async () => {
        try {
            await navigator.clipboard.writeText(content);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
        } catch { /* Clipboard permission may be unavailable. */ }
    };
    const copySelection = (event: ClipboardEvent<HTMLDivElement>) => {
        const selected = window.getSelection()?.toString();
        if (!selected) return;
        event.preventDefault();
        event.clipboardData.setData(
            "text/plain",
            selected.replace(/\r\n/gu, "\n").replace(/\n{3,}/gu, "\n\n").trimEnd(),
        );
    };
    return (
        <div className="flex w-full justify-end">
            <div className="flex max-w-[min(85%,42rem)] flex-col items-end">
                <div
                    data-testid="user-message-bubble"
                    onCopy={copySelection}
                    className="w-fit rounded-[18px] bg-gray-200 px-4 py-2.5 text-gray-950"
                >
                    <div className="prose max-w-none text-base leading-6 text-gray-950 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_ol]:my-2 [&_p]:my-0 [&_p]:whitespace-pre-wrap [&_ul]:my-2">
                        <GfmMarkdown>{content}</GfmMarkdown>
                    </div>
                    {(workflow || hasFiles) && (
                        <div className="mt-3 flex flex-wrap justify-end gap-1.5">
                            {workflow && (
                                <div className="inline-flex items-center gap-1 rounded-full border border-gray-500 bg-gray-800 py-0.5 pl-2 pr-2.5 text-xs text-white">
                                    <Library className="h-2.5 w-2.5 shrink-0" />
                                    <span className="max-w-[140px] truncate">{workflow.title}</span>
                                </div>
                            )}
                            {hasFiles && files.map((f, i) => (
                                <div
                                    key={i}
                                    className="inline-flex items-center gap-1 rounded-[10px] border border-gray-300 bg-white py-0.5 pl-2 pr-2.5 text-xs text-gray-800"
                                >
                                    <FileTypeIcon fileType={f.filename} className="h-2.5 w-2.5" />
                                    <span className="max-w-[140px] truncate">{f.filename}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
                <button
                    type="button"
                    onClick={() => void copyMessage()}
                    title={copied ? "Message copied" : "Copy message"}
                    aria-label={copied ? "Message copied" : "Copy message"}
                    className="mt-1 grid size-8 place-items-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
                >
                    {copied ? (
                        <Check className="size-3.5 text-green-600" aria-hidden="true" />
                    ) : (
                        <Copy className="size-3.5" aria-hidden="true" />
                    )}
                </button>
            </div>
        </div>
    );
}
