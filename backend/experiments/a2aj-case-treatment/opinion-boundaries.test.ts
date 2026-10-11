import { describe, expect, it } from "vitest";
import { packSpans, unpackSpans, packUnsigned, unpackUnsigned } from "./opinion-boundaries";
import { compileBoundaryOutput, judicialNameValues, judicialNamesFromValues } from "./opinionBoundaryOutput";
import { modelSourceLines } from "../a2aj-decision-roster/caseTargetMvpReduced";
import type { CaseMaterial } from "./contract";

const text = `PUBLIC GARDEN ACCESS REVIEW
Panel: Vale J., Orr J., Lorne J.
Reasons by Vale J.; Lorne J. joins these reasons in part.
[1] The arboretum board closed the east gate because the bridge was damaged. The record shows a safe western entrance remained open throughout the repair. We therefore uphold the temporary closure, subject to the board posting directions to that entrance.
Separate reasons by Orr J.
[2] I reach a different conclusion. The western path was flooded during the same period, so the board's supposed alternative did not exist. I would set aside the closure and require an accessible route before the board resumes its seasonal admissions programme.`;
const material: CaseMaterial = { document_id: 17, citation: "2044 XYCA 12", name: "Garden access review", date: "2044-06-17", dataset: "XYCA", language: "en", url: null,
  text, source_lines: modelSourceLines(text), citation_inventory: { authorities: [], occurrences: [] }, coverage: { status: "not_asserted", spans: [] } };
const edge = (line: number) => ({ s: line, e: line, q: null, r: null, w: [], j: [] });
const response = { k: 0, n: [], p: [], x: [], o: [edge(4), edge(6)], ev: null };

describe("compact corpus opinion boundaries", () => {
  it("round-trips source intervals including supplementary Unicode and large gaps", () => {
    const source = "🌿 gate opens\n";
    const spans: [number, number][] = [[0, source.length], [4000, 19000], [0xfffffff0, 0xffffffff]];
    const packed = packSpans(spans);
    expect(unpackSpans(packed)).toEqual(spans);
    expect(packed.length).toBeLessThan(JSON.stringify(spans).length);
    expect(unpackSpans(packSpans([]))).toEqual([]);
    expect(() => packSpans([[2, 9], [8, 10]])).toThrow();
    expect(() => unpackSpans(Buffer.from([128]))).toThrow();
    expect(() => unpackSpans(Buffer.from([0, 0]))).toThrow();
  });

  it("compiles two independently reasoned bodies without requiring authors or votes", () => {
    const compiled = compileBoundaryOutput(response, material);
    expect(compiled.errors).toEqual([]);
    expect(compiled.spans.map(([start, end]) => text.slice(start, end))).toEqual([
      text.slice(material.source_lines[3].start, material.source_lines[3].end),
      text.slice(material.source_lines[5].start, material.source_lines[5].end),
    ]);
    expect(compileBoundaryOutput({ ...response, o: [edge(4), edge(4)] }, material).errors.length).toBeGreaterThan(0);
    expect(compileBoundaryOutput({ ...response, o: [{ ...edge(4), r: "This sentence is absent." }] }, material).errors.length).toBeGreaterThan(0);
    expect(compileBoundaryOutput({ ...response, o: [edge(100)] }, material).errors.length).toBeGreaterThan(0);
    const extended = text + " Publisher note: this reproduction was typeset for the garden archive.";
    const partial = compileBoundaryOutput({ ...response, o: [edge(4), { ...edge(6), r: "seasonal admissions programme." }] }, { ...material, text: extended, source_lines: modelSourceLines(extended) });
    expect(partial.errors).toEqual([]);
    expect(partial.spans[1][1]).toBe(text.length);
  });

  it("keeps reported-only and unresolved outcomes distinct from reasons", () => {
    const reportText = "The garden gate application was dismissed without published reasons.";
    const reportMaterial = { ...material, text: reportText, source_lines: modelSourceLines(reportText) };
    expect(compileBoundaryOutput({ ...response, k: 1, o: [], ev: 1 }, reportMaterial).state).toBe(3);
    expect(compileBoundaryOutput({ ...response, k: 1, o: [], ev: null }, reportMaterial).errors.length).toBeGreaterThan(0);
    expect(compileBoundaryOutput({ ...response, k: 2, o: [] }, reportMaterial).state).toBe(4);
    expect(compileBoundaryOutput({ ...response, o: [] }, reportMaterial).errors.length).toBeGreaterThan(0);
  });

  it("records panel, writers, and qualified joins once and round-trips dictionary references", () => {
    const rich = { ...response, n: [{ n: "Vale J.", k: 0, e: 2 }, { n: "Orr J.", k: 0, e: 2 }, { n: "Lorne J.", k: 0, e: 2 }], p: [0, 1, 2],
      o: [{ ...edge(4), w: [{ i: 0, e: 3 }], j: [{ i: 2, e: 3, r: 1 }] }, { ...edge(6), w: [{ i: 1, e: 5 }] }] };
    const compiled = compileBoundaryOutput(rich, material);
    expect(compiled.errors).toEqual([]);
    expect(compiled.name_errors).toEqual([]);
    expect(compiled.compilation?.compiled?.opinions[0].writers).toEqual(["Vale J."]);
    expect(compiled.compilation?.compiled?.opinions[0].qualified_joiners[0].name).toBe("Lorne J.");
    const dictionary = ["Vale J.", "Orr J.", "Lorne J."];
    const packed = packUnsigned(judicialNameValues(compiled.names!, (name) => dictionary.indexOf(name)));
    expect(judicialNamesFromValues(unpackUnsigned(packed), (id) => dictionary[id])).toEqual(compiled.names);
    const unsupported = compileBoundaryOutput({ ...rich, n: [{ n: "Invented J.", k: 0, e: 2 }, ...rich.n.slice(1)] }, material);
    expect(unsupported.spans).toEqual(compiled.spans);
    expect(unsupported.state).toBe(2);
    expect(unsupported.names).toBeNull();
    expect(unsupported.name_errors.length).toBeGreaterThan(0);
  });
});
