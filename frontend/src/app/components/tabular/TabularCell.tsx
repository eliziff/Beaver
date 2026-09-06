import { memo } from "react";
import { AlertCircle } from "lucide-react";
import type { ColumnConfig, TabularCell as TCell } from "@/app/lib/api/tabular";
import type { Citation } from "@/app/lib/citations";
import { groundedAnswerMarkdown } from "@/app/lib/groundedAnswers";
import { cn } from "@/app/lib/utils";
import { FlagDot } from "../shared/GroundedAnswerContent";
import { SkeletonLine } from "../shared/TablePrimitive";
import { NUMERIC_FORMATS, TabularMarkdown } from "./TabularMarkdown";

interface Props {
    cell: TCell;
    column?: ColumnConfig;
    onExpand: (cell: TCell) => void;
    onCitationClick: (cell: TCell, citation: Citation) => void;
}

export const TabularCell = memo(function TabularCell({ cell, column, onExpand, onCitationClick }: Props) {
    const answer = cell.content;
    const citations = answer ? groundedAnswerMarkdown(answer).citations : [];
    const numeric = !!column?.format && NUMERIC_FORMATS.has(column.format);
    const text = (answer?.summary || answer?.claims[0]?.text || "").replace(/^[-*•]\s+/u, "");
    return <div className={cn("group relative flex h-full min-w-0 items-center gap-1.5 px-2.5 text-[13px] leading-4 text-gray-800",
        "whitespace-normal hover:bg-gray-50 focus-within:bg-gray-50", numeric ? "text-right" : "text-left")}>
        <button type="button" className="absolute inset-0 focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-gray-700"
            aria-label={`Open ${column?.name ?? "cell"} result`} onClick={() => onExpand(cell)} />
        {cell.status === "generating" ? <SkeletonLine className="relative h-3 w-2/3 animate-pulse motion-reduce:animate-none" />
            : cell.status === "error" ? <span role="img" aria-label="Failed" title="Failed. Open the cell to regenerate it."
                className="relative text-red-600"><AlertCircle aria-hidden="true" className="size-3.5" /></span>
            : cell.status === "pending" || !answer ? null
            : answer.outcome === "not_found" ? <span aria-label="Not found" className="relative text-gray-400">—</span>
            : <>
                <div className={cn("pointer-events-none relative line-clamp-2 min-w-0 flex-1 [overflow-wrap:anywhere] [&_a]:pointer-events-auto",
                    numeric && "tabular-nums")}>
                    <TabularMarkdown text={text} value={answer.value} column={column}
                        onCitationClick={(citation) => onCitationClick(cell, citation)} inline />
                </div>
                {(answer.flag || !!citations.length) && <span className="relative flex shrink-0 items-center gap-1.5">
                    {answer.flag && <FlagDot flag={answer.flag} />}
                    {!!citations.length && <button type="button" onClick={() => onCitationClick(cell, citations[0]!)}
                        aria-label={`${citations.length} citation${citations.length === 1 ? "" : "s"}`}
                        title={`${citations.length} citation${citations.length === 1 ? "" : "s"}${answer.coverage === "partial" ? " · partial coverage" : ""}`}
                        className={cn("min-w-5 rounded border px-1 text-[10px] font-medium leading-4 tabular-nums hover:bg-white",
                            answer.coverage === "partial" ? "border-amber-300 bg-amber-50 text-amber-800" : "border-gray-300 bg-gray-50 text-gray-600")}>
                        {citations.length}
                    </button>}
                </span>}
            </>}
    </div>;
});
