import type { ColumnConfig } from "@/app/lib/api/tabular";

export const TAG_COLORS = ["bg-stone-100 text-stone-700", "bg-slate-100 text-slate-700", "bg-zinc-100 text-zinc-700"];
export function getPillClass(content: string, column?: Pick<ColumnConfig, "format" | "tags">): string {
    if (column?.format === "yes_no") {
        const value = content.toLowerCase();
        if (value === "yes") return "bg-green-50 text-green-800";
        if (value === "no") return "bg-red-50 text-red-800";
    }
    if (column?.format === "tag") {
        const index = column.tags?.findIndex((tag) => tag.toLowerCase() === content.toLowerCase()) ?? -1;
        if (index >= 0) return TAG_COLORS[index % TAG_COLORS.length]!;
    }
    return "bg-gray-100 text-gray-700";
}
