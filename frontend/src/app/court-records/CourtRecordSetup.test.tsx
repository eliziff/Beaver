// @vitest-environment jsdom

import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { COURT_PROFILE_BY_ID } from "./profiles";
import { CourtRecordChooser, CourtRecordSetup } from "./CourtRecordSetup";
import type { CoverIssueId, CoverValues } from "./types";

function Setup() {
  const [cover, setCover] = useState<CoverValues>({});
  return (
    <><CourtRecordSetup
      profile={COURT_PROFILE_BY_ID.get("fc-motion-record-moving")!}
      cover={cover}
      missingFields={new Set()}
      heading="Case details"
      onCover={(field, value) => setCover((current) => ({ ...current, [field]: value }))}
    />
    <output data-testid="filing-party-ids">{cover.filingPartyIds?.join(",")}</output></>
  );
}

function Ap5Setup({ missingFields = new Set<CoverIssueId>() }: {
  missingFields?: Set<CoverIssueId>;
} = {}) {
  const [cover, setCover] = useState<CoverValues>({ partyStyleId: "action-plaintiff",
    partyGroups: [
      { id: "party-a", role: "Appellant", roleBelow: "Plaintiff",
        parties: [{ id: "appellant", name: "Ada North" }] },
      { id: "party-b", role: "Respondent", roleBelow: "Defendant",
        parties: [{ id: "respondent", name: "River South" }] },
      { id: "intervener", role: "Intervener", roleBelow: "Intervener",
        parties: [{ id: "intervener", name: "Justice Centre" }] },
    ], filingPartyIds: ["appellant"] });
  return <><CourtRecordSetup profile={COURT_PROFILE_BY_ID.get("ab-ca-extracts-appellant")!}
    cover={cover} missingFields={missingFields} heading="Case details"
    onCover={(field, value) => setCover((current) => ({ ...current, [field]: value }))} />
    <output data-testid="ap5-cover">{JSON.stringify(cover)}</output></>;
}

