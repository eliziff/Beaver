import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import type { ResearchFile } from "@/app/lib/researchFiles";
import type { ResearchTablePlan } from "@/app/lib/api/researchFiles";
import { SourcesWorkspaceProvider } from "../legal/SourcesWorkspace";
import { SaveResearchPassages } from "../legal/SaveResearchPassages";
import { AddResearchSources } from "../legal/AddResearchSources";
import { ImportResearchSet } from "./ImportResearchSet";
import { ColumnLabelsDialog } from "./ColumnLabelsDialog";

const api = vi.hoisted(() => ({ getResearchFile: vi.fn(), previewResearchTable: vi.fn(), openWorkspaceTable: vi.fn(),
  queryWorkspaceFindings: vi.fn(), saveFindingHighlights: vi.fn(), actOnResearchFile: vi.fn(),
  previewColumnLabels: vi.fn(), applyColumnLabels: vi.fn(), listDirectory: vi.fn() }));
vi.mock("@/app/lib/api/researchFiles", async (original) => ({ ...await original<typeof import("@/app/lib/api/researchFiles")>(), ...api }));
vi.mock("@/app/lib/api/documents", async (original) => ({ ...await original<typeof import("@/app/lib/api/documents")>(), directoryResource: () => ({ list: api.listDirectory }) }));
const file = { document: { id: "workspace", filename: "Research.research.md", file_type: "md" }, versionId: "v1", workingRevision: 0,
  state: { labels: { topic: { id: "topic", name: "Relevance", scope: "source", parentId: null, order: 0, color: null },
    test: { id: "test", name: "Test", scope: "highlight", parentId: null, order: 0, color: "#d6b656" } }, sources: {}, note: "" } } as unknown as ResearchFile;
const reference = { kind: "answer" as const, chatId: "chat", answerId: "answer", resource: "source" };
const support = { evidence_id: "e_support", scope: "passage", name: "Example case", span_text: "Exact supporting passage.", locator: { label: "4" } };
const finding = { reference, sourceId: "source", resource: "source", question: { title: "Reason", prompt: "Why?" },
  answer: { claims: [{ text: "Original finding.", evidence_ids: [support.evidence_id] }] },
  evidence: [support, { ...support, evidence_id: "e_read", span_text: "Merely read, not support." }] };
const plan: ResearchTablePlan = { title: "Research", basis: "original-basis", selection: { target: "sources", sourceIds: ["source"] },
  versionId: "v1", workingRevision: 0, findingRefs: [reference], columns: [{ index: 0, name: "Reason", prompt: "Why?", format: "text", fieldIds: ["reason"] },
    { index: 1, name: "Remedy", prompt: "What remedy?", format: "text", fieldIds: [] }],
  fields: [{ id: "reason", name: "Original finding", kind: "claim", rows: 1, samples: ["Original finding."] }],
  reuse: [{ index: 0, reused: 1, unrun: 0, kinds: ["claim"] }, { index: 1, reused: 0, unrun: 1, kinds: [] }],
  arrangement: { rows: [{ id: "source", sourceId: "source", title: "Example case" }] }, preview: [{ title: "Example case", values: ["Original finding.", ""] }] };
function provider(children: React.ReactNode) { return <MemoryRouter><SourcesWorkspaceProvider file={file}>{children}</SourcesWorkspaceProvider></MemoryRouter>; }
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); api.getResearchFile.mockResolvedValue(file);
  api.previewResearchTable.mockResolvedValue(plan); api.openWorkspaceTable.mockResolvedValue({ id: "review" });
  api.queryWorkspaceFindings.mockResolvedValue({ items: [finding], total: 1, next_offset: null }); api.saveFindingHighlights.mockResolvedValue(file);
  api.actOnResearchFile.mockResolvedValue(file); api.previewColumnLabels.mockResolvedValue({ title: "Reason", basis: "basis",
    mapping: [{ value: "Generally helpful", label: "Generally helpful", sources: 2 }, { value: "Helpful analogy", label: "Helpful analogy", sources: 1 }] });
  api.applyColumnLabels.mockResolvedValue(file); });

it("shows existing answers and unrun questions, requires a fresh preview after editing, then carries the exact mapping and basis", async () => {
  const onOpen = vi.fn(); render(<ImportResearchSet open fileId="workspace" selection={plan.selection} onClose={vi.fn()} onOpen={onOpen} />);
  await screen.findByText("Original finding."); expect(screen.getByText("Not run")).toBeVisible();
  expect(api.openWorkspaceTable).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Reason", { selector: "summary span.font-medium" }));
  fireEvent.change(screen.getByLabelText("Column 1 title"), { target: { value: "Why this result?" } });
  expect(screen.getByRole("button", { name: "Create review" })).toBeDisabled();
  const changed = { ...plan, basis: "new-basis", columns: [{ ...plan.columns[0], name: "Why this result?" }, plan.columns[1]] };
  api.previewResearchTable.mockResolvedValue(changed);
  fireEvent.click(screen.getByRole("button", { name: "Update preview" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Create review" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Create review" }));
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith("/tabular-reviews/review"));
  expect(api.openWorkspaceTable).toHaveBeenCalledWith("workspace", expect.objectContaining({ basis: "new-basis", columns: changed.columns, selection: plan.selection }));
});

