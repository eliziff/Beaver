import { useMemo, useState } from "react";
import type { ColumnConfig, TabularReview } from "@/app/lib/api/tabular";
import type { ResearchChange } from "@/app/lib/researchFiles";
import { Button } from "../ui/button";
import { ColumnList, type ColumnMark } from "./ColumnList";

const COLUMN_FIELD = /^columns_config\.(\d+)\.(\$|name|prompt|format|tags)$/u;
/** Column edits include the cell invalidations caused by changed questions. */
export const isColumnProposal = ({ changes }: ResearchChange) => changes.some(({ field }) => field === "columns_order" || COLUMN_FIELD.test(field)) &&
    changes.every(({ target, field, before, after }) => target === "table" ? field === "columns_order" || COLUMN_FIELD.test(field)
        : target === "result" && field === "$" && (after == null || (after as { status?: string }).status === "pending") &&
          changes.some((item) => item.field.startsWith(`columns_config.${((before ?? after) as { column_index?: number } | null)?.column_index}.`)));

function proposed(review: TabularReview, change: ResearchChange) {
    const saved = review.columns_config ?? [];
    const columns = new Map(saved.map((column) => [column.index, { ...column }]));
    const marks: Record<number, ColumnMark> = {};
    const order = change.changes.find(({ field }) => field === "columns_order");
    for (const item of change.changes) {
        const field = COLUMN_FIELD.exec(item.field);
        if (!field) continue;
        const index = Number(field[1]), value = (item.after ?? item.before) as ColumnConfig | null;
        if (field[2] === "$") {
            if (value) columns.set(index, { ...value, index });
            marks[index] = item.after == null ? "removed" : item.before == null ? "added" : "changed";
        } else {
            const column = columns.get(index);
            if (!column) continue;
            (column as Record<string, unknown>)[field[2]!] = item.after ?? undefined;
            marks[index] ??= field[2] === "name" ? "renamed" : field[2] as ColumnMark;
        }
    }
    const prior = (order?.before as number[] | undefined) ?? saved.map(({ index }) => index);
    const ordered = order?.after as number[] | undefined;
    const after = [...(ordered ?? prior).filter((index) => columns.has(index) && marks[index] !== "removed"),
        ...[...columns.keys()].filter((index) => marks[index] === "added" && !ordered?.includes(index))];
    const kept = prior.filter((index) => after.includes(index));
    after.filter((index) => prior.includes(index))
        .forEach((index, position) => { if (kept[position] !== index) marks[index] ??= "moved"; });
    const rows = after.map((index) => columns.get(index)!);
    for (const index of prior.filter((item) => marks[item] === "removed" && columns.has(item))) {
        const at = rows.findIndex((column) => prior.indexOf(column.index) > prior.indexOf(index));
        rows.splice(at < 0 ? rows.length : at, 0, columns.get(index)!);
    }
    return { rows, marks };
}

export function TableProposalReview({ review, change, busy, onAccept, onReject }: {
    review: TabularReview; change: ResearchChange; busy: boolean;
    onAccept: (columns: ColumnConfig[] | null) => void; onReject: () => void;
}) {
    const base = useMemo(() => proposed(review, change), [review, change]);
    const [columns, setColumns] = useState(base.rows);
    const [dropped, setDropped] = useState(() => new Set(base.rows
        .filter(({ index }) => base.marks[index] === "removed").map(({ index }) => index)));
    const [expanded, setExpanded] = useState<number | null>(null);
    const marks: Record<number, ColumnMark> = {};
    for (const { index } of columns) {
        const mark = dropped.has(index) ? "removed" : base.marks[index] === "removed" ? undefined : base.marks[index];
        if (mark) marks[index] = mark;
    }
    const final = columns.filter(({ index }) => !dropped.has(index));
    const edited = JSON.stringify(final) !== JSON.stringify(base.rows.filter(({ index }) => base.marks[index] !== "removed"));
    return <section aria-label="Proposed columns" className="space-y-2">
        {change.changes.some(({ target }) => target === "result") && <p className="text-xs text-gray-600">Changed questions need to be run again.</p>}
        <ColumnList columns={columns} marks={marks} expanded={expanded} onExpand={setExpanded}
            onChange={(updated) => setColumns((items) => items.map((item) => item.index === updated.index ? updated : item))}
            onRemove={({ index }) => setDropped((current) => {
                const next = new Set(current);
                if (!next.delete(index)) next.add(index);
                return next;
            })} />
        <div className="flex gap-2 pt-1">
            <Button size="compact" disabled={busy} onClick={() => onAccept(edited ? final : null)}>Accept changes</Button>
            <Button variant="outline" size="compact" disabled={busy} onClick={onReject}>Keep existing</Button>
        </div>
    </section>;
}
