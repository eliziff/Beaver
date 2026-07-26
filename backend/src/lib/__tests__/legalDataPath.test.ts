import path from "node:path";
import { describe, expect, it } from "vitest";
import { legalDataHome } from "../legalDataPath";

describe("shared legal data path", () => {
  it("uses the common Windows AppData directory", () => {
    expect(
      legalDataHome({
        platform: "win32",
        home: "C:\\Users\\Test",
        env: { LOCALAPPDATA: "D:\\Profiles\\Test\\Local" },
      }),
    ).toBe(
      path.resolve(
        "D:\\Profiles\\Test\\Local",
        "OpenLegalProducts",
        "LegalData",
      ),
    );
  });

  it("honours the cross-application override", () => {
    expect(
      legalDataHome({
        platform: "win32",
        home: "C:\\Users\\Test",
        env: {
          LOCALAPPDATA: "D:\\Profiles\\Test\\Local",
          OPEN_LEGAL_DATA_HOME: "E:\\SharedLegalData",
        },
      }),
    ).toBe(path.resolve("E:\\SharedLegalData"));
  });

  it("keeps the legacy Mike override as a compatibility fallback", () => {
    expect(
      legalDataHome({
        platform: "linux",
        home: "/home/test",
        env: { MIKE_LOCAL_DATA_DIR: "/srv/mike-data" },
      }),
    ).toBe(path.resolve("/srv/mike-data"));
  });
});
