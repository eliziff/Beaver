import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import QuoteCheckWorkflow from "./QuoteCheckWorkflow";
import { QuoteReviewModal } from "./QuoteReviewModal";
import type { Workflow } from "@/app/lib/api/workflows";

const api = vi.hoisted(() => ({ response: vi.fn(), upload: vi.fn(), download: vi.fn(), save: vi.fn(), directory: vi.fn() }));
vi.mock("@/app/lib/api/workflows", () => ({ streamQuoteCheck: api.response }));
vi.mock("@/app/lib/api/documents", () => ({
  directoryResource: api.directory,
  downloadDocument: api.download
}));
vi.mock("@/app/lib/download", () => ({ downloadBlob: api.save }));
const source = { id: "source-1", filename: "Submissions.docx", current_version_id: "version-1", project_id: "project-1", folder_id: "folder-1" };
vi.mock("@/app/components/shared/FileDirectory", () => ({ FileDirectory: ({ onChange, documentFilter }: any) =>
  <button onClick={() => onChange([source])} disabled={!documentFilter(source)}>Select submissions</button> }));
const quote = { id: "q1", quote: "Quoted passage", status: "matched", detail: "Text matches the source.", context: "Document context", candidates: [], receipt: { text: "Source passage" } };
const workbook = { id: "report-1", filename: "Submissions - quotation check.xlsx", current_version_id: "report-version" };
const stream = (...events: unknown[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
beforeEach(() => {
  vi.clearAllMocks();
  api.directory.mockReturnValue({ uploadDocument: api.upload });
  api.response.mockResolvedValue(stream({ quote, completed: 1, total: 1 }, { done: true, workbook }));
});

it("checks the selected document version and downloads its saved workbook", async () => {
  const workflow: Workflow = { id: "quote-checking", user_id: null, is_system: true, created_at: "",
    metadata: { title: "Review quotations", description: "Check wording.", category: "Research and verification",
      audiences: ["general"], contributors: [], language: "English", version: "1", jurisdictions: [] },
    launcher: { kind: "quote_check", variants: [] } };
  render(<QuoteReviewModal workflow={workflow} documents={[source]} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.click(screen.getByRole("button", { name: "Check quotations" }));
  const download = await screen.findByRole("button", { name: workbook.filename });
  expect(api.response).toHaveBeenCalledWith("source-1", "version-1");
  const blob = new Blob(["workbook"]);
  api.download.mockResolvedValue({ blob, filename: workbook.filename });
  fireEvent.click(download);
  await waitFor(() => expect(api.save).toHaveBeenCalledWith(blob, workbook.filename));
  expect(api.download).toHaveBeenCalledWith("report-1", "report-version");
});

it("selects a saved document when no source is attached and keeps partial results after interruption", async () => {
  api.response.mockResolvedValue(stream({ quote, completed: 1, total: 2 }));
  render(<QuoteCheckWorkflow />);
  expect(screen.getByRole("button", { name: "Check quotations" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Choose document" }));
  fireEvent.click(screen.getByRole("button", { name: "Select submissions" }));
  fireEvent.click(screen.getByRole("button", { name: "Use document" }));
  fireEvent.click(screen.getByRole("button", { name: "Check quotations" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("interrupted");
  expect(screen.getByText("Quoted passage")).toBeVisible();
  expect(screen.queryByRole("button", { name: workbook.filename })).toBeNull();
});

it("saves uploaded source files in the contextual project folder before checking", async () => {
  api.upload.mockResolvedValue({ ...source, id: "uploaded-1", current_version_id: "uploaded-version" });
  render(<QuoteCheckWorkflow documents={[source]} />);
  const file = new File(["docx"], "New.docx");
  fireEvent.change(screen.getByLabelText("Upload document to check"), { target: { files: [file] } });
  await screen.findByRole("button", { name: workbook.filename });
  expect(api.directory).toHaveBeenCalledWith({ projectId: "project-1" });
  expect(api.upload).toHaveBeenCalledWith(file, "folder-1");
  expect(api.response).toHaveBeenCalledWith("uploaded-1", "uploaded-version");
});
