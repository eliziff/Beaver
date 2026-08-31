import type { ComponentProps } from "react";
import { cn } from "@/app/lib/utils";
const BASE_BUTTON_CLASS =
    "inline-flex h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md px-4 py-2 text-sm font-medium disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 outline-none focus-visible:ring-3 focus-visible:ring-ring/50";
const COMPACT_BUTTON_CLASS =
    "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border font-medium outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-40";
type ButtonVariant = "default" | "destructive" | "ghost" | "outline" |
    "black" | "white" | "danger";
type ButtonSize = "default" | "icon-sm" | "compact" | "normal";
type ButtonOptions = {
    variant?: ButtonVariant;
    size?: ButtonSize;
    className?: string;
};
type ButtonProps = ComponentProps<"button"> & ButtonOptions;
const variantClasses: Record<ButtonVariant, string> = {
    default: "bg-primary text-primary-foreground hover:bg-primary/90",
    destructive: "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20",
    ghost: "bg-transparent text-gray-700 hover:bg-gray-100",
    outline: "border border-gray-300 bg-white text-gray-800 hover:bg-gray-50",
    black: "border-gray-950 bg-gray-950 text-white hover:bg-gray-800 disabled:hover:bg-gray-950",
    white: "border-gray-300 bg-white text-gray-800 hover:bg-gray-100 disabled:hover:bg-white",
    danger: "border-red-600 bg-red-600 text-white hover:bg-red-700 disabled:hover:bg-red-600",
};
export function buttonClassName({
    variant = "default", size, className,
}: ButtonOptions = {}) {
    const compact = variant === "black" || variant === "white" || variant === "danger";
    return cn(
        compact ? COMPACT_BUTTON_CLASS : BASE_BUTTON_CLASS,
        variantClasses[variant],
        compact
            ? (size === "normal" ? "px-4 py-1.5 text-sm" : "px-2 py-1 text-xs")
            : size === "icon-sm" && "h-8 w-8 p-0",
        className,
    );
}
function Button({ className, variant = "default", size, type, ...props }: ButtonProps) {
    const compact = variant === "black" || variant === "white" || variant === "danger";
    return (
        <button
            data-slot="button"
            type={type ?? (compact ? "button" : undefined)}
            className={buttonClassName({ variant, size, className })}
            {...props}
        />
    );
}
export { Button };
