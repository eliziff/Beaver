"use client";

import * as React from "react";
import {
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuRadioItem,
} from "@/app/components/ui/dropdown-menu";
import { cn } from "@/app/lib/utils";
import { APP_SURFACE_HOVER_CLASS } from "@/app/components/ui/liquid-surface";

const LIQUID_DROPDOWN_CLASS =
    "rounded-2xl border border-gray-200 bg-app-surface shadow-lg";

const LIQUID_DROPDOWN_ITEM_CLASS =
    `min-w-0 cursor-pointer whitespace-normal break-normal text-xs leading-snug text-gray-600 transition-colors ${APP_SURFACE_HOVER_CLASS} focus:bg-app-surface-hover focus:text-gray-800`;

export function LiquidDropdownContent({
    className,
    ...props
}: React.ComponentProps<typeof DropdownMenuContent>) {
    return (
        <DropdownMenuContent
            className={cn(LIQUID_DROPDOWN_CLASS, className)}
            {...props}
        />
    );
}

export const LiquidDropdownSurface = React.forwardRef<
    HTMLDivElement,
    React.ComponentPropsWithoutRef<"div">
>(function LiquidDropdownSurface({ className, ...props }, ref) {
    return (
        <div
            ref={ref}
            className={cn(LIQUID_DROPDOWN_CLASS, className)}
            {...props}
        />
    );
});

export function LiquidDropdownItem({
    className,
    ...props
}: React.ComponentProps<typeof DropdownMenuItem>) {
    return (
        <DropdownMenuItem
            className={cn(LIQUID_DROPDOWN_ITEM_CLASS, className)}
            {...props}
        />
    );
}

export const LiquidDropdownButton = React.forwardRef<
    HTMLButtonElement,
    React.ComponentPropsWithoutRef<"button">
>(function LiquidDropdownButton({ className, type = "button", ...props }, ref) {
    return (
        <button
            ref={ref}
            type={type}
            className={cn(LIQUID_DROPDOWN_ITEM_CLASS, className)}
            {...props}
        />
    );
});

export function LiquidDropdownRadioItem({
    className,
    ...props
}: React.ComponentProps<typeof DropdownMenuRadioItem>) {
    return (
        <DropdownMenuRadioItem
            className={cn(LIQUID_DROPDOWN_ITEM_CLASS, className)}
            {...props}
        />
    );
}
