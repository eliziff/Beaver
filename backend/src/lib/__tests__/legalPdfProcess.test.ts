import path from "node:path";
import { describe, expect, it } from "vitest";
import { legalPdfPython } from "../legalPdfProcess";

describe("legal PDF Python selection", () => {
  it("honours an explicit interpreter", () => {
    expect(
      legalPdfPython({
        env: { LEGALPDF_PYTHON: "D:\\Python\\python.exe" },
        platform: "win32",
        engineRoot: "C:\\engine",
        exists: () => false,
      }),
    ).toBe("D:\\Python\\python.exe");
  });

  it("prefers the engine virtual environment", () => {
    const root = path.resolve("C:\\engine");
    const expected = path.join(root, ".venv", "Scripts/python.exe");
    expect(
      legalPdfPython({
        env: {},
        platform: "win32",
        engineRoot: root,
        exists: (candidate) => candidate === expected,
      }),
    ).toBe(expected);
  });

  it("falls back to the platform interpreter", () => {
    expect(
      legalPdfPython({
        env: {},
        platform: "linux",
        engineRoot: "/engine",
        exists: () => false,
      }),
    ).toBe("python3");
  });
});
