import type { LucideIcon } from "lucide-react";
import { AlignLeft, List, Hash, DollarSign, ToggleLeft, Calendar, Tag, Percent, Banknote } from "lucide-react";
import type { ColumnFormat } from "@/app/lib/api/tabular";
export const FORMAT_OPTIONS: Array<{ value: ColumnFormat; label: string; icon: LucideIcon; iconClassName: string }> = [
    { value: "text",            label: "Free Text",       icon: AlignLeft,  iconClassName: "text-gray-500"     },
    { value: "bulleted_list",   label: "Bulleted list",   icon: List,       iconClassName: "text-gray-500"  },
    { value: "number",          label: "Number",          icon: Hash,       iconClassName: "text-gray-500"  },
    { value: "percentage",      label: "Percentage",      icon: Percent,    iconClassName: "text-gray-500" },
    { value: "monetary_amount", label: "Monetary Amount", icon: Banknote,   iconClassName: "text-gray-500" },
    { value: "currency",        label: "Currency",        icon: DollarSign, iconClassName: "text-gray-500"    },
    { value: "yes_no",          label: "Yes / No",        icon: ToggleLeft, iconClassName: "text-gray-500"   },
    { value: "date",            label: "Date",            icon: Calendar,   iconClassName: "text-gray-500"    },
    { value: "tag",             label: "Tags",            icon: Tag,        iconClassName: "text-gray-500"  },
];
export function formatLabel(format: ColumnFormat): string {
    return FORMAT_OPTIONS.find((o) => o.value === format)?.label ?? "Text";
}
