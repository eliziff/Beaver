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
});
