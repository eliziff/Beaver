"use client";

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
}: {
    label: string;
    items: NativeAction[];
    children: ReactNode;
    className?: string;
    triggerClassName?: string;
}) {
    return (
        <span className={cn("relative inline-flex", className)} title={label}>
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
                    {label}
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
