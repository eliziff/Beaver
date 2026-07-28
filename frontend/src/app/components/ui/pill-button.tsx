import type { ComponentProps } from "react";
import { cn } from "@/app/lib/utils";

type PillButtonTone = "black" | "white" | "danger";
type PillButtonSize = "sm" | "normal";

type PillButtonProps = ComponentProps<"button"> & {
    tone: PillButtonTone;
    size?: PillButtonSize;
};

const toneClasses: Record<PillButtonTone, string> = {
    black: "border-gray-950 bg-gray-950 text-white hover:bg-gray-800 disabled:hover:bg-gray-950",
    white: "border-gray-300 bg-white text-gray-800 hover:bg-gray-100 disabled:hover:bg-white",
    danger: "border-red-600 bg-red-600 text-white hover:bg-red-700 disabled:hover:bg-red-600",
};

const sizeClasses: Record<PillButtonSize, string> = {
    sm: "px-2 py-1 text-xs",
    normal: "px-4 py-1.5 text-sm",
};

export function pillButtonClassName(
    tone: PillButtonTone,
    size: PillButtonSize = "sm",
    className?: string,
) {
    return cn(
        "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border font-medium outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-40",
        toneClasses[tone],
        sizeClasses[size],
        className,
    );
}

export function PillButton({
    tone,
    size = "sm",
    type = "button",
    className,
    ...props
}: PillButtonProps) {
    return (
        <button
            type={type}
            className={pillButtonClassName(tone, size, className)}
            {...props}
        />
    );
}
