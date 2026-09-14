import { describe, expect, it } from "vitest";
import { effortLevel } from "./effortMeter";

describe("effortLevel", () => {
    it("spreads a model's own effort list across the six bars", () => {
        const claude = ["low", "medium", "high", "xhigh", "max"];
        expect(claude.map((effort) => effortLevel(effort, claude))).toEqual([1, 2, 4, 5, 6]);
    });

    it("treats off/none/automatic as the empty meter", () => {
        const options = ["off", "low", "medium", "high"];
        expect(effortLevel("off", options)).toBe(0);
        expect(effortLevel("none", options)).toBe(0);
        expect(effortLevel(undefined, options)).toBe(0);
    });

    it("ignores off when spacing the remaining levels", () => {
        const options = ["off", "low", "medium", "high"];
        expect(options.map((effort) => effortLevel(effort, options))).toEqual([0, 1, 4, 6]);
    });

    it("falls back to the middle for unknown or single-option lists", () => {
        expect(effortLevel("mystery", ["low", "high"])).toBe(3);
        expect(effortLevel("high", ["high"])).toBe(3);
    });
});
