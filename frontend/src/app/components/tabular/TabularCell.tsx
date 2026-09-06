import { memo } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import type { ColumnConfig, TabularCell as TCell } from "@/app/lib/api/tabular";
import type { Citation } from "@/app/lib/citations";
import { groundedAnswerMarkdown } from "@/app/lib/groundedAnswers";
import { CitationPill } from "../assistant/message/MarkdownContent";
import { TabularMarkdown } from "./TabularMarkdown";

interface Props {
    cell: TCell;
    column?: ColumnConfig;
    onExpand: (cell: TCell) => void;
    onCitationClick: (cell: TCell, citation: Citation) => void;
}
const FLAG_STYLES = { green: "bg-green-600", grey: "bg-gray-500", yellow: "bg-amber-500", red: "bg-red-600" };

export const TabularCell = memo(function TabularCell({ cell, column, onExpand, onCitationClick }: Props) {
    const answer = cell.content;
    const citations = answer ? groundedAnswerMarkdown(answer).citations : [];
    const status = cell.status === "generating" ? "Running" : cell.status === "error" ? "Failed"
        : cell.status === "pending" ? "Pending" : answer?.outcome === "not_found" ? "Not found" : null;
    return <div className="group relative flex h-20 min-w-0 flex-col justify-center gap-1 px-3 py-2 text-sm leading-5 text-gray-800 hover:bg-gray-50 focus-within:bg-gray-50">
        <button type="button" className="absolute inset-0 rounded-sm focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-gray-700"
            aria-label={`Open ${column?.name ?? "cell"} result`} onClick={() => onExpand(cell)} />
        {answer?.flag && <span aria-label={`${answer.flag} flag`} title={`${answer.flag} flag`}
            className={`pointer-events-none absolute end-2 top-2 size-2 rounded-full ${FLAG_STYLES[answer.flag]}`} />}
        {status ? <span className={`pointer-events-none relative flex items-center gap-1.5 ${cell.status === "error" ? "text-red-700" : "text-gray-500"}`}>
            {cell.status === "generating" && <Loader2 aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" />}
            {cell.status === "error" && <AlertCircle aria-hidden="true" className="size-3.5" />}{status}
        </span> : <div className="pointer-events-none relative line-clamp-2 min-w-0 [overflow-wrap:anywhere] [&_a]:pointer-events-auto">
            <TabularMarkdown text={(answer?.summary || answer?.claims[0]?.text || "No result").replace(/^[-*•]\s+/, "")}
                value={answer?.value} column={column} onCitationClick={(citation) => onCitationClick(cell, citation)} inline />
        </div>}
        {(!!citations.length || answer?.coverage === "partial") && <div className="pointer-events-none relative flex min-h-5 items-center gap-1 overflow-hidden whitespace-nowrap [&_button]:pointer-events-auto">
            {citations.slice(0, 3).map((citation) => <CitationPill key={citation.ref} citation={citation}
                onClick={(value) => onCitationClick(cell, value)} className="!text-xs !leading-4" />)}
            {citations.length > 3 && <span className="text-xs text-gray-500">+{citations.length - 3}</span>}
            {answer?.coverage === "partial" && <span className="ms-auto text-xs text-amber-800">Partial</span>}
        </div>}
    </div>;
});
