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
    it("uses one native one-time-code field", () => {
        render(<TestInput />);

        const input = screen.getByRole("textbox", {
            name: "Six digit verification code",
        });
        fireEvent.change(input, { target: { value: "12x34567" } });
        expect(input).toHaveValue("123456");
        expect(input).toHaveAttribute("autocomplete", "one-time-code");
    });
});
