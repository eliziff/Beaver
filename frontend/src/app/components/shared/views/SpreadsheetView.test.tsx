import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    useFetchSingleDoc: vi.fn(),
    workbook: {
        worksheets: [
            {
                id: 1,
                name: "Sheet 1",
                dimensions: { bottom: 1, right: 1 },
                model: { merges: [] },
                getColumn: () => ({ width: 14 }),
                getCell: () => ({
                    address: "A1",
                    alignment: {},
                    fill: {},
                    font: {},
                    hyperlink: "",
                    isMerged: false,
                    text: "Example",
                }),
            },
        ],
        xlsx: { load: vi.fn() },
    },
}));

vi.mock("exceljs", () => ({
    default: {
        Workbook: class {
            worksheets = mocks.workbook.worksheets;
            xlsx = mocks.workbook.xlsx;
        },
    },
}));

vi.mock("@/app/hooks/useFetchSingleDoc", () => ({
    useFetchSingleDoc: mocks.useFetchSingleDoc,
}));

import { SpreadsheetView } from "./SpreadsheetView";

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe("SpreadsheetView", () => {
    it("renders workbook data through the lightweight grid", async () => {
        mocks.useFetchSingleDoc.mockReturnValue({
            result: { type: "spreadsheet", buffer: new ArrayBuffer(8) },
            error: null,
        });
        mocks.workbook.xlsx.load.mockResolvedValue(mocks.workbook);

        render(<SpreadsheetView documentId="sheet-1" />);

        await waitFor(() =>
            expect(mocks.workbook.xlsx.load).toHaveBeenCalledOnce(),
        );
        expect(
            await screen.findByRole("grid", { name: "Sheet 1" }),
        ).toBeInTheDocument();
        expect(screen.getByText("Example")).toBeInTheDocument();
    });
});
