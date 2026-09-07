import type { ColumnConfig } from "@/app/lib/api/tabular";
export const TAG_COLORS = ["bg-gray-100 text-gray-700"];
export function getPillClass(content: string, column?: Pick<ColumnConfig, "format" | "tags">): string {
    if (column?.format === "yes_no") {
        if (content.toLowerCase() === "yes") return "bg-stone-100 text-stone-800";
        if (content.toLowerCase() === "no") return "bg-gray-100 text-gray-700";
    }
    return TAG_COLORS[0];
}
