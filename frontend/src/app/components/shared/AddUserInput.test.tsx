import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AddUserInput } from "./AddUserInput";

vi.mock("@/app/lib/beaverApi", () => ({ lookupUserByEmail: vi.fn() }));

describe("AddUserInput", () => {
    it("associates and announces an invalid email", () => {
        render(<AddUserInput onAdd={vi.fn()} placeholder="Colleague email" />);
        const input = screen.getByRole("textbox", { name: "Colleague email" });

        fireEvent.change(input, { target: { value: "invalid" } });
        fireEvent.keyDown(input, { key: "Enter" });

        const error = screen.getByRole("alert");
        expect(input).toHaveAttribute("aria-invalid", "true");
        expect(input).toHaveAttribute("aria-describedby", error.id);
        expect(error).toHaveTextContent("Enter a valid email.");
    });
});
