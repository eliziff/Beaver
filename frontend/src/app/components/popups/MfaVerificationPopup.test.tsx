import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { VerificationCodeInput } from "./MfaVerificationPopup";

function TestInput() {
    const [value, setValue] = useState("");
    return (
        <VerificationCodeInput value={value} onChange={setValue} />
    );
}

describe("VerificationCodeInput", () => {
    it("keeps its accessible digit controls", () => {
        render(<TestInput />);

        const inputs = screen.getAllByRole("textbox");
        expect(
            screen.getByRole("group", {
                name: "Six digit verification code",
            }),
        ).toBeInTheDocument();
        expect(inputs).toHaveLength(6);
        fireEvent.change(inputs[0], { target: { value: "7" } });
        expect(inputs[0]).toHaveValue("7");
        expect(inputs[1]).toHaveFocus();
    });
});
