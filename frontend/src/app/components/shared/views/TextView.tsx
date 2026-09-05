import { createElement, useMemo, type ComponentProps, type ElementType } from "react";
import { Loader2 } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useDocumentFile } from "@/app/hooks/useDocumentFile";

interface Props {
    documentId: string;
    versionId?: string | null;
    filename?: string | null;
    rounded?: boolean;
}

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdown"]);

function styled<T extends ElementType>(tag: T, className: string) {
    return ({ node: _node, ...props }: ComponentProps<T> & { node?: unknown }) =>
        createElement(tag, { ...props, className });
}

const MARKDOWN_COMPONENTS: Components = {
    h1: styled("h1", "mb-5 text-2xl font-semibold tracking-tight"),
    h2: styled("h2", "mb-3 mt-7 text-xl font-semibold tracking-tight"),
    h3: styled("h3", "mb-2 mt-6 text-lg font-semibold"),
    p: styled("p", "mb-4"),
    ul: styled("ul", "mb-4 list-disc pl-6"),
    ol: styled("ol", "mb-4 list-decimal pl-6"),
    li: styled("li", "mb-1"),
    blockquote: styled("blockquote", "my-4 border-l-4 border-gray-300 pl-4 italic text-gray-700"),
    table: styled("table", "my-5 w-full border-collapse text-sm"),
    th: styled("th", "border-b border-gray-300 px-2 py-2 text-left font-semibold"),
    td: styled("td", "border-b border-gray-200 px-2 py-2 align-top"),
    a: ({ node: _node, href, children, ...props }) => href
        ? <a {...props} href={href} className={href.startsWith("/sources/view?")
            ? "not-prose mx-0.5 inline-flex rounded-md bg-red-800 px-2 py-0.5 align-baseline font-sans text-[13px] font-medium leading-5 text-white no-underline hover:bg-red-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700"
            : "font-medium text-red-800 underline decoration-red-300 underline-offset-2 hover:text-red-600"}>{children}</a>
        : <>{children}</>,
};

/** Plain text stays verbatim; Markdown gets semantic document styling. */
export function TextView({ documentId, versionId, filename, rounded }: Props) {
    const { result, error, loading } = useDocumentFile(documentId, versionId);
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
            <div className={`${frame} font-serif text-base leading-7 text-gray-950`}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}
                    components={MARKDOWN_COMPONENTS}>{text}</ReactMarkdown>
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
