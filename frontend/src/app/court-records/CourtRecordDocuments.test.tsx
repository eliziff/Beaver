// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CourtRecordDocuments } from "./CourtRecordDocuments";
import { COURT_PROFILE_BY_ID } from "./profiles";
import type { CourtProfile, RecordEntry } from "./types";

const profile = { documentKinds: [{ id: "authorities", label: "Authorities",
  requirement: "optional", order: 1 }],
  technical: { indexDate: "none" }, outputMode: "separate-files" } as CourtProfile;
const required = { profile, entries: [], entryFindings: new Map(),
  onFiles: vi.fn(), onChoose: vi.fn(), onDescription: vi.fn(), onEntry: vi.fn(), onRemove: vi.fn(),
  onAssign: vi.fn(), onAssignKind: vi.fn() };

describe("Court Record documents", () => {
  it("keeps affidavit files in a pool and assigns them to referenced slots", () => {
    const sourceSha256 = "a".repeat(64);
    const affidavit = { id: "affidavit", kindId: "affidavit",
      file: new File(["affidavit"], "affidavit.pdf"), title: "Affidavit", pageCount: 1,
      searchable: true, encrypted: false, sourceFields: { cover: {}, exhibitLabels: ["A"],
        exhibitMentions: {
          A: ["The January order is attached as Exhibit A."],
          C: ["The June email is attached as Exhibit C.",
            "The reply is also attached as Exhibit C."],
        } },
      origin: { kind: "library", sourceSha256 } } as RecordEntry;
    const exhibit = { id: "pool", kindId: "exhibit", file: new File(["one"], "letter.pdf"),
      title: "Letter", pageCount: 1, searchable: true, encrypted: false } as RecordEntry;
    const onAssign = vi.fn(), onFiles = vi.fn(), onAddExhibit = vi.fn();
    render(<CourtRecordDocuments {...required} profile={COURT_PROFILE_BY_ID.get("ab-kb-affidavit-exhibits")!}
      kindIds={["exhibit"]} entries={[affidavit, exhibit]} onAssign={onAssign} onFiles={onFiles}
      onAddExhibit={onAddExhibit} />);

    const slotA = screen.getByRole("region", { name: "Exhibit A slot" });
    const slotB = screen.getByRole("region", { name: "Exhibit B slot" });
    const slotC = screen.getByRole("region", { name: "Exhibit C slot" });
    expect(slotA).toBeVisible();
    expect(slotB).toBeVisible();
    expect(slotC).toBeVisible();
    expect(within(slotA).getByText("Affidavit said:")).toBeVisible();
    expect(slotA.querySelector("details")).toBeNull();
    expect(within(slotA).getByText("The January order is attached as Exhibit A.")).toBeVisible();
    expect(within(slotB).queryByText("Affidavit said:")).toBeNull();
    const details = slotC.querySelector("details")!;
    expect(details).not.toHaveAttribute("open");
    fireEvent.click(details.querySelector("summary")!);
    expect(details).toHaveAttribute("open");
    expect(within(slotC).getByText("The reply is also attached as Exhibit C.")).toBeVisible();
    expect(screen.getByRole("heading", { name: /^Files/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Move .* (?:up|down)/ })).toBeNull();
    fireEvent.change(screen.getByLabelText("Assign letter.pdf to an exhibit"), {
      target: { value: "B" },
    });
    expect(onAssign).toHaveBeenCalledWith("pool", "B");
    fireEvent.drop(slotB, {
      dataTransfer: { getData: () => "pool" },
    });
    expect(onAssign).toHaveBeenCalledWith("pool", "B");
    fireEvent.click(screen.getByRole("button", { name: "Add exhibit" }));
    expect(onAddExhibit).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Add files" }));
    expect(required.onChoose).toHaveBeenCalledWith("exhibit", undefined);
  });

  it("asks for non-text confirmation only after OCR has run", () => {
    const scan = { id: "scan", kindId: "authorities",
      file: new File(["scan"], "photograph.pdf", { type: "application/pdf" }),
      title: "Photograph", pageCount: 1, searchable: false, encrypted: false,
      textlessPageCount: 1, textlessPages: [1] } as RecordEntry;
    const onEntry = vi.fn();
    const { rerender } = render(<CourtRecordDocuments {...required} entries={[scan]} onEntry={onEntry} />);
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    rerender(<CourtRecordDocuments {...required} entries={[{ ...scan, ocrAttemptedPages: [] }]} />);
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    rerender(<CourtRecordDocuments {...required}
      entries={[{ ...scan, ocrAttemptedPages: [1] }]} onEntry={onEntry} />);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onEntry).toHaveBeenCalledWith("scan", { nonTextPagesConfirmed: true });
  });

  it("offers the signed Form 344 PDF as a replacement for the generated certificate", () => {
    const profile = COURT_PROFILE_BY_ID.get("fca-appeal-book")!;
    const onChoose = vi.fn();
    const { rerender } = render(<CourtRecordDocuments {...required} profile={profile} onChoose={onChoose} />);
    fireEvent.click(screen.getByRole("button", { name: "Add signed PDF" }));
    expect(onChoose).toHaveBeenCalledWith("form-344", undefined);

    const signed = { id: "signed", kindId: "form-344",
      file: new File(["signed"], "form-344.pdf", { type: "application/pdf" }),
      title: "Form 344 certificate", pageCount: 1, searchable: true,
      encrypted: false } as RecordEntry;
    rerender(<CourtRecordDocuments {...required} profile={profile} entries={[signed]}
      onChoose={onChoose} />);
    expect(screen.getByRole("button", { name: "Replace" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Add signed PDF" })).toBeNull();
  });

  it("shows only the fulfilled one-of slot until its entry is removed", () => {
    const transcript = { id: "transcript", kindId: "part-3-transcript",
      file: new File(["transcript"], "transcript.pdf"), title: "Transcript", pageCount: 1,
      searchable: true, encrypted: false } as RecordEntry;
    const profile = COURT_PROFILE_BY_ID.get("ab-ca-appeal-record")!;
    const { rerender } = render(<CourtRecordDocuments {...required} profile={profile} entries={[transcript]} />);

    expect(screen.getByRole("heading", { name: /Part 3 .* Transcript/u })).toBeVisible();
    expect(screen.queryByRole("textbox", { name: /Part 3 .* No oral record/u })).toBeNull();
    rerender(<CourtRecordDocuments {...required} profile={profile} entries={[]} />);
    expect(screen.getByRole("heading", { name: /Part 3 .* Transcript/u })).toBeVisible();
    expect(screen.getByRole("textbox", { name: /Part 3 .* No oral record/u })).toBeVisible();
  });

  it("shows every slot in filing order, marking only the mandatory ones", () => {
    render(<CourtRecordDocuments {...required}
      profile={COURT_PROFILE_BY_ID.get("fc-application-record-applicant")!} />);

    const notice = screen.getByRole("heading", { name: /Notice of application/ });
    const affidavit = screen.getByRole("heading", { name: /Supporting affidavit and exhibits/ });
    const memorandum = screen.getByRole("heading", { name: /Memorandum of fact and law/ });
    expect(notice.compareDocumentPosition(affidavit) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    expect(affidavit.compareDocumentPosition(memorandum) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    expect(within(notice).getByText("Required")).toBeVisible();
    expect(within(affidavit).queryByText("Required")).toBeNull();
  });

  it("asks for the Rule 70 count only when excluded sections can affect the limit", () => {
    const profile = COURT_PROFILE_BY_ID.get("fc-application-record-applicant")!;
    const memorandum = { id: "memorandum", kindId: "memorandum",
      file: new File(["memo"], "memorandum.pdf", { type: "application/pdf" }),
      title: "Memorandum of fact and law", pageCount: 45, searchable: true,
      encrypted: false } as RecordEntry;
    const finding = { id: "rule70-pages-memorandum", level: "blocker" as const,
      title: "Enter the Parts I–IV page count", detail: "Enter the counted pages.",
      entryId: memorandum.id };
    const onEntry = vi.fn();
    const { rerender } = render(<CourtRecordDocuments {...required} profile={profile}
      entries={[memorandum]} entryFindings={new Map([[memorandum.id, [finding]]])}
      onEntry={onEntry} />);

    const input = screen.getByRole("spinbutton", { name: "Pages in Parts I–IV" });
    expect(input).toHaveAttribute("min", "1");
    expect(input).toHaveAttribute("max", "45");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Enter the counted pages.");
    fireEvent.change(input, { target: { value: "30" } });
    expect(onEntry).toHaveBeenCalledWith("memorandum", { rule70CountedPages: 30 });

    rerender(<CourtRecordDocuments {...required} profile={profile}
      entries={[{ ...memorandum, pageCount: 30 }]} />);
    expect(screen.queryByRole("spinbutton", { name: "Pages in Parts I–IV" })).toBeNull();
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

  it("keeps an incompatible description as a note, not a fake file", () => {
    const note = { id: "note", kindId: "old-description", file: new File([], "description-only"),
      title: "Original object", pageCount: 0, searchable: null, encrypted: null,
      descriptionOnly: true } as RecordEntry;
    const onEntry = vi.fn(), onRemove = vi.fn();
    render(<CourtRecordDocuments {...required} entries={[note]} showUnassigned
      onEntry={onEntry} onRemove={onRemove} />);

    expect(screen.getByRole("region", { name: "Notes" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Files" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Note" }), {
      target: { value: "Updated object" },
    });
    expect(onEntry).toHaveBeenCalledWith("note", { title: "Updated object" });
    fireEvent.change(screen.getByRole("textbox", { name: "Note" }), { target: { value: "" } });
    expect(onRemove).toHaveBeenCalledWith("note");
  });
});
