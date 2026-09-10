import type { LucideIcon } from "lucide-react";
import { AlignLeft, List, Hash, DollarSign, ToggleLeft, Calendar, Tag, Percent, Banknote } from "lucide-react";
import type { ColumnFormat } from "@/app/lib/api/tabular";
export const FORMAT_OPTIONS: Array<{ value: ColumnFormat; label: string; icon: LucideIcon }> = [
    { value: "text",            label: "Free Text",       icon: AlignLeft },
    { value: "bulleted_list",   label: "Bulleted list",   icon: List },
    { value: "number",          label: "Number",          icon: Hash },
    { value: "percentage",      label: "Percentage",      icon: Percent },
    { value: "monetary_amount", label: "Monetary Amount", icon: Banknote },
    { value: "currency",        label: "Currency",        icon: DollarSign },
    { value: "yes_no",          label: "Yes / No",        icon: ToggleLeft },
    { value: "date",            label: "Date",            icon: Calendar },
    { value: "tag",             label: "Tags",            icon: Tag },
];
