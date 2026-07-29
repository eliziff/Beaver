import ExcelJS, { type Cell, type Worksheet } from "exceljs";
import {
    type CSSProperties,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { Loader2 } from "lucide-react";
import { useFetchSingleDoc } from "@/app/hooks/useFetchSingleDoc";

const COL_HEADER = 28;
const ROW_HEADER = 48;
const ROW_HEIGHT = 25;
const OVERSCAN = 2;
const INVALID = "This spreadsheet could not be displayed.";

type HighlightCell = { sheet?: string; cell?: string };
type Range = { r0: number; r1: number; c0: number; c1: number };
type Parsed = {
    buffer: ArrayBuffer;
    workbook?: ExcelJS.Workbook;
    error?: string;
};

interface Props {
    documentId: string;
    versionId?: string | null;
    highlightCells?: HighlightCell[];
    rounded?: boolean;
}

function columnIndex(letters: string) {
    let result = 0;
    for (const letter of letters.toUpperCase())
        result = result * 26 + letter.charCodeAt(0) - 64;
    return result;
}

function parseCell(value: string) {
    const match = value.trim().match(/^([A-Za-z]+)(\d+)$/);
    if (!match) return null;
    const row = Number(match[2]);
    const column = columnIndex(match[1]);
    return row > 0 && column > 0 ? { row, column } : null;
}

function parseRange(value?: string): Range | null {
    if (!value) return null;
    const [from, to = from] = value.split(":");
    const start = parseCell(from);
    const end = parseCell(to);
    return start && end
        ? {
              r0: Math.min(start.row, end.row),
              r1: Math.max(start.row, end.row),
              c0: Math.min(start.column, end.column),
              c1: Math.max(start.column, end.column),
          }
        : null;
}

function columnName(index: number) {
    let name = "";
    for (let value = index; value; value = Math.floor((value - 1) / 26))
        name = String.fromCharCode(((value - 1) % 26) + 65) + name;
    return name;
}

function argb(value?: string) {
    const color = value?.replace(/^#/, "");
    return color && (color.length === 6 || color.length === 8)
        ? `#${color.slice(-6)}`
        : undefined;
}

function cellStyle(cell: Cell): CSSProperties {
    const fill =
        cell.fill?.type === "pattern" ? argb(cell.fill.fgColor?.argb) : undefined;
    const horizontal = cell.alignment?.horizontal;
    return {
        backgroundColor: fill,
        color: argb(cell.font?.color?.argb),
        fontFamily: cell.font?.name,
        fontSize: cell.font?.size ? `${cell.font.size}px` : undefined,
        fontStyle: cell.font?.italic ? "italic" : undefined,
        fontWeight: cell.font?.bold ? 600 : undefined,
        justifyContent:
            cell.alignment?.horizontal === "center"
                ? "center"
                : cell.alignment?.horizontal === "right"
                  ? "flex-end"
                  : undefined,
        textAlign:
            horizontal === "fill" || horizontal === "centerContinuous"
                ? "center"
                : horizontal === "distributed"
                  ? "justify"
                  : horizontal,
        whiteSpace: cell.alignment?.wrapText ? "normal" : "nowrap",
    };
}

function firstVisible(offsets: number[], value: number) {
    let low = 0;
    let high = offsets.length - 1;
    while (low < high) {
        const mid = Math.floor((low + high + 1) / 2);
        if (offsets[mid] <= value) low = mid;
        else high = mid - 1;
    }
    return low;
}

function SpreadsheetGrid({
    sheet,
    highlight,
}: {
    sheet: Worksheet;
    highlight: Range | null;
}) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const [viewport, setViewport] = useState({
        left: 0,
        top: 0,
        width: 900,
        height: 600,
    });
    const rowCount = Math.max(sheet.dimensions?.bottom ?? 0, 1);
    const columnCount = Math.max(sheet.dimensions?.right ?? 0, 1);
    const columns = useMemo(() => {
        const widths = Array.from({ length: columnCount }, (_, index) =>
            Math.max(64, Math.min(320, (sheet.getColumn(index + 1).width ?? 14) * 7)),
        );
        const offsets = [0];
        for (const width of widths) offsets.push(offsets.at(-1)! + width);
        return { widths, offsets };
    }, [columnCount, sheet]);
    const merges = useMemo(() => {
        const result = new Map<string, Range>();
        for (const value of sheet.model.merges ?? []) {
            const range = parseRange(value);
            if (range) result.set(`${range.r0}:${range.c0}`, range);
        }
        return result;
    }, [sheet]);

    useEffect(() => {
        const element = scrollRef.current;
        if (!element) return;
        const sync = () =>
            setViewport((current) => ({
                ...current,
                width: element.clientWidth,
                height: element.clientHeight,
            }));
        sync();
        const observer =
            typeof ResizeObserver === "undefined"
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
        const left = columns.offsets[highlight.c0 - 1] ?? 0;
        const right = columns.offsets[highlight.c1] ?? left;
        const top = (highlight.r0 - 1) * ROW_HEIGHT;
        const bottom = highlight.r1 * ROW_HEIGHT;
        element.scrollTo({
            left: Math.max(0, (left + right - element.clientWidth) / 2),
            top: Math.max(0, (top + bottom - element.clientHeight) / 2),
        });
    }, [columns, highlight, sheet]);

    const firstRow = Math.max(
        1,
        Math.floor(Math.max(0, viewport.top - COL_HEADER) / ROW_HEIGHT) + 1 - OVERSCAN,
    );
    const lastRow = Math.min(
        rowCount,
        Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT) + OVERSCAN,
    );
    const firstColumn = Math.max(
        1,
        firstVisible(columns.offsets, Math.max(0, viewport.left - ROW_HEADER)) -
            OVERSCAN,
    );
    const lastColumn = Math.min(
        columnCount,
        firstVisible(
            columns.offsets,
            viewport.left + viewport.width + ROW_HEADER,
        ) + OVERSCAN,
    );
    const visibleCells = [];
    for (let row = firstRow; row <= lastRow; row++) {
        for (let column = firstColumn; column <= lastColumn; column++) {
            const cell = sheet.getCell(row, column);
            if (cell.isMerged && cell.master.address !== cell.address) continue;
            const merge = merges.get(`${row}:${column}`);
            const right = merge?.c1 ?? column;
            const bottom = merge?.r1 ?? row;
            const active =
                !!highlight &&
                row <= highlight.r1 &&
                bottom >= highlight.r0 &&
                column <= highlight.c1 &&
                right >= highlight.c0;
            const style = {
                ...cellStyle(cell),
                left: ROW_HEADER + columns.offsets[column - 1],
                top: COL_HEADER + (row - 1) * ROW_HEIGHT,
                width:
                    columns.offsets[right] - columns.offsets[column - 1],
                height: (bottom - row + 1) * ROW_HEIGHT,
            };
            const href =
                cell.hyperlink && /^(https?:\/\/|mailto:)/i.test(cell.hyperlink)
                    ? cell.hyperlink
                    : null;
            const content = href ? (
                <a
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    className="truncate text-blue-700 underline"
                >
                    {cell.text}
                </a>
            ) : (
                cell.text
            );
            visibleCells.push(
                <div
                    key={cell.address}
                    role="gridcell"
                    aria-colindex={column}
                    aria-rowindex={row}
                    className={`absolute flex items-center overflow-hidden border-b border-r border-gray-200 px-1.5 text-xs text-gray-900 ${
                        active ? "z-[1] bg-red-100 ring-2 ring-inset ring-red-600" : ""
                    }`}
                    style={style}
                    title={cell.text}
                >
                    <span className="min-w-0 truncate">{content}</span>
                </div>,
            );
        }
    }
    const visibleColumns = [];
    for (let column = firstColumn; column <= lastColumn; column++)
        visibleColumns.push(
            <div
                key={column}
                className="absolute top-0 flex h-7 items-center justify-center border-r border-gray-300 bg-gray-100 text-xs font-medium text-gray-600"
                style={{
                    left:
                        ROW_HEADER +
                        columns.offsets[column - 1] -
                        viewport.left,
                    width: columns.widths[column - 1],
                }}
            >
                {columnName(column)}
            </div>,
        );
    const visibleRows = [];
    for (let row = firstRow; row <= lastRow; row++)
        visibleRows.push(
            <div
                key={row}
                className="absolute left-0 flex w-12 items-center justify-center border-b border-gray-300 bg-gray-100 text-xs text-gray-600"
                style={{
                    top: COL_HEADER + (row - 1) * ROW_HEIGHT - viewport.top,
                    height: ROW_HEIGHT,
                }}
            >
                {row}
            </div>,
        );
    return (
        <div className="relative min-h-0 flex-1 overflow-hidden bg-white">
            <div
                ref={scrollRef}
                role="grid"
                aria-label={sheet.name}
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
                        width: ROW_HEADER + columns.offsets.at(-1)!,
                        height: COL_HEADER + rowCount * ROW_HEIGHT,
                    }}
                >
                    {visibleCells}
                </div>
            </div>
            <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-7 overflow-hidden">
                {visibleColumns}
            </div>
            <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-12 overflow-hidden">
                {visibleRows}
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
    const { result, error: fetchError } = useFetchSingleDoc(documentId, versionId);
    const [parsed, setParsed] = useState<Parsed | null>(null);
    const target = highlightCells?.[0];
    const [sheetIndex, setSheetIndex] = useState(0);

    useEffect(() => {
        if (result?.type !== "spreadsheet") return;
        let cancelled = false;
        const workbook = new ExcelJS.Workbook();
        workbook.xlsx
            .load(result.buffer)
            .then(() => {
                if (!cancelled)
                    setParsed(
                        workbook.worksheets.length
                            ? { buffer: result.buffer, workbook }
                            : { buffer: result.buffer, error: INVALID },
                    );
            })
            .catch(() => {
                if (!cancelled)
                    setParsed({ buffer: result.buffer, error: INVALID });
            });
        return () => {
            cancelled = true;
        };
    }, [result]);

    const current =
        result?.type === "spreadsheet" && parsed?.buffer === result.buffer
            ? parsed
            : null;
    const workbook = current?.workbook;
    useEffect(() => {
        if (!workbook || !target?.sheet) return;
        const index = workbook.worksheets.findIndex(
            (sheet) => sheet.name === target.sheet,
        );
        if (index >= 0) setSheetIndex(index);
    }, [target?.sheet, workbook]);

    const message =
        (result && result.type !== "spreadsheet" ? INVALID : current?.error) ??
        (fetchError ? "Failed to load spreadsheet." : null);
    const sheet = workbook?.worksheets[sheetIndex] ?? workbook?.worksheets[0];
    return (
        <div
            className={`relative flex min-h-0 flex-1 flex-col overflow-hidden border border-gray-200 ${
                rounded ? "rounded-lg" : ""
            }`}
        >
            {message ? (
                <div className="flex h-full items-center justify-center px-6 text-center text-sm text-gray-500">
                    {message}
                </div>
            ) : !sheet ? (
                <div className="flex h-full items-center justify-center">
                    <Loader2 className="h-7 w-7 animate-spin text-red-700" />
                </div>
            ) : (
                <>
                    <SpreadsheetGrid
                        sheet={sheet}
                        highlight={parseRange(target?.cell)}
                    />
                    {workbook!.worksheets.length > 1 && (
                        <div
                            className="flex h-9 shrink-0 items-stretch overflow-x-auto border-t border-gray-300 bg-gray-100"
                            aria-label="Sheets"
                        >
                            {workbook!.worksheets.map((item, index) => (
                                <button
                                    key={item.id}
                                    type="button"
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
