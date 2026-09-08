import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { getModelCatalog } from "@/app/lib/api/account";
import { ModelEffortToggle } from "./ModelToggle";
import { preloadModelCatalog } from "@/app/lib/modelCatalog";

vi.mock("@/app/lib/api/account", () => ({
  getModelCatalog: vi.fn()
}));
const getCatalog = vi.mocked(getModelCatalog);

beforeEach(() => {
  localStorage.clear();
  getCatalog.mockReset();
  getCatalog.mockResolvedValue({
    models: [{ id: "codex:gpt-5.6-terra", label: "GPT-5.6 Terra", group: "Codex",
      available: true, reasoningEfforts: ["low", "medium"], defaultReasoningEffort: "medium" }],
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
  expect(modelButton).toHaveTextContent("Terra");
  expect(getCatalog).not.toHaveBeenCalled();

  fireEvent.click(modelButton);

  await waitFor(() => expect(getCatalog).toHaveBeenCalledTimes(1));
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
});

it("preserves persisted effort without guessing an undiscovered model default", () => {
  render(
    <ModelEffortToggle
      model="codex:gpt-5.6-sol"
      effort="max"
      onModelChange={vi.fn()}
      onEffortChange={vi.fn()}
    />,
  );

  expect(screen.getByRole("button", { name: /^Model:.*max/ }))
    .toHaveTextContent("max");
  expect(getCatalog).not.toHaveBeenCalled();

  render(
    <ModelEffortToggle
      model="codex:gpt-5.6-sol"
      onModelChange={vi.fn()}
      onEffortChange={vi.fn()}
    />,
  );

  expect(screen.getByRole("button", { name: /^Model:.*Automatic/ }))
    .toHaveTextContent("Automatic");
  expect(getCatalog).not.toHaveBeenCalled();
});

it("changes model and supported effort without leaving the picker", async () => {
  function Picker() {
    const [model, setModel] = useState("codex:gpt-5.6-sol");
    const [effort, setEffort] = useState("max");
    return <ModelEffortToggle model={model} effort={effort}
      onModelChange={setModel} onEffortChange={setEffort} />;
  }
  render(<Picker />);
  fireEvent.click(screen.getByRole("button", { name: /^Model:/ }));
  fireEvent.click(await screen.findByRole("button", { name: "GPT-5.6 Terra" }));
  expect(screen.getByRole("dialog")).toBeVisible();
  const effort = screen.getByRole("radio", { name: "low" });
  fireEvent.click(effort);
  expect(effort).toBeChecked();
  expect(screen.getByRole("dialog")).toBeVisible();
});

it("updates mounted pickers when settings refreshes the shared catalog", async () => {
  render(<ModelEffortToggle model="codex:catalog-fixture" onModelChange={vi.fn()} onEffortChange={vi.fn()} />);
  getCatalog.mockResolvedValue({ models: [{ id: "codex:catalog-fixture", label: "Updated fixture",
    group: "Codex", reasoningEfforts: ["medium"], defaultReasoningEffort: "medium" }] });
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
  try {
    await act(async () => { await preloadModelCatalog(); });
    expect(screen.getByRole("button", { name: /^Model: Updated fixture/ })).toBeVisible();
  } finally { clock.mockRestore(); }
});
