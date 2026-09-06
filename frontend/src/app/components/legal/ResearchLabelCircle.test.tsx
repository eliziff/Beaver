import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { researchLabelColor, ResearchLabelCircle } from "./ResearchLabelCircle";

const labels = {
  root: { id: "root", name: "Root", parentId: null, color: "#1d4ed8", order: 0, scope: "source" as const },
  child: { id: "child", name: "Child", parentId: "root", color: "#047857", order: 1, scope: "source" as const },
  detail: { id: "detail", name: "Detail", parentId: "child", color: "#991b1b", order: 2, scope: "source" as const },
  extra: { id: "extra", name: "Extra", parentId: null, color: "#a16207", order: 3, scope: "source" as const },
};

describe("ResearchLabelCircle", () => {
  it("shows one coloured dot per label with its full path in the accessible name", () => {
    render(<ResearchLabelCircle labels={labels} labelIds={["detail", "root"]} />);
    const dots = screen.getByRole("group", { name: "Labels: Root / Child / Detail, Root" });
    expect([...dots.querySelectorAll<HTMLElement>("[data-label-dot]")].map((dot) => dot.style.backgroundColor))
      .toEqual(["rgb(153, 27, 27)", "rgb(29, 78, 216)"]);
  });

  it("caps the dots and counts the rest", () => {
    render(<ResearchLabelCircle labels={labels} labelIds={["root", "child", "detail", "extra"]} />);
    const dots = screen.getByRole("group", { name: /^Labels:/u });
    expect(dots.querySelectorAll("[data-label-dot]")).toHaveLength(3);
    expect(dots).toHaveTextContent("+1");
  });

  it("keeps an unassigned marker outlined", () => {
    render(<ResearchLabelCircle labels={labels} labelIds={[]} size="sm" />);
    expect(screen.getByRole("group", { name: "No labels" })).toHaveAttribute("data-empty", "true");
  });

  it("shares the saved-label scope defaults", () => {
    expect(researchLabelColor({ ...labels.root, color: null })).toBe("#3498db");
    expect(researchLabelColor({ ...labels.root, color: null, scope: "highlight" })).toBe("#eab308");
  });
});
