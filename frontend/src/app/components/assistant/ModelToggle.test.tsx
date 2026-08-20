import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { getModelCatalog } from "@/app/lib/beaverApi";
import { ModelEffortToggle } from "./ModelToggle";

vi.mock("@/app/lib/beaverApi", () => ({ getModelCatalog: vi.fn() }));
const getCatalog = vi.mocked(getModelCatalog);

beforeEach(() => {
  localStorage.clear();
  getCatalog.mockReset();
  getCatalog.mockResolvedValue({
    source: "live",
    models: [{
      slug: "gpt-5.6-terra",
      displayName: "GPT-5.6 Terra",
      defaultReasoningLevel: "medium",
      supportedReasoningLevels: [{ effort: "low" }, { effort: "medium" }],
    }],
  });
});

it("does not start model discovery until the user opens the model selector", async () => {
  render(
    <ModelEffortToggle
      model="codex:gpt-5.6-terra"
      effort="medium"
      onModelChange={vi.fn()}
      onEffortChange={vi.fn()}
    />,
  );

  const modelButton = screen.getByRole("button", { name: /^Model:/ });
  expect(modelButton).toHaveTextContent("GPT 5.6 Terra");
  expect(getCatalog).not.toHaveBeenCalled();

  fireEvent.click(modelButton);

  await waitFor(() => expect(getCatalog).toHaveBeenCalledTimes(1));
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
});

it("shows a persisted Sol effort before lazy model discovery", () => {
  render(
    <ModelEffortToggle
      model="codex:gpt-5.6-sol"
      effort="max"
      onModelChange={vi.fn()}
      onEffortChange={vi.fn()}
    />,
  );

  expect(screen.getByRole("button", { name: "Reasoning effort: max" }))
    .toHaveTextContent("max");
  expect(getCatalog).not.toHaveBeenCalled();
});

it("shows the Sol default effort before lazy model discovery", () => {
  render(
    <ModelEffortToggle
      model="codex:gpt-5.6-sol"
      onModelChange={vi.fn()}
      onEffortChange={vi.fn()}
    />,
  );

  expect(screen.getByRole("button", { name: "Reasoning effort: low" }))
    .toHaveTextContent("low");
  expect(getCatalog).not.toHaveBeenCalled();
});
