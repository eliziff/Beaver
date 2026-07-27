import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PillButton } from "./pill-button";

describe("PillButton", () => {
    it("renders its children as a button by default", () => {
        render(<PillButton tone="black">Save</PillButton>);
        expect(
            screen.getByRole("button", { name: "Save" }),
        ).toBeInTheDocument();
    });

    it("defaults to type=button", () => {
        render(<PillButton tone="black">Save</PillButton>);
        expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute(
            "type",
            "button",
        );
    });

    it("applies the tone class", () => {
        render(<PillButton tone="danger">Delete</PillButton>);
        expect(screen.getByRole("button", { name: "Delete" })).toHaveClass(
            "bg-red-600",
        );
    });

    it("applies the normal size class when requested", () => {
        render(
            <PillButton tone="blue" size="normal">
                Continue
            </PillButton>,
        );
        expect(screen.getByRole("button", { name: "Continue" })).toHaveClass(
            "text-sm",
        );
    });

    it("defaults to the sm size class", () => {
        render(<PillButton tone="blue">Next</PillButton>);
        expect(screen.getByRole("button", { name: "Next" })).toHaveClass(
            "text-xs",
        );
    });

    it("fires onClick when activated", async () => {
        const onClick = vi.fn();
        const user = userEvent.setup();
        render(
            <PillButton tone="white" onClick={onClick}>
                Click me
            </PillButton>,
        );

        await user.click(screen.getByRole("button", { name: "Click me" }));

        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("does not fire onClick while disabled", async () => {
        const onClick = vi.fn();
        const user = userEvent.setup();
        render(
            <PillButton tone="black" disabled onClick={onClick}>
                Disabled
            </PillButton>,
        );

        await user.click(screen.getByRole("button", { name: "Disabled" }));

        expect(onClick).not.toHaveBeenCalled();
    });

});
