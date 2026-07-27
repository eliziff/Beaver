import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    transformExcelToLucky: vi.fn(),
    useFetchSingleDoc: vi.fn(),
}));

vi.mock("luckyexcel", () => ({
    default: { transformExcelToLucky: mocks.transformExcelToLucky },
}));

vi.mock("@fortune-sheet/react", () => ({
    Workbook: () => <div data-testid="workbook" />,
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
    it("renders workbook data through the deferred parser", async () => {
        mocks.useFetchSingleDoc.mockReturnValue({
            result: { type: "spreadsheet", buffer: new ArrayBuffer(8) },
            error: null,
        });
        mocks.transformExcelToLucky.mockImplementation(
            (_file: File, callback: (value: unknown) => void) =>
                callback({
                    sheets: [{ name: "Sheet 1", celldata: [], config: {} }],
                }),
        );

        render(<SpreadsheetView documentId="sheet-1" />);

        await waitFor(() =>
            expect(mocks.transformExcelToLucky).toHaveBeenCalledOnce(),
        );
        expect(await screen.findByTestId("workbook")).toBeInTheDocument();
    });
});
