import { memo } from "react";
import { AlertCircle } from "lucide-react";
import type { ColumnConfig, TabularCell as TCell } from "../shared/types";
import { SkeletonLine } from "../shared/TablePrimitive";
import { parseTabularMarkdown, TabularMarkdown } from "./TabularMarkdown";

interface Props {
    cell: TCell;
    column?: ColumnConfig;
    onExpand: (cell: TCell) => void;
    onCitationClick: (
        cell: TCell,
        page: number | undefined,
        quote: string,
        citationRef: number,
        sheet?: string,
        citationCell?: string,
    ) => void;
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

    const parsed = parseTabularMarkdown(cell.content.summary);
    const firstLine =
        parsed.processed.split("\n").find((line) => line.trim()) ??
        parsed.processed;
    return (
        <div
            className="group relative flex h-8 cursor-pointer items-center px-2 text-xs leading-relaxed text-gray-800 hover:bg-gray-50"
            onClick={() => onExpand(cell)}
        >
            {cell.content.flag && (
                <span
                    className={`absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full ${FLAG_STYLES[cell.content.flag]}`}
                    title={cell.content.flag}
                />
            )}
            <div className="line-clamp-1 w-full min-w-0">
                <TabularMarkdown
                    parsed={{
                        ...parsed,
                        processed: firstLine.replace(/^[-*•]\s+/, ""),
                    }}
                    column={column}
                    onCitationClick={(citation, reference) =>
                        onCitationClick(
                            cell,
                            citation.page,
                            citation.quote,
                            reference,
                            citation.sheet,
                            citation.cell,
                        )
                    }
                    inline
                />
            </div>
        </div>
    );
});
