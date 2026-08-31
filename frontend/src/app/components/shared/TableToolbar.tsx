import type { ReactNode } from "react";
import { TabList } from "@/app/components/ui/tabs";
interface ToolbarItem<T extends string> { id: T; label: string }
interface Props<T extends string> {
    items?: readonly ToolbarItem<T>[]; active?: T; onChange?: (id: T) => void;
    actions?: ReactNode; ariaLabel?: string;
}
export function TableToolbar<T extends string>({
    items = [],
    active,
    onChange,
    actions,
    ariaLabel = "Table filters",
}: Props<T>) {
    return <TabList value={active ?? items[0]?.id ?? ("" as T)}
        onValueChange={(id) => onChange?.(id)}
        options={items.map(({ id, label }) => ({ value: id, label }))}
        ariaLabel={ariaLabel} variant="pill" actions={actions}
        className="mx-4 mb-2 h-12 gap-2 py-2 md:mx-6" />;
}
