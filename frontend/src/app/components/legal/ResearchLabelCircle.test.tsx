import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { researchLabelColor, ResearchLabelCircle } from "./ResearchLabelCircle";

const labels = {
  root: { id: "root", name: "Root", parentId: null, color: "#1d4ed8", order: 0, scope: "source" as const },
  child: { id: "child", name: "Child", parentId: "root", color: "#047857", order: 1, scope: "source" as const },
  detail: { id: "detail", name: "Detail", parentId: "child", color: "#991b1b", order: 2, scope: "source" as const },
};

describe("ResearchLabelCircle", () => {
  it("keeps the primary folder in front of its hierarchy and shows additional memberships on its face", () => {
    render(<ResearchLabelCircle labels={labels} labelIds={["detail", "root"]} />);
    const stack = screen.getByRole("group", { name: "Labels: Root / Child / Detail, Root" });
    expect(stack.querySelector('[data-label-layer="primary"]')).toHaveAttribute("fill", "#1d4ed8");
    expect(stack.querySelector('[data-label-layer="middle"]')).toHaveAttribute("fill", "#047857");
    expect(stack.querySelector('[data-label-layer="inner"]')).toHaveAttribute("fill", "#991b1b");
    expect([...stack.querySelectorAll("[data-label-layer]")].map((layer) => layer.getAttribute("fill")))
      .toEqual(["#991b1b", "#047857", "#1d4ed8"]);
    expect(stack.querySelector('[data-additional-label="root"]')).toHaveAttribute("fill", "#1d4ed8");
  });

  it("keeps an unassigned stack outlined", () => {
    render(<ResearchLabelCircle labels={labels} labelIds={[]} size="sm" />);
    expect(screen.getByRole("group", { name: "No labels" })).toHaveAttribute("data-empty", "true");
  });

  it("shares the saved-label scope defaults", () => {
    expect(researchLabelColor({ ...labels.root, color: null })).toBe("#3498db");
    expect(researchLabelColor({ ...labels.root, color: null, scope: "highlight" })).toBe("#eab308");
  });
});