it("applies optional assistant suggestions only to the preview and keeps failed saves visible", async () => {
  render(<ImportResearchSet open fileId="workspace" onClose={vi.fn()} onOpen={vi.fn()} />);
  await screen.findByText("Original finding.");
  fireEvent.click(screen.getByText("Suggest a different review"));
  fireEvent.change(screen.getByLabelText("What to compare"), { target: { value: "Separate holding from remedy" } });
  api.previewResearchTable.mockResolvedValue({ ...plan, title: "Suggested design" });
  fireEvent.click(screen.getByRole("button", { name: "Suggest columns" }));
  await waitFor(() => expect(screen.getByLabelText("Review title")).toHaveValue("Suggested design"));
  expect(api.previewResearchTable).toHaveBeenLastCalledWith("workspace", expect.objectContaining({ request: "Separate holding from remedy" }), expect.any(AbortSignal));
  expect(api.openWorkspaceTable).not.toHaveBeenCalled();
  api.openWorkspaceTable.mockRejectedValue(new Error("The research changed. Refresh the preview."));
  fireEvent.click(screen.getByRole("button", { name: "Create review" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("The research changed");
  expect(screen.getByRole("dialog")).toBeVisible(); expect(screen.getByText("Original finding.")).toBeVisible();
});

it("does not broaden inherited passage scope until the user explicitly chooses another research scope", async () => {
  const selection = { target: "passages" as const, sourceIds: ["source"], evidenceIds: ["e_selected"] };
  render(<ImportResearchSet open fileId="workspace" selection={selection} onClose={vi.fn()} onOpen={vi.fn()} />);
  await screen.findByText("Original finding.");
  expect(api.previewResearchTable).toHaveBeenLastCalledWith("workspace", expect.objectContaining({ selection }), expect.any(AbortSignal));
  fireEvent.change(screen.getByLabelText("Research scope"), { target: { value: "all" } });
  await waitFor(() => expect(api.previewResearchTable).toHaveBeenLastCalledWith("workspace", expect.objectContaining({ selection: { target: "sources" } }), expect.any(AbortSignal)));
});

it("leaves collection unhighlighted by default, excludes unrelated reads, and saves only chosen support under one type", async () => {
  const onDone = vi.fn(); render(<SaveResearchPassages fileId="workspace" references={[reference]} collect onClose={vi.fn()} onDone={onDone} />);
  await screen.findByText("Exact supporting passage.");
  expect(screen.queryByText("Merely read, not support.")).not.toBeInTheDocument();
  expect(api.saveFindingHighlights).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox", { name: "Save selected supporting passages as highlights" }));
  fireEvent.change(screen.getByLabelText("Save as highlight type"), { target: { value: "test" } });
  fireEvent.click(screen.getByRole("button", { name: "Open research" }));
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  expect(api.saveFindingHighlights).toHaveBeenCalledWith(file, { references: [reference], evidenceIds: ["e_support"], typeId: "test" });
});

it("consolidates column values into an existing source-label group only after explicit proposal", async () => {
  const done = vi.fn(); render(provider(<ColumnLabelsDialog input={{ reviewId: "review", columnIndex: 0 }} onClose={vi.fn()} onApplied={done} />));
  await screen.findByDisplayValue("Generally helpful");
  fireEvent.change(screen.getByLabelText("Label for value 1"), { target: { value: "Useful" } });
  fireEvent.change(screen.getByLabelText("Label for value 2"), { target: { value: "Useful" } });
  fireEvent.change(screen.getByLabelText("Parent source label"), { target: { value: "topic" } });
  expect(api.applyColumnLabels).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Propose labels" }));
  await waitFor(() => expect(done).toHaveBeenCalled());
  expect(api.applyColumnLabels).toHaveBeenCalledWith("workspace", { reviewId: "review", columnIndex: 0, basis: "basis", parentId: "topic",
    mapping: [{ value: "Generally helpful", label: "Useful" }, { value: "Helpful analogy", label: "Useful" }] });
});

it("adds pinned Library references to the current virtual folder as one atomic research action", async () => {
  const document = { id: "document", filename: "Decision.txt", file_type: "txt", current_version_id: "original-version" };
  api.listDirectory.mockResolvedValue({ items: [{ kind: "document", document }], next_cursor: null });
  render(provider(<AddResearchSources labelId="topic" onClose={vi.fn()} onAdded={vi.fn()} />));
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select Decision.txt" }));
  expect(api.actOnResearchFile).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Add sources" }));
  await waitFor(() => expect(api.actOnResearchFile).toHaveBeenCalledWith("workspace", "v1", 0, { type: "batch", title: "Add Library sources", actions: [
    { type: "source", reference: { provider: "library", kind: "document", id: "document", versionId: "original-version", title: "Decision.txt" }, labelIds: ["topic"] },
  ] }));
});
