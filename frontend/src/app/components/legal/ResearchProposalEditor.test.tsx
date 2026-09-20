import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import type { ResearchLabelDesign, ResearchLabelProposal } from "@/app/lib/api/researchFiles";
import { ResearchProposalEditor } from "./ResearchProposalEditor";

it("edits hierarchy and assignments without allowing cycles or dropping merged children", () => {
  let saved: ResearchLabelDesign;
  const design: ResearchLabelDesign = { title: "Research", sourceLabels: [
    { id: "a", name: "Security", members: ["row"], children: [{ id: "b", name: "Prejudice", members: [], children: [] }] },
    { id: "c", name: "Recourse", members: [], children: [] }], highlightTypes: [] };
  const proposal = { sources: [{ id: "row", title: "A source" }], items: [], labels: [] } as unknown as ResearchLabelProposal;
  function Editor() {
    const [current, setCurrent] = useState(design); saved = current;
    return <ResearchProposalEditor proposal={proposal} design={current} onChange={setCurrent} />;
  }
  render(<Editor />);
  const security = screen.getByText("Security", { selector: "summary" }).closest("details")!;
  fireEvent.click(within(security).getByText("Security", { selector: "summary" }));
  const controls = security.querySelector("details")!;
  fireEvent.click(within(controls).getByText("Edit category", { selector: "summary" }));
  const parent = within(controls).getByLabelText("Parent");
  expect(within(parent).queryByRole("option", { name: /Prejudice/ })).not.toBeInTheDocument();
  fireEvent.change(within(controls).getByLabelText("Merge into"), { target: { value: "c" } });
  expect(saved!.sourceLabels.find((label) => label.id === "a")).toBeUndefined();
  expect(saved!.sourceLabels[0].children[0].id).toBe("b");
  expect(saved!.sourceLabels[0].members).toEqual(["row"]);
  fireEvent.change(screen.getByLabelText("Proposal title"), { target: { value: "My organization" } });
  expect(saved!.title).toBe("My organization");
});

it("moves one supported passage without moving the other passages in its model assignment", () => {
  let saved: ResearchLabelDesign;
  const design: ResearchLabelDesign = { title: "Research", sourceLabels: [], highlightTypes: [
    { id: "a", name: "Prejudice", children: [], members: [{ sourceId: "source", evidenceId: "first" }, { sourceId: "source", evidenceId: "second" }] },
    { id: "b", name: "Waiver", children: [], members: [] }] };
  const proposal = { sources: [], labels: [], items: [
    { evidenceId: "first", sourceId: "source", title: "A source", text: "First passage" },
    { evidenceId: "second", sourceId: "source", title: "A source", text: "Second passage" }] } as unknown as ResearchLabelProposal;
  function Editor() {
    const [current, setCurrent] = useState(design); saved = current;
    return <ResearchProposalEditor proposal={proposal} design={current} onChange={setCurrent} />;
  }
  render(<Editor />);
  fireEvent.change(screen.getAllByLabelText("Move passage from Prejudice")[0], { target: { value: "b" } });
  expect(saved!.highlightTypes[0].members).toEqual([{ sourceId: "source", evidenceId: "second" }]);
  expect(saved!.highlightTypes[1].members).toEqual([{ sourceId: "source", evidenceId: "first" }]);
});
