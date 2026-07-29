import * as React from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/app/lib/utils";
type SearchBarSize = "sm" | "normal";
type SearchBarProps = Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    "onChange" | "size" | "type" | "value"
> & {
    value: string;
    onValueChange: (value: string) => void;
    size?: SearchBarSize;
    clearLabel?: string;
    wrapperClassName?: string;
    inputClassName?: string;
};
const sizeClasses: Record<
    SearchBarSize,
    { wrapper: string; input: string; icon: string; clear: string }
> = {
    sm: {
        wrapper: "h-8 gap-1.5 rounded-md px-2.5",
        input: "text-xs",
        icon: "h-3 w-3",
        clear: "h-5 w-5",
    },
    normal: {
        wrapper: "h-9 gap-2 rounded-md px-3",
        input: "text-sm",
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
            placeholder = "Search...",
            className,
            wrapperClassName,
            inputClassName,
            ...props
        },
        ref,
    ) => {
        const classes = sizeClasses[size];
        return (
            <div
                className={cn(
                    "flex min-w-0 items-center border border-gray-300 bg-white text-gray-700 focus-within:border-gray-500",
                    classes.wrapper,
                    className,
                    wrapperClassName,
                )}
            >
                <Search
                    className={cn(
                        "shrink-0 text-gray-400",
                        classes.icon,
                    )}
                />
                <input
                    ref={ref}
                    type="search"
                    value={value}
                    placeholder={placeholder}
                    onChange={(event) => onValueChange(event.target.value)}
                    className={cn(
                        "min-w-0 flex-1 bg-transparent text-gray-700 outline-none placeholder:text-gray-400 [&::-webkit-search-cancel-button]:hidden",
                        classes.input,
                        inputClassName,
                    )}
                    {...props}
                />
                {value ? (
                    <button
                        type="button"
                        onClick={() => onValueChange("")}
                        className={cn(
                            "flex shrink-0 items-center justify-center rounded text-gray-500 hover:bg-gray-100 hover:text-gray-800",
                            classes.clear,
                        )}
                        aria-label={clearLabel}
                    >
                        <X className={classes.icon} />
                    </button>
                ) : null}
            </div>
        );
    },
);
SearchBar.displayName = "SearchBar";
