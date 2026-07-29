"use client";
import { Library } from "lucide-react";
import { FileTypeIcon } from "../shared/FileTypeIcon";
import { GfmMarkdown } from "./message/MarkdownContent";
interface Props {
    content: string;
    files?: { filename: string; document_id?: string }[];
    workflow?: { id: string; title: string };
}
export function UserMessage({ content, files, workflow }: Props) {
    const hasFiles = files && files.length > 0;
    return (
        <div className="flex w-full justify-end">
            <div
                data-testid="user-message-bubble"
                className="w-fit max-w-[min(85%,42rem)] rounded-[18px] bg-gray-200 px-4 py-2.5 text-gray-950"
            >
                <div className="prose max-w-none text-base leading-6 text-gray-950 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_ol]:my-2 [&_p]:my-0 [&_p]:whitespace-pre-wrap [&_ul]:my-2">
                    <GfmMarkdown>{content}</GfmMarkdown>
                </div>
                {(workflow || hasFiles) && (
                    <div className="flex flex-wrap justify-end gap-1.5 mt-3">
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
        </div>
    );
}
