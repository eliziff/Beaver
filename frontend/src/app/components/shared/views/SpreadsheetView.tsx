import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import {
    getSpreadsheetProjection,
    type SpreadsheetProjection,
} from "@/app/lib/beaverApi";

const COLUMN_HEADER = 28;
const ROW_HEADER = 48;
const ROW_HEIGHT = 25;
const COLUMN_WIDTH = 96;
const OVERSCAN = 2;

type HighlightCell = { sheet?: string; cell?: string };
type Range = { r0: number; r1: number; c0: number; c1: number };
type SheetProjection = SpreadsheetProjection["sheets"][number];
type Props = {
    documentId: string;
    versionId?: string | null;
    highlightCells?: HighlightCell[];
    rounded?: boolean;
};

function parseCell(value: string) {
    const match = value.trim().match(/^([A-Za-z]+)(\d+)$/u);
    if (!match) return null;
    let column = 0;
    for (const letter of match[1].toUpperCase())
        column = column * 26 + letter.charCodeAt(0) - 64;
    const row = Number(match[2]);
    return row > 0 && column > 0 ? { row, column } : null;
}

function parseRange(value?: string): Range | null {
    if (!value) return null;
    const [from, to = from] = value.split(":");
    const start = parseCell(from);
    const end = parseCell(to);
    return start && end ? {
        r0: Math.min(start.row, end.row),
        r1: Math.max(start.row, end.row),
        c0: Math.min(start.column, end.column),
        c1: Math.max(start.column, end.column),
    } : null;
}

function columnName(index: number) {
    let name = "";
    for (let value = index; value; value = Math.floor((value - 1) / 26))
        name = String.fromCharCode(((value - 1) % 26) + 65) + name;
    return name;
}

function SpreadsheetGrid({
    sheet,
    highlight,
}: {
    sheet: SheetProjection;
    highlight: Range | null;
}) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const [viewport, setViewport] = useState({
        left: 0,
        top: 0,
        width: 900,
        height: 600,
    });
    const grid = useMemo(() => {
        const cells = new Map(
            sheet.cells.map((cell) => [`${cell.row}:${cell.column}`, cell]),
        );
        const covered = new Set<string>();
        let rows = 1;
        let columns = 1;
        for (const cell of sheet.cells) {
            const rowSpan = cell.rowSpan ?? 1;
            const columnSpan = cell.columnSpan ?? 1;
            rows = Math.max(rows, cell.row + rowSpan - 1);
            columns = Math.max(columns, cell.column + columnSpan - 1);
            for (let row = cell.row; row < cell.row + rowSpan; row += 1) {
                for (
                    let column = cell.column;
                    column < cell.column + columnSpan;
                    column += 1
                ) {
                    if (row !== cell.row || column !== cell.column)
                        covered.add(`${row}:${column}`);
                }
            }
        }
        return { cells, covered, rows, columns };
    }, [sheet]);

    useEffect(() => {
        const element = scrollRef.current;
        if (!element) return;
        const sync = () => setViewport((current) => ({
            ...current,
            width: element.clientWidth,
            height: element.clientHeight,
        }));
        sync();
        const observer = typeof ResizeObserver === "undefined"
            ? null
            : new ResizeObserver(sync);
        observer?.observe(element);
        window.addEventListener("resize", sync);
        return () => {
            observer?.disconnect();
            window.removeEventListener("resize", sync);
        };
    }, []);

    useEffect(() => {
        const element = scrollRef.current;
        if (!element || !highlight) return;
        const left = Math.max(
                0,
                ((highlight.c0 + highlight.c1 - 1) * COLUMN_WIDTH -
                    element.clientWidth) / 2,
            );
        const top = Math.max(
                0,
                ((highlight.r0 + highlight.r1 - 1) * ROW_HEIGHT -
                    element.clientHeight) / 2,
            );
        if (typeof element.scrollTo === "function") element.scrollTo({ left, top });
        else {
            element.scrollLeft = left;
            element.scrollTop = top;
        }
    }, [highlight, sheet]);

    const firstRow = Math.max(
        1,
        Math.floor(Math.max(0, viewport.top - COLUMN_HEADER) / ROW_HEIGHT) +
            1 - OVERSCAN,
    );
    const lastRow = Math.min(
        grid.rows,
        Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT) + OVERSCAN,
    );
    const firstColumn = Math.max(
        1,
        Math.floor(Math.max(0, viewport.left - ROW_HEADER) / COLUMN_WIDTH) +
            1 - OVERSCAN,
    );
    const lastColumn = Math.min(
        grid.columns,
        Math.ceil((viewport.left + viewport.width) / COLUMN_WIDTH) + OVERSCAN,
    );
    const cells = [];
    for (let row = firstRow; row <= lastRow; row += 1) {
        for (let column = firstColumn; column <= lastColumn; column += 1) {
            const key = `${row}:${column}`;
            if (grid.covered.has(key)) continue;
            const cell = grid.cells.get(key);
            const right = column + (cell?.columnSpan ?? 1) - 1;
            const bottom = row + (cell?.rowSpan ?? 1) - 1;
            const active = !!highlight &&
                row <= highlight.r1 && bottom >= highlight.r0 &&
                column <= highlight.c1 && right >= highlight.c0;
            cells.push(
                <div
                    key={key}
                    role="gridcell"
                    aria-colindex={column}
                    aria-rowindex={row}
                    data-position={key}
                    className={`absolute flex items-center overflow-hidden border-b border-r border-gray-200 px-1.5 text-xs text-gray-900 ${
                        active
                            ? "z-[1] bg-red-100 ring-2 ring-inset ring-red-600"
                            : ""
                    }`}
                    style={{
                        left: ROW_HEADER + (column - 1) * COLUMN_WIDTH,
                        top: COLUMN_HEADER + (row - 1) * ROW_HEIGHT,
                        width: (cell?.columnSpan ?? 1) * COLUMN_WIDTH,
                        height: (cell?.rowSpan ?? 1) * ROW_HEIGHT,
                    }}
                    title={cell?.value}
                >
                    <span className="min-w-0 truncate">{cell?.value}</span>
                </div>,
            );
        }
    }

    return (
        <div className="relative min-h-0 flex-1 overflow-hidden bg-white">
            <div
                ref={scrollRef}
                role="grid"
                aria-label={sheet.name}
                aria-rowcount={grid.rows}
                aria-colcount={grid.columns}
                className="absolute inset-0 overflow-auto"
                onScroll={(event) => {
                    const element = event.currentTarget;
                    setViewport({
                        left: element.scrollLeft,
                        top: element.scrollTop,
                        width: element.clientWidth,
                        height: element.clientHeight,
                    });
                }}
            >
                <div
                    className="relative"
                    style={{
                        width: ROW_HEADER + grid.columns * COLUMN_WIDTH,
                        height: COLUMN_HEADER + grid.rows * ROW_HEIGHT,
                    }}
                >
                    {cells}
                </div>
            </div>
            <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-7 overflow-hidden">
                {Array.from(
                    { length: lastColumn - firstColumn + 1 },
                    (_, offset) => firstColumn + offset,
                ).map((column) => (
                    <div
                        key={column}
                        className="absolute top-0 flex h-7 items-center justify-center border-r border-gray-300 bg-gray-100 text-xs font-medium text-gray-600"
                        style={{
                            left: ROW_HEADER +
                                (column - 1) * COLUMN_WIDTH - viewport.left,
                            width: COLUMN_WIDTH,
                        }}
                    >
                        {columnName(column)}
                    </div>
                ))}
            </div>
            <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-12 overflow-hidden">
                {Array.from(
                    { length: lastRow - firstRow + 1 },
                    (_, offset) => firstRow + offset,
                ).map((row) => (
                    <div
                        key={row}
                        className="absolute left-0 flex w-12 items-center justify-center border-b border-gray-300 bg-gray-100 text-xs text-gray-600"
                        style={{
                            top: COLUMN_HEADER +
                                (row - 1) * ROW_HEIGHT - viewport.top,
                            height: ROW_HEIGHT,
                        }}
                    >
                        {row}
                    </div>
                ))}
            </div>
            <div className="pointer-events-none absolute left-0 top-0 z-20 h-7 w-12 border-b border-r border-gray-300 bg-gray-200" />
        </div>
    );
}

