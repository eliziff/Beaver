import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getMfaAssurance: vi.fn(), listMfaFactors: vi.fn(),
    challengeAndVerifyMfa: vi.fn(), isMfaRequiredError: vi.fn() }));
vi.mock("@/app/lib/api/auth", () => mocks);

import { useMfaAction } from "./useMfaAction";

describe("useMfaAction", () => {
    it("defers sensitive work until verification", async () => {
        mocks.getMfaAssurance.mockResolvedValueOnce({ currentLevel: "aal1", nextLevel: "aal2" })
            .mockResolvedValueOnce({ currentLevel: "aal2", nextLevel: "aal2" });
        mocks.listMfaFactors.mockResolvedValue({ totp: [{ id: "factor-1" }] });
        mocks.challengeAndVerifyMfa.mockResolvedValue(undefined);
        const action = vi.fn().mockResolvedValue(undefined);
        function SensitiveAction() {
            const { runMfa, mfaPopup } = useMfaAction();
            return <><button onClick={() => void runMfa(action, { onError: vi.fn() })}>Run</button>{mfaPopup}</>;
        }
        render(<SensitiveAction />);

        await userEvent.click(screen.getByRole("button", { name: "Run" }));
        expect(action).not.toHaveBeenCalled();
        fireEvent.change(await screen.findByRole("textbox", { name: "Six digit verification code" }),
            { target: { value: "123456" } });
        await userEvent.click(screen.getByRole("button", { name: "Verify", exact: true }));
        expect(mocks.challengeAndVerifyMfa).toHaveBeenCalledWith("factor-1", "123456");
        await waitFor(() => expect(action).toHaveBeenCalledOnce());
    });
});
