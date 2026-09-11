// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CourtRecordBuildPanel } from "./CourtRecordBuildPanel";
import { COURT_PROFILE_BY_ID } from "./profiles";
import type { BuildResult } from "./types";

vi.mock("@/app/components/shared/views/PdfView", () => ({
  PdfView: ({ bytes }: { bytes: Uint8Array }) => <p>Preview page {bytes[0]}</p>,
}));

describe("CourtRecordBuildPanel", () => {
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
