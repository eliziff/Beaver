import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ResearchSetProduct } from "@/app/lib/researchSets";
import { ResearchSetWorkspace } from "./ResearchSetWorkspace";

const product: ResearchSetProduct = {
  id: "set-1", kind: "research-set", title: "Fairness cases", projectId: null,
  revision: 4, outputs: {}, createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  state: {
    schemaVersion: "beaver.research-set.v1",
    labels: {
      public: { id: "public", name: "Public law", parentId: null, color: "#1d4ed8" },
      fairness: { id: "fairness", name: "Fairness", parentId: "public", color: "#991b1b" },
    },
    sources: { source: { id: "source", labelIds: ["fairness"], note: "Leading case",
      reference: { provider: "a2aj", id: "baker", kind: "case",
        title: "Baker v Canada", citation: "[1999] 2 SCR 817" } } },
    evidence: { evidence: { sourceId: "source", labelIds: ["fairness"], note: "",
      receipt: { evidence_id: "evidence", provider: "a2aj", stable_source_id: "baker",
        source_sha256: "a".repeat(64), span_sha256: "b".repeat(64), block_id: "22",
        span_text: "The values underlying procedural fairness.",
        citation: "[1999] 2 SCR 817", name: "Baker v Canada", external_url: null,
        locator: { kind: "paragraph", label: "22" } } } },
    queries: {}, memo: "The governing values are clear [evidence].",
    audit: [{ at: "2026-01-02T00:00:00Z", actor: { kind: "model", id: "codex:test" },
      action: "memo", targets: [] }],
  },
};

describe("ResearchSetWorkspace", () => {
  it("queries the labelled passage subset", async () => {
    const onQuery = vi.fn(async () => ({ product, queryId: "query", failures: [],
      counts: { attemptedSources: 1, matchedSources: 1, matches: 1, failures: 0 } }));
    render(<MemoryRouter><ResearchSetWorkspace sets={[product]} product={product}
      onSelect={vi.fn()} onCreate={vi.fn()} onRename={vi.fn()} onDuplicate={vi.fn()}
      onDelete={vi.fn()} onAction={vi.fn()} onMove={vi.fn()}
      onQuery={onQuery} /></MemoryRouter>);

    fireEvent.click(screen.getByRole("button", { name: /Public law \/ Fairness/iu }));
    fireEvent.change(screen.getByRole("textbox", { name: "Query saved research" }),
      { target: { value: "procedural fairness" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Search target" }),
      { target: { value: "passages" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() => expect(onQuery).toHaveBeenCalledWith({
      text: "procedural fairness", syntax: "terms", target: "passages",
      labelIds: ["fairness"],
    }));
    expect(screen.getByRole("status")).toHaveTextContent("1 matches in 1 sources");
  });
});
