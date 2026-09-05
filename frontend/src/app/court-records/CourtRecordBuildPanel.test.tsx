// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CourtRecordBuildPanel } from "./CourtRecordBuildPanel";
import { COURT_PROFILE_BY_ID } from "./profiles";
import type { RecordEntry } from "./types";

vi.mock("./CourtCoverPreview", () => ({ CourtCoverPreview: () => <p>Fake cover</p> }));

describe("CourtRecordBuildPanel", () => {
  it("summarizes separate filing files instead of inventing a cover preview", () => {
    const file = new File(["test"], "memorandum.pdf", { type: "application/pdf" });
    const entry = { id: "source", kindId: "memorandum", file, title: "Memorandum",
      pageCount: 3, searchable: true, encrypted: false } as RecordEntry;

    render(<CourtRecordBuildPanel profile={COURT_PROFILE_BY_ID.get("fca-leave-response-set")!}
      cover={{}} entries={[entry]} report={{ ready: false, blockers: [], review: [],
        passes: [], pageCount: 3, inputBytes: file.size }} building={false} saving={false}
      hostMode="standalone" onBuild={vi.fn()} onDownload={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Filing set" })).toBeVisible();
    expect(screen.getAllByText(/1 source file/iu)).toHaveLength(2);
    expect(screen.getByText("Each file remains separate for filing.")).toBeVisible();
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
    expect(screen.getByText("Ready to assemble")).toBeInTheDocument();
  });

  it("does not invent a cover for an affidavit record", () => {
    const file = new File(["test"], "affidavit.pdf", { type: "application/pdf" });
    const entry = { id: "source", kindId: "affidavit", file, title: "Affidavit",
      pageCount: 3, searchable: true, encrypted: false } as RecordEntry;

    render(<CourtRecordBuildPanel profile={COURT_PROFILE_BY_ID.get("ab-kb-affidavit-exhibits")!}
      cover={{}} entries={[entry]} report={{ ready: false, blockers: [], review: [],
        passes: [], pageCount: 3, inputBytes: file.size }} building={false} saving={false}
      hostMode="standalone" onBuild={vi.fn()} onDownload={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Record" })).toBeVisible();
    expect(screen.getByText("The source pages will be combined without adding a cover."))
      .toBeVisible();
    expect(screen.queryByText("Fake cover")).not.toBeInTheDocument();
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
