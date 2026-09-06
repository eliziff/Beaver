import { Fragment } from "react";
import { searchHighlightRanges } from "@/app/lib/searchHighlight";

export function HighlightedText({ text, query }: { text: string; query: string }) {
    let cursor = 0;
    const parts = searchHighlightRanges(text, query).map(([start, end]) => {
        const prefix = text.slice(cursor, start);
        cursor = end;
        return <Fragment key={start}>{prefix}<mark className="bg-amber-200 text-gray-950">{text.slice(start, end)}</mark></Fragment>;
    });
    return <>{parts}{text.slice(cursor)}</>;
}
