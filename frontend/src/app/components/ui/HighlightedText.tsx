import { Fragment, type ReactNode } from "react";
import { searchHighlightRanges } from "@/app/lib/searchHighlight";

export function HighlightedText({ text, query }: { text: string; query: string }) {
    const parts: ReactNode[] = [];
    let cursor = 0;
    for (const [start, end] of searchHighlightRanges(text, query)) {
        parts.push(<Fragment key={start}>{text.slice(cursor, start)}<mark className="bg-amber-200 text-gray-950">{text.slice(start, end)}</mark></Fragment>);
        cursor = end;
    }
    return <>{parts}{text.slice(cursor)}</>;
}
