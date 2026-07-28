import { describe, expect, it } from "vitest";
import { cn, sortRows } from "./utils";

describe("cn", () => {
    it("joins truthy class names and drops falsy ones", () => {
        expect(cn("a", false && "b", undefined, "c")).toBe("a c");
    });

    it("merges conflicting tailwind classes, keeping the last", () => {
        expect(cn("px-2", "px-4")).toBe("px-4");
    });
});

it("sorts a copy without changing the input", () => {
    const rows = [{ value: 2 }, { value: 1 }];
    expect(sortRows(rows, (a, b) => a.value - b.value, "asc")).toEqual([
        { value: 1 },
        { value: 2 },
    ]);
    expect(rows).toEqual([{ value: 2 }, { value: 1 }]);
});
