// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CourtRecordBuildPanel } from "./CourtRecordBuildPanel";
import { COURT_PROFILE_BY_ID } from "./profiles";
import type { BuildResult } from "./types";

vi.mock("@/app/components/shared/views/PdfView", () => ({
  PdfView: ({ bytes, ariaLabel }: { bytes: Uint8Array; ariaLabel: string }) =>
    <div role="region" aria-label={ariaLabel}>Preview page {bytes[0]}</div>,
}));

describe("CourtRecordBuildPanel", () => {
  it("previews the source PDF before building a record without a generated cover", async () => {
    const file = new File([new Uint8Array([7])], "affidavit.pdf", { type: "application/pdf" });
    render(<CourtRecordBuildPanel profile={COURT_PROFILE_BY_ID.get("ab-kb-affidavit-exhibits")!}
      cover={{}} entries={[{ id: "affidavit", kindId: "affidavit", file, title: "Affidavit",
        pageCount: 1, searchable: true, encrypted: false }]}
      report={{ ready: true, blockers: [], review: [], passes: [], pageCount: 1, inputBytes: 1 }}
      building={false} saving={false} hostMode="standalone" onBuild={vi.fn()} onDownload={vi.fn()} />);

    expect(await screen.findByText("Preview page 7")).toBeVisible();
    expect(screen.getByRole("region", { name: "Court record source preview" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Expand reader" }));
    expect(await screen.findByRole("button", { name: "Restore reader size" }))
      .toHaveAttribute("aria-pressed", "true");
  });

  it("previews each output PDF and offers downloads after a completed build", () => {
    const artifacts = ["application.pdf", "evidence.pdf"].map((filename, index) => ({
      filename, mimeType: "application/pdf", bytes: new Uint8Array([index + 1]),
      pageCount: 1, sha256: String(index),
    }));
    const onDownload = vi.fn();
    render(<CourtRecordBuildPanel profile={COURT_PROFILE_BY_ID.get("ab-kb-chambers-justice-applicant-set")!}
      cover={{}} entries={[]} report={{ ready: true, blockers: [], review: [],
        passes: [], pageCount: 2, inputBytes: 2 }} building={false} saving={false}
      result={{ artifacts } as BuildResult} hostMode="standalone" onBuild={vi.fn()} onDownload={onDownload} />);
    expect(screen.getByText("Preview page 1")).toBeVisible();
    fireEvent.change(screen.getByRole("combobox", { name: "Preview file" }), {
      target: { value: "evidence.pdf" },
    });
    expect(screen.getByText("Preview page 2")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /evidence.pdf/ }));
    expect(onDownload).toHaveBeenCalledWith(artifacts[1]);
    expect(screen.queryByRole("button", { name: "Prepare filing set" })).toBeNull();
  });
});
