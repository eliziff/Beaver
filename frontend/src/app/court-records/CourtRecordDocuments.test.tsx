// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { CourtRecordDocuments } from "./CourtRecordDocuments";
import { COURT_PROFILE_BY_ID } from "./profiles";
import type { CourtProfile, RecordEntry } from "./types";

const profile = { documentKinds: [{ id: "authorities", label: "Authorities",
  description: "", requirement: "optional", order: 1 }],
  technical: { indexDate: "none" }, outputMode: "separate-files" } as CourtProfile;
const required = { profile, entries: [], entryFindings: new Map(),
  onFiles: vi.fn(), onDescription: vi.fn(), onEntry: vi.fn(), onRemove: vi.fn(),
  onAssign: vi.fn(), onAssignKind: vi.fn() };

describe("Court Record documents", () => {
  it("offers Library or file upload, not record drafts, as slot sources", () => {
    const onLibrary = vi.fn();
    const { rerender } = render(<CourtRecordDocuments {...required}
      onLibrary={onLibrary} />);
    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    expect(onLibrary).toHaveBeenCalledWith("authorities");
    expect(screen.queryByRole("button", { name: "Draft output" })).toBeNull();
    rerender(<CourtRecordDocuments {...required} />);
    expect(screen.queryByRole("button", { name: "Library" })).toBeNull();
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
    expect(screen.getByRole("region", { name: "Exhibit B slot" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Exhibit C slot" })).toBeNull();
    expect(screen.getByText("Unassigned files")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Move .* (?:up|down)/ })).toBeNull();
    fireEvent.drop(screen.getByRole("region", { name: "Exhibit B slot" }), {
      dataTransfer: { getData: () => "pool" },
    });
    expect(onAssign).toHaveBeenCalledWith("pool", "B");
    fireEvent.change(screen.getAllByLabelText("Add file")[0], {
      target: { files: [new File(["a"], "a.pdf"), new File(["b"], "b.pdf")] },
    });
    expect(onFiles).toHaveBeenCalledWith("exhibit", expect.any(Array));
    expect(onFiles.mock.calls[0][1]).toHaveLength(2);
  });

  it("shows only the fulfilled one-of slot until its entry is removed", () => {
    const transcript = { id: "transcript", kindId: "part-3-transcript",
      file: new File(["transcript"], "transcript.pdf"), title: "Transcript", pageCount: 1,
      searchable: true, encrypted: false } as RecordEntry;
    function AppealDocuments() {
      const [entries, setEntries] = useState([transcript]);
      return <CourtRecordDocuments {...required}
        profile={COURT_PROFILE_BY_ID.get("ab-ca-appeal-record")!} entries={entries}
        onRemove={(id) => setEntries((current) => current.filter((entry) => entry.id !== id))} />;
    }
    render(<AppealDocuments />);

    expect(screen.getByRole("heading", { name: /Part 3 .* Transcript/u })).toBeVisible();
    expect(screen.queryByRole("textbox", { name: /Part 3 .* No oral record/u })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove transcript.pdf" }));
    expect(screen.getByRole("heading", { name: /Part 3 .* Transcript/u })).toBeVisible();
    expect(screen.getByRole("textbox", { name: /Part 3 .* No oral record/u })).toBeVisible();
  });

  it("groups required slots before visible optional slots", () => {
    render(<CourtRecordDocuments {...required}
      profile={COURT_PROFILE_BY_ID.get("fc-application-record-applicant")!} />);

    const requiredGroup = screen.getByRole("region", { name: "Required documents" });
    const otherGroup = screen.getByRole("region", { name: "Other documents" });
    expect(within(requiredGroup).getByText("Notice of application")).toBeVisible();
    expect(within(requiredGroup).getByText("Memorandum of fact and law")).toBeVisible();
    expect(within(otherGroup).getByText("Supporting affidavit and exhibits")).toBeVisible();
    expect(requiredGroup.compareDocumentPosition(otherGroup) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    expect(screen.queryByText("Required")).toBeNull();
  });

  it("keeps the required affidavit slot before its exhibit pool", () => {
    const affidavit = { id: "affidavit", kindId: "affidavit",
      file: new File(["affidavit"], "affidavit.pdf"), title: "Affidavit", pageCount: 1,
      searchable: true, encrypted: false, sourceFields: { cover: {}, exhibitLabels: ["A"] } } as RecordEntry;
    render(<CourtRecordDocuments {...required}
      profile={COURT_PROFILE_BY_ID.get("ab-kb-affidavit-exhibits")!}
      kindIds={["affidavit", "exhibit"]} entries={[affidavit]} />);

    const requiredGroup = screen.getByRole("region", { name: "Required documents" });
    const exhibitSlot = screen.getByRole("region", { name: "Exhibit A slot" });
    expect(within(requiredGroup).getByText("Affidavit")).toBeVisible();
    expect(requiredGroup.compareDocumentPosition(exhibitSlot) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
  });

  it("edits repeatable physical-exhibit descriptions inline", () => {
    const first = { id: "physical-1", kindId: "physical-exhibit",
      file: new File([], "description-only"), title: "Scale model", pageCount: 0,
      searchable: null, encrypted: null, descriptionOnly: true } as RecordEntry;
    const second = { ...first, id: "physical-2", title: "Original map" };
    const onEntry = vi.fn(), onRemove = vi.fn(), onDescription = vi.fn();
    render(<CourtRecordDocuments {...required}
      profile={COURT_PROFILE_BY_ID.get("fc-application-record-applicant")!}
      entries={[first, second]} onEntry={onEntry} onRemove={onRemove}
      onDescription={onDescription} />);

    expect(screen.queryByRole("button", { name: "Add description" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Description of physical exhibit 1"), {
      target: { value: "Registry scale model" },
    });
    expect(onEntry).toHaveBeenCalledWith("physical-1", { title: "Registry scale model" });
    fireEvent.change(screen.getByLabelText("Description of physical exhibit 2"), {
      target: { value: "" },
    });
    expect(onRemove).toHaveBeenCalledWith("physical-2");
    fireEvent.click(screen.getByRole("button", { name: "Add another description" }));
    expect(onDescription).toHaveBeenCalledWith("physical-exhibit");
  });
});
