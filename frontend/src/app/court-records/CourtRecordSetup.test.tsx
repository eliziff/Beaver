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
    const plaintiffs = screen.getByRole("textbox", { name: "Plaintiff name" });
    await user.type(plaintiffs, "Ada North");
    expect(screen.getByTestId("filing-party-ids")).toHaveTextContent("party-a-1");
    await user.click(screen.getByRole("button", { name: "Add plaintiff" }));
    await user.type(screen.getByRole("textbox", { name: "Plaintiff name 2" }), "Acme Ltd.");
    await user.type(screen.getByLabelText("Defendant name"), "River South");
    await user.type(screen.getByLabelText("Intervener name"), "Justice Centre");

    const filingParties = screen.getByRole("group", { name: /Filing parties/u });
    expect(within(filingParties).getByRole("checkbox", { name: /Ada North/u })).toBeChecked();
    await user.click(within(filingParties).getByRole("checkbox", {
      name: "Acme Ltd. — Plaintiff",
    }));
    expect(screen.getByTestId("filing-party-ids").textContent?.split(",")).toHaveLength(2);
    expect(screen.queryByText(/First party|Second party/u)).not.toBeInTheDocument();
  });

  it("keeps completed party fields visible for review", async () => {
    render(<CourtRecordSetup
      profile={COURT_PROFILE_BY_ID.get("fc-motion-record-moving")!}
      cover={{ partyStyleId: "application", partyGroups: [
        { id: "party-a", role: "Applicant", parties: [{ id: "a", name: "Ada North" }] },
        { id: "party-b", role: "Respondent", parties: [{ id: "b", name: "River South" }] },
      ], filingPartyIds: ["a"] }}
      missingFields={new Set()} heading="Case details" onCover={() => undefined}
    />);

    expect(screen.getByRole("textbox", { name: "Applicant name" })).toHaveValue("Ada North");

  });

  it("selects the sole filer left after the selected party is removed", async () => {
    const user = userEvent.setup();
    render(<Setup />);
    await user.selectOptions(screen.getByLabelText(/Style of cause/u), "action");
    await user.type(screen.getByLabelText("Plaintiff name"), "Ada North");
    await user.click(screen.getByRole("button", { name: "Add plaintiff" }));
    await user.type(screen.getByLabelText("Plaintiff name 2"), "Acme Ltd.");
    await user.click(screen.getByRole("checkbox", { name: /Ada North/u }));
    await user.click(screen.getByRole("checkbox", { name: /Acme Ltd\./u }));
    await user.click(screen.getByRole("button", { name: "Remove Plaintiff 2" }));
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

function Chooser({ initial = "general-affidavit-exhibits", order }: {
  initial?: string; order?: string[];
}) {
  const [profile, setProfile] = useState(COURT_PROFILE_BY_ID.get(initial)!);
  return <>
    <CourtRecordChooser profile={profile} jurisdictionOrder={order}
      onProfile={(id) => setProfile(COURT_PROFILE_BY_ID.get(id)!)} />
    <output>{profile.id}</output>
  </>;
}

it("picks a court record in one jurisdiction-first dialog", async () => {
  const user = userEvent.setup();
  render(<Chooser />);

  await user.click(screen.getByRole("button", { name: /^Change document:/u }));
  const dialog = screen.getByRole("dialog", { name: "Choose document" });
  const jurisdictions = within(within(dialog).getByRole("group", { name: "Jurisdiction" }));
  expect(jurisdictions.getByRole("button", { name: "Alberta" })).toBeVisible();
  expect(jurisdictions.getByRole("button", { name: "No court preset" }))
    .toHaveAttribute("aria-pressed", "true");

  await user.click(jurisdictions.getByRole("button", { name: "Federal courts" }));
  expect(screen.getByRole("dialog", { name: "Choose document" })).toBe(dialog);
  const documents = within(within(dialog).getByRole("group", { name: "Choose document" }));
  expect(documents.getAllByRole("button", { name: /^Motion record$/u })[0]).toBeVisible();
  await user.click(documents.getByRole("button", { name: "Informal motion letter" }));

  expect(screen.getByText("fca-informal-motion-letter")).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("shows the configured jurisdictions first and keeps the rest listed", async () => {
  const user = userEvent.setup();
  render(<Chooser order={["ca-ab"]} />);

  await user.click(screen.getByRole("button", { name: /^Change document:/u }));
  const jurisdictions = within(screen.getByRole("group", { name: "Jurisdiction" }))
    .getAllByRole("button").map((button) => button.textContent);
  expect(jurisdictions[0]).toBe("Alberta");
  expect(jurisdictions).toContain("Federal courts");
  expect(jurisdictions).toContain("No court preset");
});

it("discards an abandoned jurisdiction before reopening on the current court", async () => {
  const user = userEvent.setup();
  render(<Chooser initial="fc-motion-record-moving" />);

  await user.click(screen.getByRole("button", { name: /^Change document:/u }));
  await user.click(within(screen.getByRole("group", { name: "Jurisdiction" }))
    .getByRole("button", { name: "Alberta" }));
  await user.click(within(screen.getByRole("dialog", { name: "Choose document" }))
    .getByRole("button", { name: "Close" }));
  await user.click(screen.getByRole("button", { name: /^Change document:/u }));

  expect(within(screen.getByRole("group", { name: "Jurisdiction" }))
    .getByRole("button", { name: "Federal courts" })).toHaveAttribute("aria-pressed", "true");
});

it("starts a new record without a selection", async () => {
  const user = userEvent.setup(), onCancel = vi.fn(), onProfile = vi.fn();
  render(<CourtRecordChooser creating
    profile={COURT_PROFILE_BY_ID.get("general-affidavit-exhibits")!}
    jurisdictionOrder={["ca-federal"]} onProfile={onProfile} onCancel={onCancel} />);

  const dialog = screen.getByRole("dialog", { name: "Choose document" });
  expect(within(dialog).getByRole("group", { name: "Jurisdiction" })).toBeVisible();
  await user.click(within(dialog).getByRole("button", { name: "Trial record" }));
  expect(onProfile).toHaveBeenCalledWith("fc-trial-record");
  expect(onCancel).not.toHaveBeenCalled();
});

it("cancels a new record on an explicit close", async () => {
  const user = userEvent.setup(), onCancel = vi.fn();
  render(<CourtRecordChooser creating
    profile={COURT_PROFILE_BY_ID.get("general-affidavit-exhibits")!}
    onProfile={() => undefined} onCancel={onCancel} />);

  await user.click(within(screen.getByRole("dialog", { name: "Choose document" }))
    .getByRole("button", { name: "Close" }));
  expect(onCancel).toHaveBeenCalledOnce();
});

