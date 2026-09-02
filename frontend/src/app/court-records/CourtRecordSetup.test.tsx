// @vitest-environment jsdom

import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { COURT_PROFILE_BY_ID } from "./profiles";
import { CourtRecordChooser, CourtRecordSetup } from "./CourtRecordSetup";
import type { CoverValues } from "./types";

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
    <output data-testid="filing-party-id">{cover.filingPartyId}</output></>
  );
}

describe("CourtRecordSetup parties", () => {
  it("changes the style once, accepts multiple parties, and selects the filer by name", async () => {
    const user = userEvent.setup();
    render(<Setup />);

    expect(screen.getByLabelText(/Application under/u)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Party style"), "action");
    expect(screen.queryByLabelText(/Application under/u)).not.toBeInTheDocument();
    const plaintiffs = screen.getByRole("region", { name: /Plaintiff/u });
    const defendants = screen.getByRole("region", { name: /Defendant/u });
    await user.type(within(plaintiffs).getByLabelText("Plaintiff 1"), "Ada North");
    expect(screen.getByTestId("filing-party-id")).toHaveTextContent("party-a-1");
    expect(screen.queryByRole("combobox", { name: /Filing party/u })).toBeNull();
    await user.click(within(plaintiffs).getByRole("button", { name: "Add plaintiff" }));
    await user.type(within(plaintiffs).getByLabelText("Plaintiff 2"), "Acme Ltd.");
    expect(screen.getByTestId("filing-party-id")).toBeEmptyDOMElement();
    await user.type(within(defendants).getByLabelText("Defendant 1"), "River South");
    await user.click(screen.getByRole("button", { name: "Add intervener" }));
    await user.type(within(screen.getByRole("region", { name: "Intervener" })).getByLabelText("Intervener 1"), "Justice Centre");

    const filingParty = screen.getByRole("combobox", { name: /Filing party/u });
    expect(filingParty).toHaveDisplayValue("Choose party");
    await user.selectOptions(filingParty,
      screen.getByRole("option", { name: "Acme Ltd. — Plaintiff" }));
    expect(filingParty).toHaveDisplayValue("Acme Ltd. — Plaintiff");
    expect(screen.queryByText(/First party|Second party/u)).not.toBeInTheDocument();
  });
});

it("selects a document directly when it has only one format", async () => {
  const user = userEvent.setup();
  function Chooser() {
    const [profile, setProfile] = useState(COURT_PROFILE_BY_ID.get("general-affidavit-exhibits")!);
    return <>
      <CourtRecordChooser profile={profile} onProfile={(id) => setProfile(COURT_PROFILE_BY_ID.get(id)!)} />
      <output>{profile.id}</output>
    </>;
  }
  render(<Chooser />);

  await user.click(screen.getByRole("button", { name: "Document: Affidavit with exhibits" }));
  expect(screen.queryByRole("button", { name: "Court Record" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Informal motion letter" }));
  expect(screen.getByText("fca-informal-motion-letter")).toBeInTheDocument();
  expect(screen.queryByRole("dialog", { name: /format/u })).toBeNull();
});

it("keeps the format chooser open when the document chooser closes", async () => {
  const user = userEvent.setup();
  function Chooser() {
    const [profile, setProfile] = useState(COURT_PROFILE_BY_ID.get("general-affidavit-exhibits")!);
    return <>
      <CourtRecordChooser profile={profile} onProfile={(id) => setProfile(COURT_PROFILE_BY_ID.get(id)!)} />
      <output>{profile.id}</output>
    </>;
  }
  render(<Chooser />);

  await user.click(screen.getByRole("button", { name: "Document: Affidavit with exhibits" }));
  await user.click(screen.getByRole("button", { name: "Motion record" }));
  const formats = screen.getByRole("dialog", { name: "Motion record format" });
  await user.click(within(formats).getByRole("button", { name: /^FC\b.*Moving party$/u }));
  expect(screen.getByText("fc-motion-record-moving")).toBeInTheDocument();
});
