import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { JurisdictionModal, type JurisdictionOption } from "./JurisdictionModal";

const options: JurisdictionOption[] = [
    { value: "bc", label: "British Columbia" },
    { value: "on", label: "Ontario" },
    { value: "ab", label: "Alberta", preferenceKey: "ca-ab" },
    { value: "fed", label: "Federal courts", preferenceKey: "ca-federal" },
    { value: "qc", label: "Quebec" },
    { value: "mb", label: "Manitoba" },
    { value: "nb", label: "New Brunswick" },
    { value: "ns", label: "Nova Scotia" },
    { value: "pe", label: "Prince Edward Island" },
];

it("orders preferred jurisdictions, retains every choice, and selects one", async () => {
    const onChange = vi.fn(), onClose = vi.fn();
    render(<JurisdictionModal open value="ab" options={options}
        preferredKeys={["ca-federal", "ca-ab"]} onChange={onChange} onClose={onClose} />);

    const choices = within(screen.getByRole("group", { name: "Choose jurisdiction" }))
        .getAllByRole("button");
    expect(choices.map(({ textContent }) => textContent)).toEqual([
        "Federal courts", "Alberta", "British Columbia", "Manitoba", "New Brunswick",
        "Nova Scotia", "Ontario", "Prince Edward Island", "Quebec",
    ]);
    expect(choices).toHaveLength(options.length);
    expect(choices[1]).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(choices[6]);
    expect(onChange).toHaveBeenCalledWith("on");
    expect(onClose).toHaveBeenCalledOnce();
});
