import {
    useEffect,
    useMemo,
    useRef,
} from "react";
import { Loader2, Pencil } from "lucide-react";
import type {
    ColumnConfig,
    Document,
    TabularCell,
} from "../shared/types";
import { TabularCell as TabularCellComponent } from "./TabularCell";
import {
    SkeletonLine,
    TableScrollArea,
    TableSelectionPlaceholder,
} from "../shared/TablePrimitive";
import { CheckboxControl } from "@/app/components/ui/checkbox";
import {
    APP_SURFACE_ACTIVE_CLASS,
    APP_SURFACE_GROUP_HOVER_CLASS,
    APP_SURFACE_HOVER_CLASS,
} from "@/app/components/ui/liquid-surface";
const SKELETON_COLS = 4;
const SKELETON_ROWS = 5;
const COL_W = "w-[142px] sm:w-[220px] lg:w-[240px] shrink-0";
const DOC_COL_W =
    "w-[112px] sm:w-[220px] md:w-[280px] xl:w-[332px] shrink-0";
const TR_STICKY_CELL_BG = "bg-app-surface";
const TR_HEADER_BG = "bg-app-surface";
interface Props {
    loading: boolean;
    columns: ColumnConfig[];
    documents: Document[];
    cells: TabularCell[];
    savingColumnsConfig: boolean;
    selectedDocIds: string[];
    uploadingFilenames?: string[];
    dragOverFiles?: boolean;
    highlightedCell?: { colIdx: number; rowIdx: number } | null;
    onSelectionChange: (ids: string[]) => void;
    onExpand: (cell: TabularCell) => void;
    onCitationClick: (
        cell: TabularCell,
        page: number | undefined,
        quote: string,
        citationRef: number,
        sheet?: string,
        citationCell?: string,
    ) => void;
    onEditColumn: (col: ColumnConfig) => void;
}
export function TRTable({
        loading,
        columns,
        documents,
        cells,
        savingColumnsConfig,
        selectedDocIds,
        uploadingFilenames = [],
        dragOverFiles = false,
        highlightedCell,
        onSelectionChange,
        onExpand,
        onCitationClick,
        onEditColumn,
    }: Props) {
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const sortedColumns = useMemo(
        () => [...columns].sort((a, b) => a.index - b.index),
        [columns],
    );
    const cellsByKey = useMemo(() => {
        const next = new Map<string, TabularCell>();
        for (const cell of cells) {
            next.set(`${cell.document_id}:${cell.column_index}`, cell);
        }
        return next;
    }, [cells]);
    const selectedDocIdSet = useMemo(
        () => new Set(selectedDocIds),
        [selectedDocIds],
    );
    const columnPositionByIndex = useMemo(
        () => new Map(sortedColumns.map((column, index) => [column.index, index])),
        [sortedColumns],
    );
    useEffect(() => {
        if (!highlightedCell) return;
        const container = scrollContainerRef.current;
        if (!container) return;
        const targetRow =
            container.querySelectorAll<HTMLElement>("[data-tr-row]")[
                highlightedCell.rowIdx
            ];
        if (targetRow) {
            container.scrollTo({
                top: Math.max(0, targetRow.offsetTop - 40),
                behavior: "smooth",
            });
        }
        const surface = container.parentElement;
        const targetColumn = surface?.querySelectorAll<HTMLElement>(
            "[data-tr-col-header]",
        )[highlightedCell.colIdx];
        const documentColumn = surface?.querySelector<HTMLElement>(
            "[data-tr-doc-header]",
        );
        if (targetColumn && documentColumn) {
            container.scrollLeft = Math.max(
                0,
                targetColumn.offsetLeft +
                    targetColumn.offsetWidth / 2 -
                    (container.clientWidth + documentColumn.offsetWidth) / 2,
            );
        }
    }, [highlightedCell]);
    function getCell(docId: string, colIdx: number) {
        return cellsByKey.get(`${docId}:${colIdx}`);
    }
    const allSelected =
        documents.length > 0 &&
        documents.every((d) => selectedDocIdSet.has(d.id));
    const someSelected =
        !allSelected && documents.some((d) => selectedDocIdSet.has(d.id));
    function toggleAll() {
        onSelectionChange(allSelected ? [] : documents.map((d) => d.id));
    }
    function toggleDoc(id: string) {
        onSelectionChange(
            selectedDocIdSet.has(id)
                ? selectedDocIds.filter((selected) => selected !== id)
                : [...selectedDocIds, id],
        );
    }
    const dragOverlay = dragOverFiles && (
        <div className="pointer-events-none absolute inset-0 z-[90] border-2 border-red-400 bg-red-50/40" />
    );
    if (loading) {
        return (
            <TableScrollArea
                horizontal
                header={
                    <div
                        className={`flex h-10 min-w-full shrink-0 ${TR_HEADER_BG}`}
                    >
                        <div
                            className={`sticky left-0 z-[80] ${DOC_COL_W} ${TR_STICKY_CELL_BG} flex items-center border-b border-r border-gray-200 py-2 pl-4 pr-2 text-xs font-medium text-gray-500`}
                        >
                            <TableSelectionPlaceholder />
                            <span>Document</span>
                        </div>
                        {Array.from({ length: SKELETON_COLS }).map((_, i) => (
                            <div
                                key={i}
                                className={`${COL_W} flex items-center border-b border-r border-gray-200 p-2`}
                            >
                                <SkeletonLine className="h-4 w-28" />
                            </div>
                        ))}
                        <div className="flex-1 border-b border-gray-200 min-w-8" />
                    </div>
                }
            >
                    {Array.from({ length: SKELETON_ROWS }).map((_, row) => (
                        <div
                            key={row}
                            className="flex h-8 min-w-full"
                        >
                            <div className={`sticky left-0 z-[60] ${DOC_COL_W} ${TR_STICKY_CELL_BG} flex items-center border-b border-r border-gray-200 py-2 pl-4 pr-2`}>
                                <TableSelectionPlaceholder />
                                <SkeletonLine className="h-4 w-32" />
                            </div>
                            {Array.from({ length: SKELETON_COLS }).map((_, col) => (
                                <div
                                    key={col}
                                    className={`${COL_W} flex items-center border-b border-r border-gray-200 p-2`}
                                >
                                    <SkeletonLine className="h-4" />
                                </div>
                            ))}
                            <div className="flex-1 border-b border-gray-200 min-w-8" />
                        </div>
                    ))}
            </TableScrollArea>
        );
    }
    if (
        columns.length === 0 &&
        documents.length === 0 &&
        uploadingFilenames.length === 0
    ) {
        return (
            <TableScrollArea
                horizontal
                header={
                    <div className={`shrink-0 flex h-10 items-center border-b border-gray-200 ${TR_HEADER_BG}`}>
                        <div
                            className={`${DOC_COL_W} ${TR_STICKY_CELL_BG} flex items-center border-r border-gray-200 py-2 pl-4 pr-2 text-xs font-medium text-gray-500 select-none`}
                        >
                            <TableSelectionPlaceholder />
                            Document
                        </div>
                        <div className="flex-1" />
                    </div>
                }
            >
                <div className="relative flex min-h-0 flex-1">
                    {dragOverlay}
                    <div className="mx-auto flex w-full max-w-xs flex-1 items-center">
                        <p className="text-sm text-gray-500">
                            Add columns and documents to begin.
                        </p>
                    </div>
                </div>
            </TableScrollArea>
        );
    }
    return (
        <TableScrollArea
            horizontal
            scrollRef={scrollContainerRef}
            header={
                <div
                    className={`z-[70] flex h-10 min-w-full shrink-0 ${TR_HEADER_BG}`}
                >
                    <div
                        data-tr-doc-header
                        className={`sticky left-0 z-[80] ${DOC_COL_W} ${TR_STICKY_CELL_BG} border-b border-r border-gray-200 flex items-center py-2 pl-4 pr-2 text-left text-xs font-medium text-gray-500 select-none`}
                    >
                        <CheckboxControl
                            checked={allSelected}
                            ref={(el) => {
                                if (el) el.indeterminate = someSelected;
                            }}
                            onChange={toggleAll}
                            className="-ml-2 mr-1"
                        />
                        <span>Document</span>
                    </div>
                    {columns.map((col) => (
                        <div
                            key={col.index}
                            data-tr-col-header
                            className={`${COL_W} flex items-center border-b border-r border-gray-200 p-2 text-left text-xs font-medium text-gray-500 select-none`}
                        >
                            <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
                                <span className="truncate">{col.name}</span>
                                <button
                                    type="button"
                                    aria-label={`Edit ${col.name}`}
                                    title="Edit column"
                                    disabled={savingColumnsConfig}
                                    onClick={() => onEditColumn(col)}
                                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-900 disabled:cursor-not-allowed disabled:text-gray-300"
                                >
                                    <Pencil className="h-3.5 w-3.5" />
                                </button>
                            </div>
                        </div>
                    ))}
                    <div className="min-w-8 flex-1 border-b border-gray-200" />
                </div>
            }
        >
                <div className="relative min-h-0 flex-1">
                    {dragOverlay}
                    {uploadingFilenames.map((filename) => (
                    <div
                        key={`uploading-${filename}`}
                        className="flex h-8 min-w-full"
                    >
                        <div
                            className={`sticky left-0 z-[60] ${DOC_COL_W} ${TR_STICKY_CELL_BG} border-b border-r border-gray-200 py-2 pl-4 pr-2 text-xs text-gray-400 flex items-center`}
                        >
                            <CheckboxControl
                                disabled
                                className="-ml-2 mr-1"
                            />
                            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin shrink-0" />
                            <span className="line-clamp-1" title={filename}>
                                {filename}
                            </span>
                        </div>
                        {sortedColumns.map((col) => (
                            <div
                                key={col.index}
                                className={`${COL_W} border-b border-r border-gray-200 p-2`}
                            >
                                <SkeletonLine className="h-4 w-20" />
                            </div>
                        ))}
                        <div className="flex-1 border-b border-gray-200 min-h-8 min-w-8" />
                    </div>
                    ))}
                    {documents.map((doc, docIdx) => {
                    const isSelected = selectedDocIdSet.has(doc.id);
                    const rowBg = isSelected
                        ? APP_SURFACE_ACTIVE_CLASS
                        : APP_SURFACE_HOVER_CLASS;
                    const stickyRowBg = isSelected
                        ? APP_SURFACE_ACTIVE_CLASS
                        : TR_STICKY_CELL_BG;
                    return (
                        <div
                            key={doc.id}
                            data-tr-row
                            className={`group flex min-w-full ${rowBg}`}
                        >
                            <div
                                className={`sticky left-0 z-[60] ${DOC_COL_W} border-b border-r border-gray-200 py-2 pl-4 pr-2 text-xs text-gray-800 flex items-center ${stickyRowBg} ${isSelected ? "" : APP_SURFACE_GROUP_HOVER_CLASS}`}
                            >
                                <CheckboxControl
                                    checked={selectedDocIdSet.has(doc.id)}
                                    onChange={() => toggleDoc(doc.id)}
                                    className="-ml-2 mr-1"
                                />
                                <span
                                    className="line-clamp-1"
                                    title={doc.filename}
                                >
                                    {doc.filename}
                                </span>
                            </div>
                            {columns.map((col) => {
                                const cell = getCell(doc.id, col.index);
                                const colPos =
                                    columnPositionByIndex.get(col.index) ?? 0;
                                const isHighlighted =
                                    highlightedCell?.colIdx === colPos &&
                                    highlightedCell?.rowIdx === docIdx;
                                return (
                                    <div
                                        key={col.index}
                                        className={`${COL_W} border-b border-r border-gray-200 ${isHighlighted ? "bg-red-100" : ""}`}                                    >
                                        {cell && (
                                            <TabularCellComponent
                                                cell={cell}
                                                column={col}
                                                onExpand={onExpand}
                                                onCitationClick={onCitationClick}
                                            />
                                        )}
                                    </div>
                                );
                            })}
                            <div className="flex-1 border-b border-gray-200 min-h-8 min-w-8" />
                        </div>
                    );
                    })}
                </div>
        </TableScrollArea>
    );
}
