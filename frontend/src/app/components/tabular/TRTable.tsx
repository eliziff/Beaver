"use client";
import {
    forwardRef,
    useCallback,
    useEffect,
    useImperativeHandle,
    useMemo,
    useRef,
} from "react";
import { Loader2, Pencil, Plus, Upload } from "lucide-react";
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
import { PillButton } from "@/app/components/ui/pill-button";
import { TabularReviewSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
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
export interface TRTableHandle {
    scrollToCell: (colIdx: number, rowIdx: number) => void;
}
interface Props {
    loading: boolean;
    columns: ColumnConfig[];
    documents: Document[];
    cells: TabularCell[];
    savingColumn: boolean;
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
    onAddColumn: () => void;
    onAddDocuments: () => void;
}
export const TRTable = forwardRef<TRTableHandle, Props>(function TRTable(
    {
        loading,
        columns,
        documents,
        cells,
        savingColumn,
        savingColumnsConfig,
        selectedDocIds,
        uploadingFilenames = [],
        dragOverFiles = false,
        highlightedCell,
        onSelectionChange,
        onExpand,
        onCitationClick,
        onEditColumn,
        onAddColumn,
        onAddDocuments,
    },
    ref,
) {
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
    const onExpandRef = useRef(onExpand);
    const onCitationClickRef = useRef(onCitationClick);
    useEffect(() => {
        onExpandRef.current = onExpand;
        onCitationClickRef.current = onCitationClick;
    }, [onExpand, onCitationClick]);
    const handleCellExpand = useCallback((cell: TabularCell) => {
        onExpandRef.current(cell);
    }, []);
    const handleCellCitationClick = useCallback(
        (
            cell: TabularCell,
            page: number | undefined,
            quote: string,
            citationRef: number,
            sheet?: string,
            citationCell?: string,
        ) => {
            onCitationClickRef.current(
                cell,
                page,
                quote,
                citationRef,
                sheet,
                citationCell,
            );
        },
        [],
    );
    useImperativeHandle(ref, () => ({
        scrollToCell(colIdx: number, rowIdx: number) {
            const container = scrollContainerRef.current;
            if (!container) return;
            const allRows =
                container.querySelectorAll<HTMLElement>("[data-tr-row]");
            const targetRow = allRows[rowIdx];
            if (targetRow) {
                container.scrollTo({
                    top: Math.max(0, targetRow.offsetTop - 40),
                    behavior: "smooth",
                });
            }
            const surface = container.parentElement;
            const targetColumn = surface?.querySelectorAll<HTMLElement>(
                "[data-tr-col-header]",
            )[colIdx];
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
        },
    }));
    function getCell(docId: string, colIdx: number) {
        return cellsByKey.get(`${docId}:${colIdx}`);
    }
    const allSelected =
        documents.length > 0 &&
        documents.every((d) => selectedDocIdSet.has(d.id));
    const someSelected =
        !allSelected && documents.some((d) => selectedDocIdSet.has(d.id));
    function toggleAll() {
        if (allSelected) {
            onSelectionChange([]);
        } else {
            onSelectionChange(documents.map((d) => d.id));
        }
    }
    function toggleDoc(id: string) {
        if (selectedDocIdSet.has(id)) {
            onSelectionChange(selectedDocIds.filter((x) => x !== id));
        } else {
            onSelectionChange([...selectedDocIds, id]);
        }
    }
    if (loading) {
        return (
            <TableScrollArea
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
                    {dragOverFiles && (
                        <div className="absolute inset-0 z-[90] border-2 border-red-400 bg-red-50/40 pointer-events-none" />                    )}
                    <div className="flex flex-1 flex-col items-start justify-center w-full max-w-xs mx-auto">
                        <TabularReviewSkeuoIcon className="mb-4 h-8 w-8" />
                        <p className="text-2xl font-medium font-serif text-gray-900">
                            Tabular Review
                        </p>
                        <p className="mt-1 text-xs text-gray-400 text-left">
                            Add columns and documents to get started.
                        </p>
                        <div className="mt-4 flex items-center gap-2">
                            <PillButton
                                tone="black"
                                size="sm"
                                onClick={onAddColumn}
                                className="px-3"
                            >
                                <Plus className="h-3.5 w-3.5" />
                                Add Columns
                            </PillButton>
                            <PillButton
                                tone="white"
                                size="sm"
                                onClick={onAddDocuments}
                                className="px-3"
                            >
                                <Upload className="h-3.5 w-3.5" />
                                Add Documents
                            </PillButton>
                        </div>
                    </div>
                </div>
            </TableScrollArea>
        );
    }
    return (
        <TableScrollArea
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
                                    disabled={savingColumn || savingColumnsConfig}
                                    onClick={() => onEditColumn(col)}
                                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-900 disabled:cursor-not-allowed disabled:text-gray-300"
                                >
                                    <Pencil className="h-3.5 w-3.5" />
                                </button>
                            </div>
                        </div>
                    ))}
                    <div className="flex-1 border-b border-gray-200 flex items-center justify-start p-2 min-w-8">
                        <button
                            onClick={onAddColumn}
                            disabled={savingColumn || savingColumnsConfig}
                            className="flex items-center justify-center text-gray-400 hover:text-gray-700 disabled:text-gray-200"
                        >
                            <Plus className="h-4 w-4" />
                        </button>
                    </div>
                </div>
            }
        >
                <div className="relative min-h-0 flex-1">
                    {dragOverFiles && (
                        <div className="absolute inset-0 z-[90] border-2 border-red-400 bg-red-50/40 pointer-events-none" />                    )}
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
                                                onExpand={handleCellExpand}
                                                onCitationClick={
                                                    handleCellCitationClick
                                                }
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
});
