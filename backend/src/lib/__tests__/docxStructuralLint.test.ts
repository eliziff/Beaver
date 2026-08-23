import { describe, expect, it } from "vitest";

import { lintDocxStructure } from "../docxStructuralLint";

describe("DOCX structural lint projection", () => {
  it("turns native facts into the public lint receipt", () => {
    const structure: Parameters<typeof lintDocxStructure>[0] = {
      text: [
        "1. Definitions",
        "1.1 First",
        "1.3 Third",
        "See Section 9 and Schedule B.",
        '"Unused" means a value.',
      ].join("\n"),
      definitions: [{
        term: "Unused",
        definitions: [{ source_paragraph_id: "4" }],
        uses: [],
      }],
      docx: {
        numbering: {
          number_anchors: [
            { paragraph_index: 0 },
            { paragraph_index: 1 },
            { paragraph_index: 2 },
          ],
          roman_article_anchors: [],
          duplicates: [{ number: "1.1", paragraph_index: 2 }],
          gaps: [{
            previous_number: "1.1",
            number: "1.3",
            paragraph_index: 2,
            missing: ["1.2"],
          }],
        },
        cross_references: [{
          paragraph_index: 3,
          subject: "Section 9",
          value: "9",
          status: "MissingTopLevel",
        }],
        attachments: [{
          paragraph_index: 3,
          label: "Schedule",
          subject: "Schedule B",
          status: { Missing: { included: ["A"] } },
        }],
      },
    };

    const report = lintDocxStructure(structure);
    expect(report.checks).toEqual({
      cross_references: { references: 1, resolved: 0, skipped_external: 0 },
      attachments: { references: 1, resolved: 0 },
      numbering: { anchors: 3 },
      defined_terms: { definitions: 1 },
    });
    expect(report.findings.map(({ code }) => code)).toEqual([
      "cross_reference_missing",
      "attachment_reference_missing",
      "numbering_duplicate",
      "numbering_gap",
      "defined_term_unused",
    ]);
  });
});
