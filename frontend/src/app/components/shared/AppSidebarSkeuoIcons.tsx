import type { HTMLAttributes } from "react";
type IconProps = HTMLAttributes<HTMLSpanElement>;
function AppSymbol({
    symbol,
    className,
    ...props
}: IconProps & { symbol: string }) {
    return (
        <span
            {...props}
            aria-hidden="true"
            className={`app-symbol-icon ${className ?? ""}`}
        >
            {symbol}
        </span>
    );
}
const makeIcon = (symbol: string) => (props: IconProps) => (
    <AppSymbol symbol={symbol} {...props} />
);
export const ChatSkeuoIcon = makeIcon("✦\uFE0E");
export const LibrarySkeuoIcon = makeIcon("▤");
export const TabularReviewSkeuoIcon = makeIcon("▦");
export const TableOfAuthoritiesSkeuoIcon = makeIcon("⚖\uFE0E");
export const WorkflowSkeuoIcon = makeIcon("⎇");