export function SpreadsheetView({
    documentId,
    versionId,
    highlightCells,
    rounded = true,
}: Props) {
    const [projection, setProjection] =
        useState<SpreadsheetProjection | null>(null);
    const [error, setError] = useState(false);
    const [sheetIndex, setSheetIndex] = useState(0);
    const target = highlightCells?.[0];

    useEffect(() => {
        let live = true;
        setProjection(null);
        setError(false);
        void getSpreadsheetProjection(documentId, versionId)
            .then((value) => { if (live) setProjection(value); })
            .catch(() => { if (live) setError(true); });
        return () => { live = false; };
    }, [documentId, versionId]);

    useEffect(() => {
        if (!projection || !target?.sheet) return;
        const index = projection.sheets.findIndex(
            ({ name }) => name === target.sheet,
        );
        if (index >= 0) setSheetIndex(index);
    }, [projection, target?.sheet]);

    const sheet = projection?.sheets[sheetIndex] ?? projection?.sheets[0];
    return (
        <div className={`relative flex min-h-0 flex-1 flex-col overflow-hidden border border-gray-200 ${
            rounded ? "rounded-lg" : ""
        }`}>
            {error ? (
                <div role="alert" className="flex h-full items-center justify-center px-6 text-center text-sm text-gray-500">
                    Failed to load spreadsheet.
                </div>
            ) : !sheet ? (
                <div role="status" className="flex h-full items-center justify-center">
                    <Loader2 className="h-7 w-7 animate-spin text-red-700" />
                    <span className="sr-only">Loading spreadsheet…</span>
                </div>
            ) : (
                <>
                    <SpreadsheetGrid
                        sheet={sheet}
                        highlight={parseRange(target?.cell)}
                    />
                    {projection!.sheets.length > 1 && (
                        <div
                            role="tablist"
                            aria-label="Sheets"
                            className="flex h-9 shrink-0 items-stretch overflow-x-auto border-t border-gray-300 bg-gray-100"
                        >
                            {projection!.sheets.map((item, index) => (
                                <button
                                    key={item.name}
                                    type="button"
                                    role="tab"
                                    aria-selected={index === sheetIndex}
                                    onClick={() => setSheetIndex(index)}
                                    className={`shrink-0 border-r border-gray-300 px-4 text-xs ${
                                        index === sheetIndex
                                            ? "bg-white font-semibold text-gray-900"
                                            : "text-gray-600 hover:bg-gray-50"
                                    }`}
                                >
                                    {item.name}
                                </button>
                            ))}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

export default SpreadsheetView;
