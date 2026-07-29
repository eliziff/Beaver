import type { ReactNode } from "react";
import { cn } from "@/app/lib/utils";
export type NativeAction = {
    label: string;
    onSelect: () => void;
    disabled?: boolean;
};
export function NativeActionSelect({
    label,
    items,
    children,
    className,
    triggerClassName,
    placeholder = label,
}: {
    label: string;
    items: NativeAction[];
    children: ReactNode;
    className?: string;
    triggerClassName?: string;
    placeholder?: string;
}) {
    if (process.env.NODE_ENV !== "production" && items.length > 8) {
        throw new Error(
            "NativeActionSelect only supports fixed lists of eight items or fewer.",
        );
    }
    return (
        <span
            className={cn("relative inline-flex shrink-0", className)}
            title={label}
        >
            <select
                aria-label={label}
                defaultValue=""
                disabled={items.every((item) => item.disabled)}
                className="peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0 disabled:cursor-default"
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => {
                    event.stopPropagation();
                    const item = items[Number(event.currentTarget.value)];
                    event.currentTarget.value = "";
                    if (!item?.disabled) item?.onSelect();
                }}
            >
                <option value="" disabled>
                    {placeholder}
                </option>
                {items.map((item, index) => (
                    <option
                        key={`${item.label}-${index}`}
                        value={index}
                        disabled={item.disabled}
                    >
                        {item.label}
                    </option>
                ))}
            </select>
            <span
                aria-hidden="true"
                className={cn(
                    "pointer-events-none inline-flex peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-gray-500",
                    triggerClassName,
                )}
            >
                {children}
            </span>
        </span>
    );
}
