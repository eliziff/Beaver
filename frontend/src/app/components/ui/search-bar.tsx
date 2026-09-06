import * as React from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/app/lib/utils";
import { HelpPopover } from "./help-popover";
type SearchBarSize = "sm" | "normal";
type SearchBarProps = Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    "onChange" | "size" | "type" | "value"
> & {
    value: string;
    onValueChange: (value: string) => void;
    size?: SearchBarSize;
    clearLabel?: string;
    clearable?: boolean;
    wrapperClassName?: string;
    inputClassName?: string;
    booleanSearch?: boolean;
    action?: React.ReactNode;
};

const sizeClasses: Record<
    SearchBarSize,
    { wrapper: string; input: string; icon: string; clear: string }
> = {
    sm: {
        wrapper: "h-8 gap-1.5 rounded-md px-2.5",
        input: "text-base sm:text-xs",
        icon: "h-3 w-3",
        clear: "h-5 w-5",
    },
    normal: {
        wrapper: "h-9 gap-2 rounded-md px-3",
        input: "text-base sm:text-sm",
        icon: "h-3.5 w-3.5",
        clear: "h-6 w-6",
    },
};
export const SearchBar = React.forwardRef<HTMLInputElement, SearchBarProps>(
    (
        {
            value,
            onValueChange,
            size = "normal",
            clearLabel = "Clear search",
            clearable = true,
            placeholder = "Search...",
            className,
            wrapperClassName,
            inputClassName,
            booleanSearch = false,
            action,
            ...props
        },
        ref,
    ) => {
        const classes = sizeClasses[size];
        return (
            <div
                className={cn(
                    "flex min-w-0 items-center border border-gray-300 bg-white text-gray-700 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
                    classes.wrapper,
                    className,
                    wrapperClassName,
                )}
            >
                <Search
                    aria-hidden="true"
                    className={cn(
                        "shrink-0 text-gray-400",
                        classes.icon,
                    )}
                />
                <input
                    ref={ref}
                    type="search" autoComplete="off"
                    value={value}
                    placeholder={placeholder}
                    onChange={(event) => onValueChange(event.target.value)}
                    className={cn(
                        "h-full min-w-0 flex-1 bg-transparent text-gray-700 outline-none placeholder:text-gray-400 [&::-webkit-search-cancel-button]:hidden",
                        classes.input,
                        inputClassName,
                    )}
                    {...props}
                />
                {clearable && value ? (
                    <button
                        type="button"
                        onClick={() => onValueChange("")}
                        className={cn(
                            "flex shrink-0 items-center justify-center rounded text-gray-500 hover:bg-gray-100 hover:text-gray-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900",
                            classes.clear,
                        )}
                        aria-label={clearLabel}
                    >
                        <X aria-hidden="true" className={classes.icon} />
                    </button>
                ) : null}
                {action}
                {booleanSearch && <HelpPopover label="Boolean search help">
                    <strong className="block text-gray-900">Search operators</strong>
                    <span className="block"><code>AND</code> or a space finds all terms.</span>
                    <span className="block"><code>OR</code> finds either term.</span>
                    <span className="block"><code>NOT</code> or <code>-</code> excludes the following term.</span>
                    <span className="block">Use <code>&quot;quotes&quot;</code> for a phrase, <code>*</code> after a word stem, and parentheses to group terms.</span>
                </HelpPopover>}
            </div>
        );
    },
);
SearchBar.displayName = "SearchBar";
