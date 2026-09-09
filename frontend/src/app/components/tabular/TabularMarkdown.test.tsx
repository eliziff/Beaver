import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { TabularMarkdown } from "./TabularMarkdown";
import type { ColumnFormat } from "@/app/lib/api/tabular";
import { groundedAnswerMarkdown, type GroundedEvidence } from "@/app/lib/groundedAnswers";

it("renders tabular pills and citations through one shared path", async () => {
    const evidence = { evidence_id: "original-receipt", provider: "library", stable_source_id: "document-1",
        version: "version-7", name: "Rule.pdf", citation: "Rule.pdf", span_text: "The quoted rule.",
        locator: { kind: "page", label: "7" } } as GroundedEvidence;
    const answer = groundedAnswerMarkdown({ claims: [{ text: "**Result**", evidence_ids: [evidence.evidence_id] }], evidence: [evidence] });
    render(<TabularMarkdown {...answer} />);

    expect(screen.getByText("Result")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Rule.pdf, p. 7" })).toHaveAttribute("href", "/library?document_id=document-1&version_id=version-7");
    expect(screen.queryByRole("button", { name: "Citation actions" })).toBeNull();
});

it.each<[ColumnFormat, string, string | number | boolean | string[]]>([
    ["text", "A complete answer.", "A complete answer."],
    ["bulleted_list", "- First finding\n- Second finding", ["First finding", "Second finding"]],
])("preserves the displayed value for %s", (format, text, value) => {
    const { container } = render(<TabularMarkdown text={text} value={value}
        column={{ format }} />);
    expect(container).toHaveTextContent(text.replace(/^- /gmu, "").replace("\n", " "));
    if (format === "bulleted_list") expect(screen.getAllByRole("listitem")).toHaveLength(2);
});

it("shows ISO dates as short locale dates and leaves other dates alone", () => {
    const column = { format: "date" as const };
    const { container, rerender } = render(<TabularMarkdown text="05 September 2026" value="2026-09-05" column={column} />);
    expect(container).toHaveTextContent(/^(Sep|Sept)\.? 5, 2026$|^5 (Sep|Sept)\.? 2026$/u);
    rerender(<TabularMarkdown text="early 2026" value="early 2026" column={column} />);
    expect(container).toHaveTextContent("early 2026");
});

it("folds long bulleted lists into three inline items in a grid cell", () => {
    render(<TabularMarkdown inline text="- a\n- b\n- c\n- d\n- e" value={["a", "b", "c", "d", "e"]}
        column={{ format: "bulleted_list" }} />);
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["a", "b", "c", "+2"]);
});
