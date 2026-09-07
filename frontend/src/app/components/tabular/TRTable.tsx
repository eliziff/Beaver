import { Fragment, useEffect, useMemo, useRef } from "react";
import { Loader2 } from "lucide-react";
import type { ColumnConfig, TabularCell, TabularDocument } from "@/app/lib/api/tabular";
import type { Citation } from "@/app/lib/citations";
import { cn } from "@/app/lib/utils";
import { TabularCell as TabularCellComponent } from "./TabularCell";
import { FORMAT_OPTIONS } from "./columnFormat";
import {
    SkeletonLine,
    TableBody,
    TableCell,
    TableEmptyState,
    TableHeaderCell,
    TableHeaderRow,
    TableLoadingRows,
    TableRow,
    TableScrollArea,
    TableSelectionCheckbox,
    TableStickyCell,
    useTableSelection,
} from "../shared/TablePrimitive";
import { FLAGS, FlagDot, type AnswerFlag } from "../shared/GroundedAnswerContent";
import { MoreActionsMenu } from "../shared/MoreActionsMenu";
import { Button } from "../ui/button";
import { HelpPopover } from "../ui/help-popover";
import { APP_SURFACE_ACTIVE_CLASS, APP_SURFACE_GROUP_HOVER_CLASS, APP_SURFACE_HOVER_CLASS } from "@/app/components/ui/liquid-surface";

