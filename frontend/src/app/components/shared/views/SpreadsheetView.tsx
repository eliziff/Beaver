"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";import { Loader2 } from "lucide-react";
import type { LuckyExcelSheet } from "luckyexcel";
import type { WorkbookInstance } from "@fortune-sheet/react";
import type { Cell, Sheet } from "@fortune-sheet/core";
import { useFetchSingleDoc } from "@/app/hooks/useFetchSingleDoc";
type HighlightRange = { row: [number, number]; column: [number, number] };
type WorkbookComponent = typeof import("@fortune-sheet/react").Workbook;
export type HighlightCell = { sheet?: string; cell?: string };
interface Props {
    documentId: string;
    versionId?: string | null;
    highlightCells?: HighlightCell[];
    rounded?: boolean;
}
function columnLettersToIndex(letters: string): number {
    let n = 0;
    for (const ch of letters.toUpperCase()) {
        n = n * 26 + (ch.charCodeAt(0) - 64);
    }
    return n - 1;
}
function parseA1(cell: string): { r: number; c: number } | null {
    const m = cell.trim().match(/^([A-Za-z]+)(\d+)$/);
    if (!m) return null;
    const c = columnLettersToIndex(m[1]);
    const r = Number.parseInt(m[2], 10) - 1;
    if (c < 0 || r < 0) return null;
    return { r, c };
}
function parseRange(range: string): HighlightRange | null {
    const [startRaw, endRaw] = range.split(":");
    const start = parseA1(startRaw);
    if (!start) return null;
    const end = endRaw ? parseA1(endRaw) : start;
    if (!end) return null;
    return {
        row: [Math.min(start.r, end.r), Math.max(start.r, end.r)],
        column: [Math.min(start.c, end.c), Math.max(start.c, end.c)],
    };
}
function expandRangeForMerges(
    sheet: Sheet,
    range: HighlightRange,
): HighlightRange {
    const merges = (sheet.config as { merge?: Record<string, MergeInfo> })
        ?.merge;
    if (!merges) return range;
    let [r0, r1] = range.row;
    let [c0, c1] = range.column;
    for (const m of Object.values(merges)) {
        const mr1 = m.r + m.rs - 1;
        const mc1 = m.c + m.cs - 1;
        if (r0 <= mr1 && r1 >= m.r && c0 <= mc1 && c1 >= m.c) {
            r0 = Math.min(r0, m.r);
            r1 = Math.max(r1, mr1);
            c0 = Math.min(c0, m.c);
            c1 = Math.max(c1, mc1);
        }
    }
    return { row: [r0, r1], column: [c0, c1] };
}
function rangePixelRect(
    sheet: Sheet,
    range: HighlightRange,
): { x: number; y: number; w: number; h: number } {
    const cfg = (sheet.config ?? {}) as {
        columnlen?: Record<string, number>;
        rowlen?: Record<string, number>;
    };
    const colLen = cfg.columnlen ?? {};
    const rowLen = cfg.rowlen ?? {};
    const colW = (c: number) => colLen[c] ?? sheet.defaultColWidth ?? 73;
    const rowH = (r: number) => rowLen[r] ?? sheet.defaultRowHeight ?? 19;
    let x = 0;
    for (let c = 0; c < range.column[0]; c++) x += colW(c);
    let w = 0;
    for (let c = range.column[0]; c <= range.column[1]; c++) w += colW(c);
    let y = 0;
    for (let r = 0; r < range.row[0]; r++) y += rowH(r);
    let h = 0;
    for (let r = range.row[0]; r <= range.row[1]; r++) h += rowH(r);
    return { x, y, w, h };
}
type MergeInfo = { r: number; c: number; rs: number; cs: number };
type CellData = { r: number; c: number; v: Record<string, unknown> };
function applyMergeCells(sheets: LuckyExcelSheet[]): void {
    for (const sheet of sheets) {
        const merges = (sheet.config as { merge?: Record<string, MergeInfo> })
            ?.merge;
        if (!merges) continue;
        if (!Array.isArray(sheet.celldata)) sheet.celldata = [];
        const celldata = sheet.celldata as CellData[];
        const byKey = new Map<string, CellData>();
        for (const entry of celldata) {
            if (typeof entry?.r === "number" && typeof entry?.c === "number") {
                byKey.set(`${entry.r}_${entry.c}`, entry);
            }
        }
        const ensureCell = (r: number, c: number): CellData => {
            const key = `${r}_${c}`;
            let entry = byKey.get(key);
            if (!entry) {
                entry = { r, c, v: {} };
                celldata.push(entry);
                byKey.set(key, entry);
            }
            if (!entry.v || typeof entry.v !== "object") entry.v = {};
            return entry;
        };
        for (const mc of Object.values(merges)) {
            ensureCell(mc.r, mc.c).v.mc = {
                r: mc.r,
                c: mc.c,
                rs: mc.rs,
                cs: mc.cs,
            };
            for (let rr = mc.r; rr < mc.r + mc.rs; rr++) {
                for (let cc = mc.c; cc < mc.c + mc.cs; cc++) {
                    if (rr === mc.r && cc === mc.c) continue;
                    ensureCell(rr, cc).v.mc = { r: mc.r, c: mc.c };
                }
            }
        }
    }
}
function applyExcelTextOverflow(sheets: LuckyExcelSheet[]): void {
    for (const sheet of sheets) {
        const celldata = sheet.celldata;
        if (!Array.isArray(celldata)) continue;
        for (const entry of celldata) {
            const cell = (entry as { v?: Record<string, unknown> } | null)?.v;
            if (!cell || typeof cell !== "object") continue;
            if (cell.mc) continue; // part of a merge - leave as-is
            if (cell.tb === "2") continue; // explicit wrap-text - keep
            if (typeof cell.v === "string" && cell.v.length > 0) {
                cell.tb = "1"; // text: overflow into empty neighbors
            }
        }
    }
}
const HEADER_TINT = "rgba(148, 163, 184, 0.18)";
function tintHeaderCell(
  x: number,
  y: number,
  width: number,
  height: number,
  ctx: CanvasRenderingContext2D,
): void {
  ctx.save();
  ctx.fillStyle = HEADER_TINT;
  ctx.fillRect(x, y, width, height);
  ctx.restore();
}
export function SpreadsheetView({
    documentId,
    versionId,
    highlightCells,
    rounded = true,
}: Props) {
    const workbookRef = useRef<WorkbookInstance>(null);
    const luckyExcelRef =
        useRef<Promise<typeof import("luckyexcel")> | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const highlightRef = useRef<HighlightRange | null>(null);
    const [sheets, setSheets] = useState<Sheet[] | null>(null);
    const [WorkbookComponent, setWorkbookComponent] =
        useState<WorkbookComponent | null>(null);
    const [error, setError] = useState<string | null>(null);
    const { result, error: fetchError } = useFetchSingleDoc(
        documentId,
        versionId,
    );
    useEffect(() => {
        let cancelled = false;
        luckyExcelRef.current ??= import("luckyexcel");
        Promise.all([
            import("@fortune-sheet/react"),
            import("@fortune-sheet/react/dist/index.css"),
        ]).then(([mod]) => {
            if (!cancelled) setWorkbookComponent(() => mod.Workbook);
        });
        return () => {
            cancelled = true;
        };
    }, []);
    const highlightKey = (highlightCells ?? [])        .map((h) => `${h.sheet ?? ""}!${h.cell ?? ""}`)        .join("|");    useEffect(() => {
        if (!result) return;
        if (result.type !== "spreadsheet") {
            setError("This spreadsheet could not be displayed.");
            return;
        }
        let cancelled = false;
        setSheets(null);
        setError(null);
        void (luckyExcelRef.current ?? import("luckyexcel"))
            .then(({ default: LuckyExcel }) => {
                if (cancelled) return;
                const file = new File([result.buffer], "spreadsheet.xlsx");
                LuckyExcel.transformExcelToLucky(file, (exportJson) => {
                    if (cancelled) return;
                    if (exportJson?.sheets?.length) {
                        applyMergeCells(exportJson.sheets);
                        applyExcelTextOverflow(exportJson.sheets);
                        setSheets(exportJson.sheets as unknown as Sheet[]);
                    } else {
                        setError("This spreadsheet could not be displayed.");
                    }
                });
            })
            .catch(() => {
                if (!cancelled)
                    setError("This spreadsheet could not be displayed.");
            });
        return () => {
            cancelled = true;
        };
    }, [result]);
    const afterRenderCell = useCallback(
        (
            _cell: Cell | null,
            info: {
                row: number;
                column: number;
                startX: number;
                startY: number;
                endX: number;
                endY: number;
            },
            ctx: CanvasRenderingContext2D,
        ) => {
            const range = highlightRef.current;
            if (!range) return;
            if (
                info.row < range.row[0] ||
                info.row > range.row[1] ||
                info.column < range.column[0] ||
                info.column > range.column[1]
            ) {
                return;
            }
            const w = info.endX - info.startX;
            const h = info.endY - info.startY;
            ctx.save();
            ctx.fillStyle = "rgba(59, 130, 246, 0.16)";
            ctx.fillRect(info.startX, info.startY, w, h);
            ctx.strokeStyle = "#3b82f6";
            ctx.lineWidth = 2;
            ctx.strokeRect(info.startX + 1, info.startY + 1, w - 2, h - 2);
            ctx.restore();
        },
        [],
    );
    const hooks = useMemo(
        () => ({
            afterRenderCell,
            afterRenderColumnHeaderCell: (
                _char: string,
                _idx: number,
                left: number,
                width: number,
                height: number,
                ctx: CanvasRenderingContext2D,
            ) => tintHeaderCell(left, 0, width, height, ctx),
            afterRenderRowHeaderCell: (
                _num: string,
                _idx: number,
                top: number,
                width: number,
                height: number,
                ctx: CanvasRenderingContext2D,
            ) => tintHeaderCell(0, top, width, height, ctx),
        }),
        [afterRenderCell],
    );
    useEffect(() => {
        if (!sheets) return;
        const target = highlightCells?.[0];
        const sheetIndex = target?.sheet
            ? Math.max(
                  0,
                  sheets.findIndex((s) => s.name === target.sheet),
              )
            : 0;
        const parsed = target?.cell ? parseRange(target.cell) : null;
        const range = parsed
            ? expandRangeForMerges(sheets[sheetIndex], parsed)
            : null;
        highlightRef.current = range;
        if (!range && !target?.sheet) return;
        const timer = window.setTimeout(() => {
            const inst = workbookRef.current;
            if (!inst) return;
            try {
                inst.activateSheet({ index: sheetIndex });
                if (!range) return;
                const container = containerRef.current;
                const sbX = container?.querySelector<HTMLElement>(
                    ".luckysheet-scrollbar-x",
                );
                const sbY = container?.querySelector<HTMLElement>(
                    ".luckysheet-scrollbar-y",
                );
                if (!sbX || !sbY) {
                    inst.scroll({
                        targetRow: range.row[0],
                        targetColumn: range.column[0],
                    });
                    return;
                }
                const rect = rangePixelRect(sheets[sheetIndex], range);
                const curLeft = sbX.scrollLeft;
                const curTop = sbY.scrollTop;
                const viewW = sbX.clientWidth;
                const viewH = sbY.clientHeight;
                const visible =
                    rect.x >= curLeft &&
                    rect.x + rect.w <= curLeft + viewW &&
                    rect.y >= curTop &&
                    rect.y + rect.h <= curTop + viewH;
                if (visible) {
                    window.dispatchEvent(new Event("resize"));
                } else {
                    inst.scroll({
                        scrollLeft: Math.max(
                            0,
                            Math.round(rect.x - (viewW - rect.w) / 2),
                        ),
                        scrollTop: Math.max(
                            0,
                            Math.round(rect.y - (viewH - rect.h) / 2),
                        ),
                    });
                }
            } catch {
            }
        }, 200);
        return () => window.clearTimeout(timer);
    }, [sheets, highlightCells, highlightKey]);
    const frameClass = `fortune-sheet-viewer relative flex flex-col flex-1 min-h-0 overflow-hidden ${rounded ? "rounded-lg" : ""}`;
    const message =
        error ?? (fetchError ? "Failed to load spreadsheet." : null);
    if (message) {
        return (
            <div className={frameClass}>
                <div className="flex h-full items-center justify-center px-6 text-center text-sm text-gray-500">
                    {message}
                </div>
            </div>
        );
    }
    if (!sheets || !WorkbookComponent) {
        return (
            <div className={frameClass}>
                <div className="flex h-full items-center justify-center">
                    <Loader2 className="h-7 w-7 animate-spin text-gray-400" />
                </div>
            </div>
        );
    }
    return (
        <div ref={containerRef} className={frameClass}>
            <div className="relative min-h-0 flex-1">
                <WorkbookComponent
                    ref={workbookRef}
                    data={sheets}
                    hooks={hooks}
                    allowEdit={false}
                    showToolbar={false}
                    showFormulaBar={false}
                />
                <style jsx global>{`
                    .fortune-sheet-viewer .fortune-left-top {
                        background-color: #eceef2;
                    }
                    .fortune-sheet-viewer .fortune-row-header-hover,
                    .fortune-sheet-viewer .fortune-col-header-hover {
                        background-color: rgba(209, 213, 219, 0.65);
                    }
                    .fortune-sheet-viewer .fortune-row-header-selected,
                    .fortune-sheet-viewer .fortune-col-header-selected {
                        background-color: rgba(156, 163, 175, 0.28);
                    }
                `}</style>
            </div>
        </div>
    );
}
export default SpreadsheetView;