describe("CourtRecordSetup parties", () => {
  it("changes the style once, accepts multiple parties, and selects the filer by name", async () => {
    const user = userEvent.setup();
    render(<Setup />);

    expect(screen.getByRole("combobox", { name: /Style of cause/ })).toBeVisible();
    expect(screen.queryByLabelText(/Application under/u)).not.toBeInTheDocument();
    const required = screen.getByRole("textbox", { name: "Court file number" });
    const optional = screen.getByRole("textbox", { name: "Fax" });
    expect(required.compareDocumentPosition(optional) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    expect(optional).toBeVisible();
    expect(screen.getByLabelText(/Style of cause/u)).toHaveDisplayValue("Choose style");
    await user.selectOptions(screen.getByLabelText(/Style of cause/u), "action");
    expect(screen.queryByLabelText(/Application under/u)).not.toBeInTheDocument();
    const plaintiffs = screen.getByRole("region", { name: /Plaintiff/u });
    const defendants = screen.getByRole("region", { name: /Defendant/u });
    await user.type(within(plaintiffs).getByLabelText("Plaintiff 1"), "Ada North");
    expect(screen.getByTestId("filing-party-ids")).toHaveTextContent("party-a-1");
    expect(screen.queryByRole("group", { name: /Filing parties/u })).toBeNull();
    await user.click(within(plaintiffs).getByRole("button", { name: "Add plaintiff" }));
    await user.type(within(plaintiffs).getByLabelText("Plaintiff 2"), "Acme Ltd.");
    expect(screen.getByTestId("filing-party-ids")).toBeEmptyDOMElement();
    await user.type(within(defendants).getByLabelText("Defendant 1"), "River South");
    await user.click(screen.getByRole("button", { name: "Add intervener" }));
    await user.type(within(screen.getByRole("region", { name: "Intervener" })).getByLabelText("Intervener 1"), "Justice Centre");

    const filingParties = screen.getByRole("group", { name: /Filing parties/u });
    await user.click(within(filingParties).getByRole("checkbox", {
      name: "Ada North — Plaintiff",
    }));
    await user.click(within(filingParties).getByRole("checkbox", {
      name: "Acme Ltd. — Plaintiff",
    }));
    expect(screen.getByTestId("filing-party-ids").textContent?.split(",")).toHaveLength(2);
    expect(screen.queryByText(/First party|Second party/u)).not.toBeInTheDocument();
  });

  it("keeps completed party fields visible for review", async () => {
    const user = userEvent.setup();
    render(<CourtRecordSetup
      profile={COURT_PROFILE_BY_ID.get("fc-motion-record-moving")!}
      cover={{ partyStyleId: "application", partyGroups: [
        { id: "party-a", role: "Applicant", parties: [{ id: "a", name: "Ada North" }] },
        { id: "party-b", role: "Respondent", parties: [{ id: "b", name: "River South" }] },
      ], filingPartyIds: ["a"] }}
      missingFields={new Set()} heading="Case details" onCover={() => undefined}
    />);

    expect(screen.getByRole("textbox", { name: "Applicant 1" })).toHaveValue("Ada North");
    expect(screen.getByRole("region", { name: /^Applicant/u })).toBeVisible();
  });

  it("selects the sole filer left after the selected party is removed", async () => {
    const user = userEvent.setup();
    render(<Setup />);
    await user.selectOptions(screen.getByLabelText(/Style of cause/u), "action");
    const plaintiffs = screen.getByRole("region", { name: /Plaintiff/u });
    await user.type(within(plaintiffs).getByLabelText("Plaintiff 1"), "Ada North");
    await user.click(within(plaintiffs).getByRole("button", { name: "Add plaintiff" }));
    await user.type(within(plaintiffs).getByLabelText("Plaintiff 2"), "Acme Ltd.");
    await user.click(screen.getByRole("checkbox", { name: /Acme Ltd\./u }));
    await user.click(within(plaintiffs).getByRole("button", { name: "Remove plaintiff 2" }));
    expect(screen.getByTestId("filing-party-ids")).toHaveTextContent("party-a-1");
  });

  it("keeps separate AP-5 contacts on each non-filing party", async () => {
    const user = userEvent.setup();
    render(<Ap5Setup />);
    const respondent = screen.getByText("Contact for River South").closest("fieldset")!;
    const intervener = screen.getByText("Contact for Justice Centre").closest("fieldset")!;
    expect(within(respondent).getByRole("textbox", { name: "Lawyer or filing person for River South" })).toBeVisible();
    await user.type(within(respondent).getByRole("textbox", {
      name: "Lawyer or filing person for River South",
    }), "R. Counsel");
    await user.type(within(intervener).getByRole("textbox", {
      name: "Lawyer or filing person for Justice Centre",
    }), "I. Counsel");

    const saved = JSON.parse(screen.getByTestId("ap5-cover").textContent!) as CoverValues;
    expect(saved.partyGroups?.[1].parties[0].contact?.name).toBe("R. Counsel");
    expect(saved.partyGroups?.[2].parties[0].contact?.name).toBe("I. Counsel");
    expect(screen.queryByText(/Other party.s lawyer/u)).not.toBeInTheDocument();
  });

  it("marks only the AP-5 contact details needed to reach another party", () => {
    render(<Ap5Setup missingFields={new Set(["partyContacts"])} />);
    const details = screen.getByText(/Contact for River South/u).closest("fieldset")!;
    expect(details).toHaveAttribute("data-contact-finding-id", "contact-respondent");
    expect(details.querySelector('[aria-label="Lawyer or filing person for River South"]'))
      .toHaveAttribute("required");
    expect(details.querySelector('[aria-label="Fax (or N/A) for River South"]'))
      .not.toHaveAttribute("required");
  });
});

it("keeps jurisdiction and court levels in one dialog and skips singleton formats", async () => {
  const user = userEvent.setup();
  function Chooser() {
    const [profile, setProfile] = useState(COURT_PROFILE_BY_ID.get("general-affidavit-exhibits")!);
    return <>
      <CourtRecordChooser profile={profile} onProfile={(id) => setProfile(COURT_PROFILE_BY_ID.get(id)!)} />
      <output>{profile.id}</output>
    </>;
  }
  render(<Chooser />);

  expect(screen.queryByRole("button", { name: /^Format:/u })).toBeNull();
  await user.click(screen.getByRole("button", { name: /^Change format:/u }));
  expect(screen.getByRole("dialog", { name: "Choose document" })).toBeVisible();
  await user.click(within(screen.getByRole("dialog", { name: "Choose document" }))
    .getByRole("button", { name: "Close" }));
  await user.click(screen.getByRole("button", { name: /^Change format:/u }));
  const dialog = screen.getByRole("dialog", { name: "Choose document" }), jurisdictions = within(dialog);
  expect(jurisdictions.getByRole("option", { name: "Alberta" })).toBeInTheDocument();
  expect(jurisdictions.getByRole("option", { name: "No court preset" })).toBeInTheDocument();
  expect(jurisdictions.queryByRole("option", { name: /British Columbia/ })).not.toBeInTheDocument();
  await user.selectOptions(jurisdictions.getByRole("combobox", { name: "Jurisdiction" }), "ca");
  expect(screen.getByRole("dialog", { name: "Choose document" })).toBe(dialog);

  const documents = within(screen.getByRole("dialog", { name: "Choose document" }));
  expect(documents.getByRole("tab", { name: "Trial" })).toHaveAttribute("aria-selected", "true");
  await user.click(documents.getByRole("tab", { name: "Appeal" }));
  expect(screen.getByRole("dialog", { name: "Choose document" })).toBe(dialog);
  await user.click(documents.getByRole("button", { name: "Informal motion letter" }));
  expect(screen.getByRole("button", { name: /^Change format:/u })).toBeVisible();
  expect(screen.getByText("fca-informal-motion-letter")).toBeInTheDocument();
  expect(screen.queryByRole("dialog", { name: /format/u })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Format:/u })).toBeNull();
});

