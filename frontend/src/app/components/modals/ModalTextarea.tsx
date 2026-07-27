"use client";

import { forwardRef, type TextareaHTMLAttributes } from "react";
import { cn } from "@/app/lib/utils";

type ModalTextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const ModalTextarea = forwardRef<
    HTMLTextAreaElement,
    ModalTextareaProps
>(({ className, ...props }, ref) => (
    <textarea
        ref={ref}
        className={cn(
            "min-h-24 w-full resize-y rounded-md border border-gray-300 bg-white px-3 py-2.5 text-sm leading-relaxed text-gray-900 outline-none placeholder:text-gray-500 focus:border-gray-600 disabled:cursor-not-allowed disabled:opacity-60",
            className,
        )}
        {...props}
    />
));

ModalTextarea.displayName = "ModalTextarea";
