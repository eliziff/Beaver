import { expect, it } from "vitest";
import type { ResearchLabelDesign } from "@/app/lib/api/researchFiles";
import { editResearchProposal, mergeResearchProposal } from "./researchProposalDraft";

it("edits hierarchy and assignments without allowing cycles or dropping merged children", () => {
  const design: ResearchLabelDesign = { title: "Research", sourceLabels: [
    { id: "a", name: "Security", members: ["row"], children: [{ id: "b", name: "Prejudice", members: [], children: [] }] },
    { id: "c", name: "Recourse", members: [], children: [] }], highlightTypes: [] };
  const metadata = { sources: [{ id: "row", title: "A source" }], items: [] };
  expect(() => editResearchProposal(design, metadata, { type: "label", id: "a", name: "Security", parentId: "b" })).toThrow();
  expect(() => mergeResearchProposal(design, "a", "b")).toThrow();
  const merged = mergeResearchProposal(design, "a", "c");
  expect(merged.sourceLabels).toMatchObject([{ id: "c", members: ["row"], children: [{ id: "b" }] }]);
  expect(design.sourceLabels).toHaveLength(2);
  const added = editResearchProposal(merged, metadata, { type: "annotate", kind: "source", id: "row", labelIds: ["b"] });
  expect(added.sourceLabels[0].members).toEqual(["row"]);
  expect(added.sourceLabels[0].children[0].members).toEqual(["row"]);
});

it("moves one supported passage without moving other passages or accepting cross-source references", () => {
  const first = { sourceId: "source", evidenceId: "first" }, second = { sourceId: "source", evidenceId: "second" };
  const design: ResearchLabelDesign = { title: "Research", sourceLabels: [], highlightTypes: [
    { id: "a", name: "Prejudice", children: [], members: [first, second] },
    { id: "b", name: "Waiver", children: [], members: [] }] };
  const metadata = { sources: [{ id: "source", title: "A source" }], items: [first, second].map((member) =>
    ({ ...member, title: "A source", text: member.evidenceId })) };
  const action = { type: "annotate" as const, kind: "evidence" as const, id: "first", sourceId: "source", labelIds: ["b"] };
  const edited = editResearchProposal(design, metadata, action);
  expect(edited.highlightTypes[0].members).toEqual([second]);
  expect(edited.highlightTypes[1].members).toEqual([first]);
  expect(() => editResearchProposal(design, metadata, { ...action, sourceId: "other" })).toThrow();
  expect(design.highlightTypes[0].members).toEqual([first, second]);
});
