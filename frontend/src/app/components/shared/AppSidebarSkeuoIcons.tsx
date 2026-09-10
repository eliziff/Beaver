import type { HTMLAttributes } from "react";
type IconProps = HTMLAttributes<HTMLSpanElement>;
const makeIcon = (symbol: string) => ({ className, ...props }: IconProps) => (
    <span
        {...props}
        aria-hidden="true"
        className={`app-symbol-icon ${className ?? ""}`}
    >
        {symbol}
    </span>
);
export const ChatSkeuoIcon = makeIcon("✦\uFE0E");
export const LibrarySkeuoIcon = makeIcon("▤");
export const TabularReviewSkeuoIcon = makeIcon("▦");
export const WorkflowSkeuoIcon = makeIcon("⎇");
