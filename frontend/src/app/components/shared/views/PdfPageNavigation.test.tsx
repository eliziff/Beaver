import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { PdfPageNavigation } from "./PdfPageNavigation";

function enter(name: string, value: string) {
    // Each field's name carries its range after the label, as in "PDF page, 1 to 9".
    const input = screen.getByRole("textbox", { name: new RegExp(`^${name}`) });
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: "Enter" });
}

it("navigates physical pages without labels and rejects out-of-range input", () => {
    const navigate = vi.fn();
    render(<PdfPageNavigation page={1} count={8} disabled={false} onNavigate={navigate} />);
    expect(screen.queryByRole("textbox", { name: /^Printed page/ })).toBeNull();
    enter("PDF page", "9");
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeVisible();
    enter("PDF page", "8");
    expect(navigate).toHaveBeenCalledWith(8);
    expect(screen.getByRole("textbox", { name: "PDF page, 1 to 8" })).toHaveValue("");
});

it("disambiguates duplicate labels, supports nonnumeric labels, and synchronizes after scrolling", () => {
    const navigate = vi.fn(), labels = ["iv", "5", null, "5", "A-12"];
    const { rerender } = render(<PdfPageNavigation page={1} count={5} labels={labels} disabled={false} onNavigate={navigate} />);
    enter("Printed page", "5");
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "PDF 4" }));
    expect(navigate).toHaveBeenLastCalledWith(4);
    expect(screen.getByRole("textbox", { name: /^Printed page/ })).toHaveFocus();
    enter("Printed page", "A-12");
    expect(navigate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "PDF 5" }));
    expect(navigate).toHaveBeenLastCalledWith(5);
    rerender(<PdfPageNavigation page={3} count={5} labels={labels} disabled={false} onNavigate={navigate} />);
    expect(screen.getByRole("textbox", { name: /^PDF page/ })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: /^Printed page/ })).toHaveValue("");
    enter("Printed page", "3");
    expect(screen.getByRole("alert")).toBeVisible();
    expect(navigate).toHaveBeenCalledTimes(2);
});

it("confirms a lone known printed match while other pages lack labels", () => {
    const navigate = vi.fn();
    const { rerender } = render(<PdfPageNavigation page={1} count={3} labels={["iv", "2", null]} disabled={false} onNavigate={navigate} />);
    enter("Printed page", "2");
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByText("Other occurrences may be undetected.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "PDF 2" }));
    expect(navigate).toHaveBeenCalledWith(2);
    expect(screen.getByRole("textbox", { name: /^Printed page/ })).toHaveFocus();

    rerender(<PdfPageNavigation page={1} count={3} labels={["iv", "2", "3"]} disabled={false} onNavigate={navigate} />);
    enter("Printed page", "2");
    expect(navigate).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "PDF 2" })).toBeNull();
});

it("clears stale matches on replacement and prevents navigation while unavailable", () => {
    const navigate = vi.fn();
    const { rerender } = render(<PdfPageNavigation page={1} count={2} labels={["5", "5"]} disabled={false} onNavigate={navigate} />);
    enter("Printed page", "5");
    rerender(<PdfPageNavigation page={1} count={2} labels={["i", "ii"]} disabled onNavigate={navigate} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("textbox", { name: /^Printed page/ })).toHaveValue("");
    enter("PDF page", "2");
    expect(navigate).not.toHaveBeenCalled();
});

it("shows each range as a placeholder while empty and clears on Escape", () => {
    render(<PdfPageNavigation page={2} count={957} labels={["i", "ii", "1", "940"]} disabled={false} onNavigate={vi.fn()} />);
    const pdf = screen.getByRole("textbox", { name: "PDF page, 1 to 957" });
    expect(pdf).toHaveValue("");
    expect(pdf).toHaveAttribute("placeholder", "1–957");
    expect(screen.getByRole("textbox", { name: "Printed page, i to 940" })).toHaveAttribute("placeholder", "i–940");
    fireEvent.change(pdf, { target: { value: "12" } });
    fireEvent.keyDown(pdf, { key: "Escape" });
    expect(pdf).toHaveValue("");
});