const SKELETON_COLS = 4;
const SKELETON_ROWS = 5;
const COLUMN_WIDTH = "w-[180px] sm:w-[220px] shrink-0";
const GRID_LINE = "border-b border-r border-gray-200";
const ROW = "h-12 w-max min-w-full pr-0 [contain-intrinsic-size:auto_48px]";
const STICKY = `sticky left-0 z-10 self-stretch bg-app-surface ${GRID_LINE}`;
const FILLER = "min-w-8 flex-1 self-stretch border-b border-gray-200";
interface Props {
    loading: boolean;
    columns: ColumnConfig[];
    documents: TabularDocument[];
    cells: TabularCell[];
    savingColumnsConfig: boolean;
    selectedDocIds: string[];
    uploadingFilenames?: string[];
    dragOverFiles?: boolean;
    highlightedCell?: { colIdx: number; rowIdx: number } | null;
    running?: boolean;
    onSelectionChange: (ids: string[]) => void;
    onExpand: (cell: TabularCell) => void;
    onCitationClick: (cell: TabularCell, citation: Citation) => void;
    onEditColumn: (col: ColumnConfig) => void;
    onRerunColumn?: (col: ColumnConfig) => void;
    onClearColumn?: (col: ColumnConfig) => void;
    onDeleteColumn?: (col: ColumnConfig) => void;
    onColumnLabels?: (col: ColumnConfig) => void;
    onAddColumns?: () => void;
    onAddDocuments?: () => void;
}
export function TRTable({
    loading, columns, documents, cells, savingColumnsConfig, selectedDocIds,
    uploadingFilenames = [], dragOverFiles = false, highlightedCell, running = false,
    onSelectionChange, onExpand, onCitationClick, onEditColumn, onRerunColumn, onClearColumn, onDeleteColumn,
    onColumnLabels, onAddColumns, onAddDocuments,
}: Props) {
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const sortedColumns = useMemo(() => [...columns].sort((a, b) => a.index - b.index), [columns]);
    const cellsByKey = useMemo(() => new Map(cells.map((cell) => [`${cell.document_id}:${cell.column_index}`, cell])), [cells]);
    const selection = useTableSelection(documents, selectedDocIds, onSelectionChange);
    useEffect(() => {
        if (!highlightedCell) return;
        const container = scrollContainerRef.current;
        if (!container) return;
        const targetRow = container.querySelectorAll<HTMLElement>("[data-tr-row]")[highlightedCell.rowIdx];
        if (targetRow) container.scrollTop = Math.max(0, targetRow.offsetTop - (container.querySelector("[data-tr-col-header]")?.clientHeight ?? 72));
        const headers = container.querySelectorAll<HTMLElement>("[data-tr-col-header]");
        const targetColumn = headers[highlightedCell.colIdx];
        const documentWidth = headers[0]?.offsetLeft ?? 0;
        if (targetColumn) container.scrollLeft = Math.max(0,
            targetColumn.offsetLeft + targetColumn.offsetWidth / 2 - (container.clientWidth + documentWidth) / 2);
    }, [highlightedCell]);
    const dragOverlay = dragOverFiles && (
        <div className="pointer-events-none absolute inset-0 z-20 border-2 border-dashed border-gray-400 bg-gray-50/50" />
    );
    const headerColumns = loading ? Array.from({ length: SKELETON_COLS }, (_, index) => ({ index, name: "", prompt: "" })) : sortedColumns;
    const noRows = !documents.length && !uploadingFilenames.length;
    return (
        <TableScrollArea horizontal scrollRef={scrollContainerRef}
            header={<TableHeaderRow className="h-auto min-h-18 w-max min-w-full items-stretch pr-0 text-xs font-medium text-gray-500">
                <TableStickyCell header className={`${STICKY} justify-between pr-1`}>
                    <span className="flex min-w-0 items-center">
                        <TableSelectionCheckbox loading={loading || noRows} aria-label="Select loaded documents"
                            checked={selection.allSelected} indeterminate={selection.someSelected} onChange={selection.toggleAll} />
                        Document
                    </span>
                    {!loading && !!sortedColumns.length && <HelpPopover label="Flag legend">
                        <ul className="space-y-1">{(Object.keys(FLAGS) as AnswerFlag[]).map((flag) =>
                            <li key={flag} className="flex items-center gap-2"><FlagDot flag={flag} />{FLAGS[flag].meaning}</li>)}</ul>
                    </HelpPopover>}
                </TableStickyCell>
                {headerColumns.map((col) => loading
                    ? <TableHeaderCell key={col.index} data-tr-col-header className={`${COLUMN_WIDTH} ${GRID_LINE} h-full justify-start`}>
                        <SkeletonLine className="h-3 w-28" />
                    </TableHeaderCell>
                    : <ColumnHeader key={col.index} column={col} disabled={savingColumnsConfig} running={running || !documents.length}
                        onEdit={onEditColumn} onRerun={onRerunColumn} onClear={onClearColumn} onDelete={onDeleteColumn}
                        onLabels={onColumnLabels} />)}
                <div className={FILLER} />
            </TableHeaderRow>}
        >
            {loading ? <TableLoadingRows count={SKELETON_ROWS} rowClassName={ROW}
                primaryClassName={STICKY} primaryLineClassName="h-3 w-32"
                columns={[...headerColumns.map(() => ({ className: `${COLUMN_WIDTH} ${GRID_LINE} flex h-full items-center`, lineClassName: "h-3 w-20" })),
                    { className: FILLER }]} />
            : noRows ? <div className="relative flex min-h-0 flex-1">
                {dragOverlay}
                <TableEmptyState className="py-16">
                    <p className="text-sm text-gray-600">{sortedColumns.length ? "No documents yet." : "Nothing to review yet."}</p>
                    <div className="mt-4 flex gap-2">
                        {!sortedColumns.length && <Button variant="outline" size="compact" onClick={onAddColumns}>+ Column</Button>}
                        <Button variant="outline" size="compact" onClick={onAddDocuments}>Docs</Button>
                    </div>
                </TableEmptyState>
            </div>
            : <TableBody className="relative min-h-0">
                {dragOverlay}
                {uploadingFilenames.map((filename) => (
                    <TableRow key={`uploading-${filename}`} interactive={false} className={ROW}>
                        <TableStickyCell className={`${STICKY} items-center py-0 text-[13px] text-gray-400`}>
                            <TableSelectionCheckbox disabled aria-label={`Uploading ${filename}`} />
                            <Loader2 aria-hidden="true" className="mr-2 size-3.5 shrink-0 animate-spin" />
                            <span className="truncate" title={filename}>{filename}</span>
                        </TableStickyCell>
                        {sortedColumns.map((col) => <TableCell key={col.index} className={`${COLUMN_WIDTH} ${GRID_LINE} flex h-full items-center`}>
                            <SkeletonLine className="h-3 w-20" />
                        </TableCell>)}
                        <div className={FILLER} />
                    </TableRow>
                ))}
                {documents.map((doc, docIdx) => {
                    const isSelected = selection.selected.has(doc.id);
                    return <Fragment key={doc.id}>
                        {!!doc.group?.length && JSON.stringify(doc.group) !== JSON.stringify(documents[docIdx - 1]?.group) &&
                            <TableRow interactive={false} className="h-7 w-max min-w-full border-b border-gray-200 bg-gray-50 pr-0 text-xs font-medium text-gray-700">
                                <div className="sticky left-0 truncate px-4">{doc.group.join(" / ")}</div>
                            </TableRow>}
                        <TableRow data-tr-row selected={isSelected} interactive={false}
                            className={cn(ROW, !isSelected && APP_SURFACE_HOVER_CLASS)}>
                            <TableStickyCell className={cn(STICKY, "items-center py-0 text-[13px] leading-4 text-gray-800",
                                isSelected ? APP_SURFACE_ACTIVE_CLASS : APP_SURFACE_GROUP_HOVER_CLASS)}>
                                <TableSelectionCheckbox aria-label={`Select ${doc.filename}`} checked={isSelected}
                                    onChange={() => selection.toggle(doc.id)} />
                                <span className="line-clamp-2 [overflow-wrap:anywhere]" title={doc.filename}>{doc.filename}</span>
                            </TableStickyCell>
                            {sortedColumns.map((col, colPos) => {
                                const cell = cellsByKey.get(`${doc.id}:${col.index}`);
                                const isHighlighted = highlightedCell?.colIdx === colPos && highlightedCell?.rowIdx === docIdx;
                                return <TableCell key={col.index} className={cn(COLUMN_WIDTH, GRID_LINE, "h-full p-0",
                                    isHighlighted && "bg-amber-50 ring-2 ring-inset ring-amber-600")}>
                                    {cell && <TabularCellComponent cell={cell} column={col} onExpand={onExpand} onCitationClick={onCitationClick} />}
                                </TableCell>;
                            })}
                            <div className={FILLER} />
                        </TableRow>
                    </Fragment>;
                })}
            </TableBody>}
        </TableScrollArea>
    );
}

