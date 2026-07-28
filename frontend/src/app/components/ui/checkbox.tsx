"use client";

import {
    forwardRef,
    type InputHTMLAttributes,
} from "react";
import { cn } from "@/app/lib/utils";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type">;

export const CheckboxInput = forwardRef<HTMLInputElement, Props>(
    function CheckboxInput({ className, ...props }, ref) {
        return (
            <input
                ref={ref}
                type="checkbox"
                className={cn(
                    "h-[18px] w-[18px] shrink-0 cursor-pointer rounded border-gray-500 accent-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2 disabled:cursor-default disabled:opacity-50",
                    className,
                )}
                {...props}
            />
        );
    },
);

export const CheckboxControl = forwardRef<HTMLInputElement, Props>(
    function CheckboxControl({ className, disabled, ...props }, ref) {
        return (
            <label
                className={cn(
                    "inline-flex min-h-9 min-w-9 shrink-0 items-center justify-center",
                    disabled && "cursor-default",
                    className,
                )}
            >
                <CheckboxInput ref={ref} disabled={disabled} {...props} />
            </label>
        );
    },
);
