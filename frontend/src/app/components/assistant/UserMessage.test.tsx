import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { UserMessage } from "./UserMessage";

describe("UserMessage", () => {
    it("renders user markdown inside the same bubble", () => {
        const { container } = render(
            <UserMessage content={"Please review **section 7**:\n\n- Notice\n- Renewal"} />,
        );

        expect(screen.getByText("section 7").tagName).toBe("STRONG");
        expect(container.querySelectorAll("ul li")).toHaveLength(2);
        expect(container.textContent).not.toContain("**");
        expect(screen.getAllByTestId("user-message-bubble")).toHaveLength(1);
    });

    it("copies the original message and normalizes manual selection spacing", async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: { writeText },
        });
        const selection = vi.spyOn(window, "getSelection").mockReturnValue({
            toString: () => "First\n\n\nSecond\n\n",
        } as Selection);
        const setData = vi.fn();
        render(<UserMessage content={"First\n\nSecond"} />);

        await userEvent.click(
            screen.getByRole("button", { name: "Copy message" }),
        );
        fireEvent.copy(screen.getByTestId("user-message-bubble"), {
            clipboardData: { setData },
        });

        expect(writeText).toHaveBeenCalledWith("First\n\nSecond");
        expect(setData).toHaveBeenCalledWith("text/plain", "First\n\nSecond");
        selection.mockRestore();
    });
});
