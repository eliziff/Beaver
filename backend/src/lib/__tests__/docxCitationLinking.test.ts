import { describe, expect, it } from "vitest";
import {
  resolveDocxCitationLinks,
  type DocxCitationIntent,
  type DocxCitationLinkPlan,
} from "../docxCitationLinking";

function intent(
  partId: string,
  kind: string,
  citation: string,
): DocxCitationIntent {
  return {
    part_id: partId,
    verbatim: citation,
    kind,
    bare_citation: citation,
    citation_with_style: citation,
    short_form: "",
    support_quote: "",
    locator_kind: "none",
    locator: "",
  };
}

describe("DOCX citation linking", () => {
  it("keeps unresolved and unsafe resolver output out of the DOCX link map", async () => {
    const plan: DocxCitationLinkPlan = {
      schema_version: "legalpdf.docx_link_plan.v1",
      source_sha256: "abc",
      footnotes: [
        {
          parts: [
            intent("1:1", "case", "2024 SCC 10"),
            intent("2:1", "case", "467 U.S. 837"),
            intent("3:1", "book", "A Treatise"),
          ],
        },
      ],
    };
    const resolved = await resolveDocxCitationLinks(plan, async (part) => {
      if (part.part_id === "1:1") {
        return {
          provider: "a2aj",
          url: "https://decisions.scc-csc.ca/example#par10",
        };
      }
      if (part.part_id === "2:1") {
        return { provider: "courtlistener", url: "file:///private/cache" };
      }
      return null;
    });

    expect(resolved.links).toEqual({
      "1:1": "https://decisions.scc-csc.ca/example#par10",
    });
    expect(resolved.providers).toEqual({ a2aj: 1 });
    expect(resolved.unresolved.map(({ part_id }) => part_id)).toEqual([
      "2:1",
      "3:1",
    ]);
  });

  it("deduplicates repeated provider lookups while linking every citation", async () => {
    const first = intent("1:1", "case", "2024 SCC 10");
    const second = { ...first, part_id: "2:1" };
    const plan: DocxCitationLinkPlan = {
      schema_version: "legalpdf.docx_link_plan.v1",
      source_sha256: "abc",
      footnotes: [{ parts: [first, second] }],
    };
    let calls = 0;
    const resolved = await resolveDocxCitationLinks(plan, async () => {
      calls += 1;
      return {
        provider: "a2aj",
        url: "https://decisions.scc-csc.ca/example#par10",
      };
    });

    expect(calls).toBe(1);
    expect(Object.keys(resolved.links)).toEqual(["1:1", "2:1"]);
  });
});
