import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ResearchLabelCircle } from "./ResearchLabelCircle";

const labels = {
  public: { id: "public", name: "Public law", parentId: null, color: "#1d4ed8" },
  fairness: { id: "fairness", name: "Fairness", parentId: "public", color: "#991b1b" },
  remedy: { id: "remedy", name: "Remedy", parentId: null, color: "#047857" },
};

describe("ResearchLabelCircle", () => {
  it("keeps nested ancestry and multiple memberships distinct", () => {
    render(<ResearchLabelCircle labels={labels} labelIds={["fairness", "remedy"]} />);

    expect(screen.getByRole("group", {
      name: "Labels: Public law / Fairness, Remedy",
    })).toBeInTheDocument();
    expect(screen.getByTitle("Public law / Fairness")).toBeInTheDocument();
    expect(screen.getByTitle("Remedy")).toBeInTheDocument();
  });
});
