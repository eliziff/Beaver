// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CourtRecordDocuments } from "./CourtRecordDocuments";
import { COURT_PROFILE_BY_ID } from "./profiles";
import type { CourtProfile, RecordEntry } from "./types";

const profile = { documentKinds: [{ id: "authorities", label: "Authorities",
  description: "", requirement: "optional", order: 1 }],
  technical: { indexDate: "none" }, outputMode: "separate-files" } as CourtProfile;
const required = { profile, entries: [], entryFindings: new Map(),
  onFiles: vi.fn(), onDescription: vi.fn(), onEntry: vi.fn(), onRemove: vi.fn(), onMove: vi.fn(),
  onAssign: vi.fn() };

describe("Court Record draft-output slot", () => {
  it("is an explicit Beaver capability and remains absent in standalone", () => {
    const onDraftOutput = vi.fn();
    const { rerender } = render(<CourtRecordDocuments {...required}
      onDraftOutput={onDraftOutput} />);
    fireEvent.click(screen.getByRole("button", { name: "Draft output" }));
    expect(onDraftOutput).toHaveBeenCalledWith("authorities");
    rerender(<CourtRecordDocuments {...required} />);
    expect(screen.queryByRole("button", { name: "Draft output" })).toBeNull();
  });

  it("keeps affidavit files in a pool and assigns them to referenced slots", () => {
    const affidavit = { id: "affidavit", kindId: "affidavit",
      file: new File(["affidavit"], "affidavit.pdf"), title: "Affidavit", pageCount: 1,
      searchable: true, encrypted: false, sourceFields: { cover: {}, exhibitLabels: ["A", "B"] } } as RecordEntry;
    const exhibit = { id: "pool", kindId: "exhibit", file: new File(["one"], "letter.pdf"),
      title: "Letter", pageCount: 1, searchable: true, encrypted: false } as RecordEntry;
    const onAssign = vi.fn(), onFiles = vi.fn();
    render(<CourtRecordDocuments {...required} profile={COURT_PROFILE_BY_ID.get("ab-kb-affidavit-exhibits")!}
      kindIds={["exhibit"]} entries={[affidavit, exhibit]} onAssign={onAssign} onFiles={onFiles} />);

    expect(screen.getByRole("region", { name: "Exhibit A slot" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Exhibit C slot" })).toBeVisible();
    expect(screen.getByText("Unassigned files")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Move .* (?:up|down)/ })).toBeNull();
    fireEvent.drop(screen.getByRole("region", { name: "Exhibit B slot" }), {
      dataTransfer: { getData: () => "pool" },
    });
    expect(onAssign).toHaveBeenCalledWith("pool", "B");
    fireEvent.change(screen.getByLabelText("Add files"), {
      target: { files: [new File(["a"], "a.pdf"), new File(["b"], "b.pdf")] },
    });
    expect(onFiles).toHaveBeenCalledWith("exhibit", expect.any(Array));
    expect(onFiles.mock.calls[0][1]).toHaveLength(2);
  });
});
