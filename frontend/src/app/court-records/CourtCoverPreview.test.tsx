// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CourtCoverPreview } from "./CourtCoverPreview";
import { COURT_PROFILE_BY_ID } from "./profiles";
import type { CoverValues } from "./types";

const cover: CoverValues = {
  courtFileNumber: "A-102-20",
  partyStyleId: "application",
  partyGroups: [
    { id: "party-a", role: "Applicant", parties: [
      { id: "applicant-1", name: "Air Passenger Rights" },
    ] },
    { id: "party-b", role: "Respondent", parties: [
      { id: "respondent-1", name: "Canadian Transportation Agency" },
      { id: "respondent-2", name: "Attorney General of Canada" },
    ] },
  ],
  filingPartyIds: ["respondent-1", "respondent-2"],
};

describe("Federal motion cover preview", () => {
  it("derives the FCA moving and responding designations from the selected filing parties", () => {
    render(<CourtCoverPreview profile={COURT_PROFILE_BY_ID.get("fca-motion-record-moving")!}
      cover={cover} />);

    expect(screen.getByText("Applicant")).toBeInTheDocument();
    expect(screen.getByText("Respondent")).toBeInTheDocument();
  });
});
