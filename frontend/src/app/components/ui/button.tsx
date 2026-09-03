import type { ComponentProps } from "react";
import { cn } from "@/app/lib/utils";
const BASE_BUTTON_CLASS =
    "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md border border-transparent font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0";
type ButtonVariant = "default" | "ghost" | "outline" | "danger";
type ButtonSize = "default" | "icon-sm" | "compact";
type ButtonOptions = {
    variant?: ButtonVariant;
    size?: ButtonSize;
    className?: string;
};
type ButtonProps = ComponentProps<"button"> & ButtonOptions;
const variantClasses: Record<ButtonVariant, string> = {
    default: "border-gray-950 bg-gray-950 text-white hover:bg-gray-800 disabled:hover:bg-gray-950",
    ghost: "bg-transparent text-gray-700 hover:bg-gray-100",
    outline: "border border-gray-300 bg-white text-gray-800 hover:bg-gray-50",
    danger: "border-red-600 bg-red-600 text-white hover:bg-red-700 disabled:hover:bg-red-600",
};
const sizeClasses: Record<ButtonSize, string> = {
    default: "h-9 px-4 text-sm",
    compact: "h-8 gap-1.5 px-2 text-xs",
    "icon-sm": "h-8 w-8 p-0",
};
export function buttonClassName({
    variant = "default", size = "default", className,
}: ButtonOptions = {}) {
    return cn(
        BASE_BUTTON_CLASS,
        variantClasses[variant],
        sizeClasses[size],
        className,
    );
}
function Button({ className, variant = "default", size, type = "button", ...props }: ButtonProps) {
    return (
        <button
            data-slot="button"
            type={type}
            className={buttonClassName({ variant, size, className })}
            {...props}
        />
    );
}
export { Button };
