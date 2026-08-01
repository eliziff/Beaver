import { useMemo } from "react";
import { Loader2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useFetchSingleDoc } from "@/app/hooks/useFetchSingleDoc";

interface Props {
    documentId: string;
    versionId?: string | null;
    filename?: string | null;
    rounded?: boolean;
}

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdown"]);

/**
 * Plain text and Markdown.
 *
 * Markdown renders through the same `react-markdown` + `remark-gfm` pair the
 * assistant and tabular views already use, so tables, headings and lists look
 * the way they do everywhere else in the product and there is one Markdown
 * implementation rather than two.
 *
 * `.txt` stays verbatim in a `<pre>`. That is not laziness: a transcript or
 * an exported agreement is read against its own line structure, and the
 * offsets every citation indexes are measured on those exact bytes.
 */
export function TextView({ documentId, versionId, filename, rounded }: Props) {
    const { result, error, loading } = useFetchSingleDoc(documentId, versionId);
    const text = useMemo(() => {
        if (!result || result.type !== "text") return null;
        return new TextDecoder("utf-8").decode(result.buffer);
    }, [result]);

    if (loading) {
        return (
            <div
                className="flex h-full min-h-0 items-center justify-center text-sm text-gray-500"
                role="status"
            >
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading document…
            </div>
        );
    }
    if (error || text === null) {
        return (
            <div className="flex h-full min-h-0 items-center justify-center p-4 text-sm text-gray-600">
                This document could not be displayed.
            </div>
        );
    }
    const frame = `h-full min-h-0 overflow-auto bg-white p-4 ${
        rounded ? "rounded border border-gray-300" : ""
    }`;
    const extension = filename?.split(".").pop()?.toLowerCase() ?? "";
    if (MARKDOWN_EXTENSIONS.has(extension)) {
        return (
            <div className={`${frame} prose prose-sm max-w-none`}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
            </div>
        );
    }
    return (
        <pre
            className={`${frame} whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-gray-900`}
        >
            {text}
        </pre>
    );
}
