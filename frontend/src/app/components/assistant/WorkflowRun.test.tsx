import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { WorkflowRunButton, WorkflowRunPanel } from "./WorkflowRun";
import type { WorkflowRunEvent } from "@/app/lib/api/chat";

describe("WorkflowRunPanel", () => {
  it.each([
    ["court-record", "Court Records", "/court-records?draft=record-1"],
    ["authorities", "Authorities", "/table-of-authorities?draft=record-1"],
  ] as const)("opens a %s result in its workspace", (kind, label, href) => {
    const run: WorkflowRunEvent = { type: "workflow_run", id: "run-1",
      tool: "update_work_product", stage: "Update", status: "complete",
      work_product: { kind, id: "record-1", revision: 1 } };
    render(<MemoryRouter>
      <WorkflowRunButton run={run} onOpen={() => undefined} />
      <WorkflowRunPanel run={run} />
    </MemoryRouter>);

    expect(screen.getByRole("button", { name: `${label}: complete` })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: label })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: `Open ${label}` })).toHaveAttribute("href", href);
  });

  it("keeps changing progress and errors clear", () => {
    const run: WorkflowRunEvent = { type: "workflow_run", id: "run-2",
      tool: "create_table_of_authorities", stage: "Downloading decisions", status: "running",
      progress: 60, counts: [{ label: "Downloaded", value: 3 }] };
    const { rerender } = render(<MemoryRouter><WorkflowRunPanel run={run} /></MemoryRouter>);

    expect(screen.getByRole("status")).toHaveTextContent("Downloading decisions");
    expect(screen.getByText("60%")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    rerender(<MemoryRouter><WorkflowRunPanel run={{ ...run, status: "error",
      error: "Download failed" }} /></MemoryRouter>);
    expect(screen.getByRole("alert")).toHaveTextContent("Download failed");
  });
});
