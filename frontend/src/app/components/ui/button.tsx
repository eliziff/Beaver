import type { ComponentProps } from "react";
import { cn } from "@/app/lib/utils";
const BASE_BUTTON_CLASS =
    "inline-flex h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md px-4 py-2 text-sm font-medium disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 outline-none focus-visible:ring-3 focus-visible:ring-ring/50";
type ButtonProps = ComponentProps<"button"> & {
    variant?: "default" | "destructive" | "ghost" | "outline";
    size?: "default" | "icon-sm";
};
function Button({
    className,
    variant = "default",
    size = "default",
    ...props
}: ButtonProps) {
    const variantClass =
        variant === "destructive"
            ? "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20"
            : variant === "outline"
              ? "border border-gray-300 bg-white text-gray-800 hover:bg-gray-50"
              : variant === "ghost"
                ? "bg-transparent text-gray-700 hover:bg-gray-100"
                : "bg-primary text-primary-foreground hover:bg-primary/90";
    return (
        <button
            data-slot="button"
            className={cn(
                BASE_BUTTON_CLASS,
                variantClass,
                size === "icon-sm" && "h-8 w-8 p-0",
                className,
            )}
            {...props}
        />
    );
}
export { Button };
