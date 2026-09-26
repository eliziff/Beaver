import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { AccessModal } from "./AccessModal";
const mocks = vi.hoisted(() => ({ access: vi.fn(), grant: vi.fn(), move: vi.fn() }));
vi.mock("@/app/lib/api/organizations", () => ({
  getResourceAccess: mocks.access, grantResourceAccess: mocks.grant, moveResourceToOrganization: mocks.move,
  listOrganizations: async () => ({ organizations: [] }),
}));
vi.mock("../account/useMfaAction", () => ({ useMfaAction: () => ({
  runMfa: async (work: () => Promise<void>, options: { onError(error: unknown): void }) => {
    try { await work(); } catch (error) { options.onError(error); }
  }, mfaPopup: null,
}) }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.access.mockResolvedValue({ role: "owner", org_id: null, grants: [{ email: "reader@example.test", role: "viewer" }] });
  mocks.grant.mockResolvedValue(undefined);
});
it("changes a direct role and refreshes the resource", async () => {
  const refresh = vi.fn();
  render(<AccessModal open onClose={() => undefined} kind="project" resourceId="p" title="Matter" onChange={refresh} />);
  const role = await screen.findByLabelText("Access for reader@example.test");
  fireEvent.change(role, { target: { value: "editor" } });
  await waitFor(() => expect(mocks.grant).toHaveBeenCalledWith("project", "p", "reader@example.test", "editor"));
  expect(refresh).toHaveBeenCalledOnce();
});
it("shows inherited access and opens the parent without offering child grants", async () => {
  mocks.access.mockResolvedValueOnce({ role: "viewer", inherited: { kind: "project", id: "parent" }, grants: [] });
  render(<AccessModal open onClose={() => undefined} kind="review" resourceId="r" title="Review" />);
  fireEvent.click(await screen.findByRole("button", { name: "Manage parent access" }));
  await waitFor(() => expect(mocks.access).toHaveBeenCalledWith("project", "parent"));
});
it("keeps viewer access read-only and exposes load failures", async () => {
  mocks.access.mockResolvedValueOnce({ role: "viewer", grants: [{ email: "reader@example.test", role: "viewer" }] });
  const view = render(<AccessModal open onClose={() => undefined} kind="project" resourceId="p" title="Matter" />);
  await screen.findByText("Your access: viewer");
  expect(screen.queryByRole("button", { name: "Share" })).not.toBeInTheDocument();
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  mocks.access.mockRejectedValue(new Error("Access unavailable"));
  view.rerender(<AccessModal open onClose={() => undefined} kind="project" resourceId="other" title="Other" />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Access unavailable");
});
