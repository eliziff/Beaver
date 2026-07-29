import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    needsMfa: vi.fn(),
    isMfaError: vi.fn(),
}));

vi.mock("@/app/components/popups/MfaVerificationPopup", () => ({
    needsMfaVerification: mocks.needsMfa,
    MfaVerificationPopup: ({
        open,
        onVerified,
    }: {
        open: boolean;
        onVerified: () => void;
    }) => open && <button onClick={onVerified}>Verify</button>,
}));
vi.mock("@/app/lib/beaverApi", () => ({
    isMfaRequiredError: mocks.isMfaError,
}));

import { useMfaAction } from "./useMfaAction";

function Harness({
    action,
    onError,
}: {
    action: () => Promise<void>;
    onError: (error: unknown) => void;
}) {
    const { runMfa, mfaPopup } = useMfaAction();
    return (
        <>
            <button onClick={() => void runMfa(action, { onError })}>
                Run
            </button>
            {mfaPopup}
        </>
    );
}

describe("useMfaAction", () => {
    it("defers sensitive work until verification", async () => {
        mocks.needsMfa
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false);
        const action = vi.fn().mockResolvedValue(undefined);
        render(<Harness action={action} onError={vi.fn()} />);

        await userEvent.click(screen.getByRole("button", { name: "Run" }));
        expect(action).not.toHaveBeenCalled();
        await userEvent.click(screen.getByRole("button", { name: "Verify" }));
        await waitFor(() => expect(action).toHaveBeenCalledOnce());
    });
});
