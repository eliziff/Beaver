import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { WorkspaceHeader } from "./WorkspaceHeader";

const current = { id: "one", title: "Current record" };
const props = () => ({ current, busy: false, itemLabel: "court record",
  onBack: vi.fn(), onRename: vi.fn(), onDuplicate: vi.fn(), onDelete: vi.fn() });

it("uses one workspace rail for static and active states", () => {
  const { rerender } = render(<WorkspaceHeader title="Court Records" />);
  const rail = screen.getByRole("heading").closest("[data-workspace-header]");
  expect(rail).toHaveTextContent("Court Records");
  rerender(<WorkspaceHeader {...props()} />);
  expect(screen.getByRole("heading", { name: current.title })
    .closest("[data-workspace-header]")).toBe(rail);
});

it("keeps the current draft and its actions in one header", async () => {
  const user = userEvent.setup(), handlers = props();
  render(<WorkspaceHeader {...handlers} />);

  expect(screen.getByRole("heading", { name: current.title })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Back from court record" }));
  expect(handlers.onBack).toHaveBeenCalledOnce();
  await user.click(screen.getByRole("button", { name: "court record actions" }));
  await user.click(screen.getByRole("menuitem", { name: "Duplicate" }));
  expect(handlers.onDuplicate).toHaveBeenCalledOnce();
  await user.click(screen.getByRole("button", { name: "court record actions" }));
  await user.click(screen.getByRole("menuitem", { name: "Delete" }));
  const confirmation = screen.getByRole("alertdialog", { name: "Delete court record?" });
  await user.click(within(confirmation).getByRole("button", { name: "Delete" }));
  expect(handlers.onDelete).toHaveBeenCalledOnce();
});

it("renames inline on Enter or blur and cancels with Escape", async () => {
  const user = userEvent.setup(), handlers = props();
  const { rerender } = render(<WorkspaceHeader {...handlers} />);
  const rename = async (value: string) => {
    await user.click(screen.getByRole("button", { name: "court record actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Rename court record" });
    expect(input).toHaveFocus();
    await user.clear(input); await user.type(input, value);
    return input;
  };

  await user.type(await rename("Renamed record"), "{Enter}");
  expect(handlers.onRename).toHaveBeenLastCalledWith("Renamed record");
  rerender(<WorkspaceHeader {...handlers} current={{ ...current, title: "Renamed record" }} />);
  await rename("Blurred record");
  await user.tab();
  expect(handlers.onRename).toHaveBeenLastCalledWith("Blurred record");
  rerender(<WorkspaceHeader {...handlers} current={{ ...current, title: "Blurred record" }} />);
  await user.type(await rename("Cancelled record"), "{Escape}");
  expect(handlers.onRename).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("heading", { name: "Blurred record" })).toBeVisible();
});
