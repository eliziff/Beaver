import { memo } from "react";
import { AlertCircle } from "lucide-react";
import type { ColumnConfig, TabularCell as TCell } from "@/app/lib/api/tabular";
import type { Citation } from "@/app/lib/citations";
import { groundedAnswerMarkdown } from "@/app/lib/groundedAnswers";
import { SkeletonLine } from "../shared/TablePrimitive";
import { TabularMarkdown } from "./TabularMarkdown";

interface Props {
    cell: TCell;
    column?: ColumnConfig;
    onExpand: (cell: TCell) => void;
    onCitationClick: (cell: TCell, citation: Citation) => void;
}

const FLAG_STYLES = {
    green: "bg-green-500",
    grey: "bg-gray-400",
    yellow: "bg-amber-400",
    red: "bg-red-500",
} as const;

export const TabularCell = memo(function TabularCell({
    cell,
    column,
    onExpand,
    onCitationClick,
}: Props) {
    if (cell.status === "generating") {
        return (
            <div className="flex h-8 items-center px-2">
                <SkeletonLine className="h-3.5 w-full" />
            </div>
        );
    }
    if (cell.status === "error") {
        return (
            <div className="flex h-8 items-center justify-center text-gray-300">
                <AlertCircle className="h-4 w-4 text-red-300" />
            </div>
        );
    }
    if (!cell.content?.summary) return <div className="h-8" />;

    const { citations } = groundedAnswerMarkdown(cell.content);
    const firstLine =
        cell.content.summary.split("\n").find((line) => line.trim()) ?? cell.content.summary;
    return (
        <div
            className="group relative flex h-8 cursor-pointer items-center px-2 text-xs leading-relaxed text-gray-800 hover:bg-gray-50"
        >
            <button type="button" className="absolute inset-0 rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-gray-700"
                aria-label={`Open ${column?.name ?? "cell"} result`} onClick={() => onExpand(cell)} />
            {cell.content.flag && (
                <span
                    className={`absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full ${FLAG_STYLES[cell.content.flag]}`}
                    title={cell.content.flag}
                />
            )}
            <div className="pointer-events-none relative line-clamp-1 w-full min-w-0 [&_button]:pointer-events-auto [&_a]:pointer-events-auto">
                <TabularMarkdown
                    text={firstLine.replace(/^[-*•]\s+/, "") + (column?.format && ["yes_no", "tag", "currency"].includes(column.format)
                        ? "" : citations.map(({ ref }) => ` [${ref}]`).join(""))}
                    value={cell.content.value}
                    citations={citations}
                    column={column}
                    onCitationClick={(citation) => onCitationClick(cell, citation)}
                    inline
                />
            </div>
        </div>
    );
});