it("keeps the format chooser open and distinguishes reply formats", async () => {
  const user = userEvent.setup();
  function Chooser() {
    const [profile, setProfile] = useState(COURT_PROFILE_BY_ID.get("general-affidavit-exhibits")!);
    return <>
      <CourtRecordChooser profile={profile} onProfile={(id) => setProfile(COURT_PROFILE_BY_ID.get(id)!)} />
      <output>{profile.id}</output>
    </>;
  }
  render(<Chooser />);

  await user.click(screen.getByRole("button", { name: /^Change format:/u }));
  const dialog = screen.getByRole("dialog", { name: "Choose document" });
  await user.selectOptions(screen.getByRole("combobox", { name: "Jurisdiction" }), "ca");
  await user.click(within(screen.getByRole("dialog", { name: "Choose document" }))
    .getByRole("button", { name: "Motion record" }));
  expect(screen.getByRole("dialog", { name: "Choose document" })).toBe(dialog);
  const formats = screen.getByRole("group", { name: "Motion record format" });
  expect(within(formats).getByRole("button", { name: "Motion reply — moving party" }))
    .toBeVisible();
  await user.click(within(formats).getByRole("button", { name: "Motion record — moving" }));
  expect(screen.getByText("fc-motion-record-moving")).toBeInTheDocument();
});

it("discards an abandoned court choice before opening the current format", async () => {
  const user = userEvent.setup();
  render(<CourtRecordChooser
    profile={COURT_PROFILE_BY_ID.get("fc-motion-record-moving")!}
    onProfile={() => undefined}
  />);

  await user.click(screen.getByRole("button", { name: /^Change format:/u }));
  await user.selectOptions(screen.getByRole("combobox", { name: "Jurisdiction" }), "ab");
  const documents = screen.getByRole("dialog", { name: "Choose document" });
  await user.click(within(documents).getByRole("button", { name: "Close" }));
  await user.click(screen.getByRole("button", { name: /^Change format:/u }));
  expect(screen.getByRole("combobox", { name: "Jurisdiction" })).toHaveValue("ca");
  expect(screen.getByRole("group", { name: "Motion record format" })).toBeVisible();
});

it("selects the singleton document without an extra format step", async () => {
  const user = userEvent.setup(), onProfile = vi.fn();
  render(<CourtRecordChooser profile={COURT_PROFILE_BY_ID.get("fc-motion-record-moving")!}
    onProfile={onProfile} />);

  await user.click(screen.getByRole("button", { name: /^Change format:/u }));
  const dialog = screen.getByRole("dialog", { name: "Choose document" });
  await user.selectOptions(screen.getByRole("combobox", { name: "Jurisdiction" }), "general");
  expect(screen.getByRole("dialog", { name: "Choose document" })).toBe(dialog);
  await user.click(within(dialog).getByRole("button", { name: "Affidavit" }));
  expect(onProfile).toHaveBeenCalledWith("general-affidavit-exhibits");
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("starts a new record unselected and only cancels on an explicit close", async () => {
  const user = userEvent.setup(), onCancel = vi.fn();
  render(<CourtRecordChooser creating
    profile={COURT_PROFILE_BY_ID.get("general-affidavit-exhibits")!}
    onProfile={() => undefined} onCancel={onCancel} />);

  const dialog = screen.getByRole("dialog", { name: "Choose document" }), jurisdictions = within(dialog);
  expect(jurisdictions.getByRole("combobox", { name: "Jurisdiction" })).toHaveValue("");
  await user.selectOptions(jurisdictions.getByRole("combobox", { name: "Jurisdiction" }), "ca");
  expect(screen.getByRole("dialog", { name: "Choose document" })).toBe(dialog);
  expect(onCancel).not.toHaveBeenCalled();
  await user.click(within(screen.getByRole("dialog", { name: "Choose document" }))
    .getByRole("button", { name: "Close" }));
  expect(onCancel).toHaveBeenCalledOnce();
});
