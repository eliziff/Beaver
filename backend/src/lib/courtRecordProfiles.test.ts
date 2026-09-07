import { describe, expect, it } from "vitest";
import catalogueJson from "mike/shared/court-record-profiles.json";
import registry from "mike/shared/court-registry.json";
import { compileCourtRecordProfiles, type CourtRecordCatalogue } from "mike/shared/court-record-profiles.mjs";

const catalogue = () => structuredClone(catalogueJson) as unknown as CourtRecordCatalogue;
const compile = (value: CourtRecordCatalogue) => compileCourtRecordProfiles(value,
  registry.courts as Parameters<typeof compileCourtRecordProfiles>[1]);

describe("Court Record catalogue", () => {
  it("resolves whole slot rules without sharing mutable rule objects between profiles", () => {
    const input = catalogue(), before = structuredClone(input), profiles = compile(input);
    const slot = (id: string, kind = "other-document") => profiles.find((p) => p.id === id)!
      .documentKinds.find((item) => item.id === kind)!;
    const first = slot("general-affidavit-exhibits"), second = slot("ab-kb-affidavit-exhibits");
    expect(first).toEqual(second);
    first.label = "Changed in one profile";
    first.acceptedFormats!.push("pdf");
    expect(second.label).toBe("Other document");
    expect(second.acceptedFormats).toEqual(["pdf", "docx"]);
    slot("ab-kb-chambers-justice-applicant-set", "affidavit")
      .acceptedWorkProductOutputs![0].role = "changed";
    expect(slot("ab-kb-chambers-applications-judge-applicant-set", "affidavit")
      .acceptedWorkProductOutputs![0].role).toBe("record");
    expect(input).toEqual(before);
  });

  it("checks one-of choices against expanded slot IDs, not catalogue reference names", () => {
    const input = catalogue();
    input.profiles = [{ ...input.profiles[0], slots: ["chambers-supporting-affidavit"],
      oneOf: [{ label: "Evidence", slots: ["affidavit"] }] }];
    expect(compile(input)[0].documentKinds).toMatchObject([{ id: "affidavit" }]);
    input.profiles[0].oneOf![0].slots = ["chambers-supporting-affidavit"];
    expect(() => compile(input)).toThrow("Invalid Court Record slots");
  });

  const invalid: Array<[string, (value: CourtRecordCatalogue) => void]> = [
    ["Duplicate Court Record profile", (c) => { c.profiles.push(c.profiles[0]); }],
    ["Duplicate Court Record party style or group id", (c) => { c.partyStyles.push(c.partyStyles[0]); }],
    ["Duplicate Court Record party style or group id", (c) => { c.partyStyles[0].groups.push(c.partyStyles[0].groups[0]); }],
    ["Missing Court Record court", (c) => { c.profiles[0].courtId = "missing"; }],
    ["Missing Court Record cover field", (c) => { c.profiles[0].cover.fieldKeys = ["missing"]; }],
    ["Missing Court Record technical definition", (c) => { c.profiles[0].technical = "missing"; }],
    ["Missing Court Record party style", (c) => { c.profiles[0].partyStyleIds = ["missing"]; }],
    ["Missing Court Record slot definition", (c) => { c.profiles[0].slots = ["missing"]; }],
    ["Missing Court Record slot definition", (c) => { c.profiles[0].slots = ["toString"]; }],
    ["Missing Court Record technical definition", (c) => { c.profiles[0].technical = "toString"; }],
    ["Invalid Court Record slots", (c) => { c.profiles[0].slots = ["affidavit", "affidavit"]; }],
    ["Invalid Court Record filing group", (c) => { c.profiles[0].filingGroupId = "missing"; }],
    ["Invalid Court Record conditional field", (c) => {
      c.profiles[0].cover.fieldKeys = ["applicationUnder"]; c.profiles[0].partyStyleIds = ["appeal"];
    }],
  ];
  it.each(invalid)("rejects %s", (message, change) => {
    const input = catalogue(); change(input);
    expect(() => compile(input)).toThrow(message);
  });
});
