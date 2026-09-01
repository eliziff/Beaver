import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HelpPopover } from "./help-popover";

describe("HelpPopover", () => {
    it("opens accessibly and closes on Escape", () => {
        render(<HelpPopover label="Search help">Operators</HelpPopover>);
        const trigger = screen.getByRole("button", { name: "Search help" });
        fireEvent.focus(trigger);
        expect(screen.getByRole("tooltip")).toHaveTextContent("Operators");
        fireEvent.keyDown(trigger, { key: "Escape" });
        expect(screen.queryByRole("tooltip")).toBeNull();
    });
});
