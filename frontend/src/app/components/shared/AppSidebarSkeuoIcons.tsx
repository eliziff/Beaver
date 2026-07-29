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
export function ChatSkeuoIcon(props: IconProps) {
    return <AppSymbol symbol={"✦\uFE0E"} {...props} />;
}
export function LibrarySkeuoIcon(props: IconProps) {
    return <AppSymbol symbol="▤" {...props} />;
}
export function TabularReviewSkeuoIcon(props: IconProps) {
    return <AppSymbol symbol="▦" {...props} />;
}
export function TableOfAuthoritiesSkeuoIcon(props: IconProps) {
    return <AppSymbol symbol={"⚖\uFE0E"} {...props} />;
}
export function WorkflowSkeuoIcon(props: IconProps) {
    return <AppSymbol symbol="⎇" {...props} />;
}
export function QuickActionsSkeuoIcon(props: IconProps) {
    return <AppSymbol symbol={"⚡\uFE0E"} {...props} />;
}
