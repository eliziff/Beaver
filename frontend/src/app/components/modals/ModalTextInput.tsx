"use client";
import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/app/lib/utils";
type ModalTextInputVariant = "glass" | "minimal";
type ModalTextInputProps = InputHTMLAttributes<HTMLInputElement> & {
    variant?: ModalTextInputVariant;
};
const variantClasses: Record<ModalTextInputVariant, string> = {
    glass: "h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none placeholder:text-gray-500 focus:border-gray-600 disabled:cursor-not-allowed disabled:opacity-60",
    minimal:
        "w-full bg-transparent font-serif text-2xl text-gray-800 outline-none placeholder:text-gray-300 disabled:cursor-not-allowed disabled:text-gray-400",
};
export const ModalTextInput = forwardRef<HTMLInputElement, ModalTextInputProps>(
    ({ className, variant = "glass", ...props }, ref) => (
        <input
            ref={ref}
            className={cn(variantClasses[variant], className)}
            {...props}
        />
    ),
);
ModalTextInput.displayName = "ModalTextInput";
