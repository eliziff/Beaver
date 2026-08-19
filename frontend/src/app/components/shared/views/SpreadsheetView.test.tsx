import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SpreadsheetView } from "./SpreadsheetView";

const { getSpreadsheetProjection } = vi.hoisted(() => ({
  getSpreadsheetProjection: vi.fn(),
}));
vi.mock("@/app/lib/beaverApi", () => ({ getSpreadsheetProjection }));

describe("SpreadsheetView", () => {
  it("renders projected cells and focuses cited evidence", async () => {
    getSpreadsheetProjection.mockResolvedValue({
      version_id: "v1",
      sheets: [{
        name: "Authorities",
        cells: [{ address: "B2", value: "R v Example", row: 2, column: 2 }],
      }],
    });

    render(
      <SpreadsheetView
        documentId="sheet-1"
        versionId="v1"
        highlightCells={[{ sheet: "Authorities", cell: "B2" }]}
      />,
    );

    expect(await screen.findByRole("grid", { name: "Authorities" })).toBeVisible();
    expect(screen.getByText("R v Example").closest('[role="gridcell"]')).toHaveClass("bg-red-100");
    expect(getSpreadsheetProjection).toHaveBeenCalledWith("sheet-1", "v1");
  });
});
