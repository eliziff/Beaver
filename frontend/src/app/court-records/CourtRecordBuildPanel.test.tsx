// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CourtRecordBuildPanel } from "./CourtRecordBuildPanel";
import { COURT_PROFILE_BY_ID } from "./profiles";
import type { BuildResult, RecordEntry } from "./types";

vi.mock("./CourtCoverPreview", () => ({ CourtCoverPreview: () => <p>Fake cover</p> }));
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
  it("summarizes separate filing files instead of inventing a cover preview", () => {
    const file = new File(["test"], "memorandum.pdf", { type: "application/pdf" });
    const entry = { id: "source", kindId: "memorandum", file, title: "Memorandum",
      pageCount: 3, searchable: true, encrypted: false } as RecordEntry;

    render(<CourtRecordBuildPanel profile={COURT_PROFILE_BY_ID.get("fca-leave-response-set")!}
      cover={{}} entries={[entry]} report={{ ready: false, blockers: [], review: [],
        passes: [], pageCount: 3, inputBytes: file.size }} building={false} saving={false}
      hostMode="standalone" onBuild={vi.fn()} onDownload={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Filing set" })).toBeVisible();
    expect(screen.getAllByText(/1 source file/iu)).toHaveLength(1);
    expect(screen.queryByText("Fake cover")).not.toBeInTheDocument();
  });

  it("identifies the generated Form 344 output as awaiting signature", () => {
    const profile = structuredClone(COURT_PROFILE_BY_ID.get("fca-appeal-book")!);
    const entry = { id: "notice", kindId: "notice", file: new File(["pdf"], "notice.pdf"),
      title: "Notice", pageCount: 1, searchable: true, encrypted: false } as RecordEntry;
    render(<CourtRecordBuildPanel profile={profile} cover={{}} entries={[entry]}
      report={{ ready: true, blockers: [], review: [], passes: [], pageCount: 1,
        inputBytes: 1 }} building={false}
      saving={false} hostMode="standalone" onBuild={() => {}} onDownload={() => {}} />);
    expect(screen.getByRole("button", { name: "Build for signature" })).toBeVisible();
  });

  it("does not invent a cover for an affidavit record", () => {
    const file = new File(["test"], "affidavit.pdf", { type: "application/pdf" });
    const entry = { id: "source", kindId: "affidavit", file, title: "Affidavit",
      pageCount: 3, searchable: true, encrypted: false } as RecordEntry;

    render(<CourtRecordBuildPanel profile={COURT_PROFILE_BY_ID.get("ab-kb-affidavit-exhibits")!}
      cover={{}} entries={[entry]} report={{ ready: false, blockers: [], review: [],
        passes: [], pageCount: 3, inputBytes: file.size }} building={false} saving={false}
      hostMode="standalone" onBuild={vi.fn()} onDownload={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Build record" })).toBeVisible();
    expect(screen.queryByText("Fake cover")).not.toBeInTheDocument();
  });

  it("stops requesting a signature when the signed Form 344 is supplied", () => {
    const entry = { id: "signed", kindId: "form-344", file: new File(["signed"], "signed.pdf"),
      title: "Signed certificate", pageCount: 1, searchable: true, encrypted: false } as RecordEntry;
    render(<CourtRecordBuildPanel profile={COURT_PROFILE_BY_ID.get("fca-appeal-book")!}
      cover={{}} entries={[entry]} report={{ ready: true, blockers: [], review: [],
        passes: [], pageCount: 1, inputBytes: 6 }} building={false} saving={false}
      hostMode="standalone" onBuild={vi.fn()} onDownload={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Build record" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Build for signature" })).toBeNull();
  });

  it("identifies a generated exhibit certificate as awaiting signature", () => {
    const file = new File(["test"], "exhibit.pdf", { type: "application/pdf" });
    const entry = { id: "exhibit", kindId: "exhibit", file, title: "Exhibit A",
      exhibitLabel: "A", pageCount: 1, searchable: true, encrypted: false } as RecordEntry;

    render(<CourtRecordBuildPanel profile={COURT_PROFILE_BY_ID.get("fc-affidavit-exhibits")!}
      cover={{}} entries={[entry]} report={{ ready: true, blockers: [], review: [],
        passes: [], pageCount: 2, inputBytes: file.size }} building={false} saving={false}
      hostMode="standalone" onBuild={vi.fn()} onDownload={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Build for signature" })).toBeVisible();
  });
});
