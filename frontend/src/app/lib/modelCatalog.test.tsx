import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { getModelCatalog } from "@/app/lib/api/account";
import { ModelToggle } from "@/app/components/assistant/ModelToggle";

vi.mock("@/app/lib/api/account", () => ({ getModelCatalog: vi.fn() }));

it("lists the cached models while the background refresh is still running", () => {
  localStorage.setItem("beaver.modelCatalog.v1", JSON.stringify({ catalog: {
    models: [{ id: "codex:cached-fixture", label: "Cached fixture", group: "Codex", available: true }],
  } }));
  vi.mocked(getModelCatalog).mockReturnValue(new Promise(() => undefined));
  render(<ModelToggle value="codex:cached-fixture" onChange={vi.fn()} />);

  fireEvent.click(screen.getByRole("button", { name: /^Model:/ }));

  expect(screen.getByRole("button", { name: "Cached fixture" })).toBeVisible();
});
