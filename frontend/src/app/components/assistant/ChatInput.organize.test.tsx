import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { ChatInput } from "./ChatInput";

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({ profile: { apiKeys: {} }, loading: false }),
}));
vi.mock("@/app/hooks/useSelectedModel", () => ({
    useSelectedModel: () => ["model", vi.fn()],
    useSelectedReasoningEffort: () => [undefined, vi.fn()],
}));
vi.mock("@/app/lib/modelCatalog", () => ({
    useModelCatalog: () => null,
    preloadModelCatalog: () => Promise.resolve(),
}));

it("keeps Organize visible but disabled until it is wired", () => {
    const renderInput = (onOrganize?: () => void) => <MemoryRouter>
        <ChatInput onSubmit={vi.fn()} onCancel={vi.fn()} isLoading={false} onOrganize={onOrganize} />
    </MemoryRouter>;
    const { rerender } = render(renderInput());
    expect(screen.getByRole("button", { name: "Organize" })).toBeDisabled();

    rerender(renderInput(vi.fn()));
    expect(screen.getByRole("button", { name: "Organize" })).toBeEnabled();
});
