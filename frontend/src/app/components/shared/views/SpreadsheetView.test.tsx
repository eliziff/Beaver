import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SpreadsheetView } from "./SpreadsheetView";
import { getDocumentCitationQuotes } from "@/app/lib/citations";

const { getSpreadsheetProjection } = vi.hoisted(() => ({
  getSpreadsheetProjection: vi.fn(),
}));
vi.mock("@/app/lib/api/documents", () => ({
  getSpreadsheetProjection
}));

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
        highlightCells={getDocumentCitationQuotes({ kind: "document", ref: 1, document_id: "sheet-1",
          filename: "Authorities.xlsx", sheet: "Authorities", cells: "B2", quotes: [{ quote: "R v Example" }] })}
      />,
    );

    expect(await screen.findByRole("grid", { name: "Authorities" })).toBeVisible();
    expect(screen.getByText("R v Example").closest('[role="gridcell"]')).toHaveAttribute("data-highlighted", "true");
    expect(getSpreadsheetProjection).toHaveBeenCalledWith("sheet-1", "v1");
  });
});
