import { describe, expect, it } from "vitest";

import { structureNative } from "../../structureNative";

const { groundedProseErrors, quoteRepairSuggestion } = structureNative();

const passage =
  "If rent is unpaid when due, the landlord may deliver a written notice " +
  "to terminate the lease not less than seven business days after receipt " +
  "of the notice by the tenant.";

const source = (evidenceId: string, text: string, labels?: string[]) =>
  ({ evidenceId, text, labels });

describe("quote verification", () => {
  it("accepts exact inline and block quotations", () => {
    const text = "🦫 The court wrote “exact words” here.\r> A CR block.\r\n> A CRLF block.\u2028> A line-separator block.\u2029> A paragraph-separator block.";
    expect(groundedProseErrors(text, ["e"], [source("e",
      "The reasons contain exact words. A CR block. A CRLF block. A line-separator block. A paragraph-separator block.")]))
      .toEqual([]);
  });

  it("returns only a sufficiently strong verbatim repair", () => {
    const repaired = quoteRepairSuggestion(
      "the landlord may deliver a written notice to terminate the lease within seven calendar days",
      [passage],
    );
    expect(repaired).toContain(
      "the landlord may deliver a written notice to terminate the lease",
    );
    expect(quoteRepairSuggestion(
      "Municipal recall elections are governed by a comprehensive scheme.",
      [passage],
    )).toBeNull();
  });

  it("accepts only representation changes or visibly marked monotonic edits", () => {
    const available =
      "The busybody must decide 12 motions, promptly, before the hearing continues.";
    const errors = (quote: string, text = available) => groundedProseErrors(
      `“${quote}”`, ["e"], [source("e", text)],
    );
    expect(errors(
      "The\u00a0busybody must decide 12 motions, promptly, before the hearing continues.",
    )).toEqual([]);
    expect(errors('The court called it "unusual".',
      "The court called it “unusual”.")).toEqual([]);
    expect(errors(
      "[T]he busybod[ies] must decide 12 motions, promptly, before the hearing continues.",
    )).toEqual([]);
    expect(errors("The busybody … before the hearing continues.")).toEqual([]);
    expect(errors(`The busybody ${"… ".repeat(5)}before the hearing continues.`))
      .toHaveLength(1);
    expect(errors(available, `${"x".repeat(50_001)}${available}`)).toEqual([]);
    for (const changed of [
      "the busybody must decide 12 motions, promptly, before the hearing continues.",
      "The busybody may decide 12 motions, promptly, before the hearing continues.",
      "The busybody must decide 13 motions, promptly, before the hearing continues.",
      "The busybody must decide 12 motions promptly before the hearing continues.",
    ]) expect(errors(changed)).toHaveLength(1);
  });

  it("rejects substantial unmarked copying from any visible receipt", () => {
    const copied =
      "Courts should not decide constitutional issues in a factual vacuum without evidence.";
    const sources = [source("e_cited", passage), source("e_visible", copied)];
    expect(groundedProseErrors(copied, ["e_cited"], sources)[0])
      .toContain("visible evidence e_visible");
    expect(groundedProseErrors(`The court said “${copied}”`, ["e_visible"], sources))
      .toEqual([]);
    expect(groundedProseErrors(`> ${copied}`, ["e_visible"], sources))
      .toEqual([]);
    expect(groundedProseErrors(
      "Courts should not decide constitutional issues automatically.",
      ["e_cited"], sources,
    )).toEqual([]);
    for (const insignificant of [
      "Constitutional adjudication requires evidentiary foundations before intervention.",
      "Courts must decide facts using law and evidence.",
      "that the and which there from these with their there which that the and",
    ]) expect(groundedProseErrors(insignificant, ["e"], [source("e", insignificant)]))
      .toEqual([]);
    const title = "A Treatise About Constitutional Standing and Legal Remedies";
    expect(groundedProseErrors(title, ["e"], [source("e",
      `${title}. Further discussion follows.`, [title])])).toEqual([]);
  });
});