function ColumnHeader({ column, disabled, running, onEdit, onRerun, onClear, onDelete, onLabels }: {
    column: ColumnConfig; disabled: boolean; running: boolean;
    onEdit: (col: ColumnConfig) => void; onRerun?: (col: ColumnConfig) => void;
    onClear?: (col: ColumnConfig) => void; onDelete?: (col: ColumnConfig) => void;
    onLabels?: (col: ColumnConfig) => void;
}) {
    const format = FORMAT_OPTIONS.find(({ value }) => value === (column.format ?? "text")) ?? FORMAT_OPTIONS[0]!;
    const Icon = format.icon;
    const prompt = column.prompt && column.prompt !== column.name ? column.prompt : "";
    return <TableHeaderCell data-tr-col-header className={`group/head ${COLUMN_WIDTH} ${GRID_LINE} h-auto flex-col items-stretch justify-between gap-1 px-2.5 py-2 text-left`}>
        <span className="block w-full whitespace-normal text-[13px] leading-5 text-gray-700 [overflow-wrap:anywhere]">{column.name}</span>
        <span className="flex h-6 shrink-0 items-center justify-between text-gray-500">
            <Icon aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="flex items-center opacity-0 focus-within:opacity-100 group-hover/head:opacity-100 [@media(hover:none)]:opacity-100 [&:has([aria-expanded=true])]:opacity-100">
            {prompt && <HelpPopover label={`${column.name} prompt`}><span className="whitespace-pre-wrap">{prompt}</span></HelpPopover>}
            <MoreActionsMenu label={`${column.name} actions`} triggerClassName="h-6 w-6 items-center justify-center rounded text-gray-500 hover:bg-gray-100 hover:text-gray-800"
                items={[
                    { label: "Edit", disabled, onSelect: () => onEdit(column) },
                    ...(onRerun ? [{ label: "Rerun column", disabled: disabled || running, onSelect: () => onRerun(column) }] : []),
                    ...(onClear ? [{ label: "Clear column", disabled: disabled || running, onSelect: () => onClear(column) }] : []),
                    ...(onLabels && (column.format === "tag" || column.format === "yes_no")
                        ? [{ label: "Labels from this column", disabled, onSelect: () => onLabels(column) }] : []),
                    ...(onDelete ? [{ label: "Delete", disabled, onSelect: () => onDelete(column) }] : []),
                ]} />
            </span>
        </span>
    </TableHeaderCell>;
}
