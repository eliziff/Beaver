import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { legalDataHome, mikeLocalDataHome } from "../legalDataPath";

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

  it("keeps Mike application state separate from shared provider data", () => {
    expect(
      legalDataHome({
        platform: "linux",
        home: "/home/test",
        env: { MIKE_LOCAL_DATA_DIR: "/srv/mike-data" },
      }),
    ).toBe(
      path.resolve(
        "/home/test",
        ".local",
        "share",
        "OpenLegalProducts",
        "LegalData",
      ),
    );
  });

  it("defaults Mike Library data to its shared AppData namespace", () => {
    expect(
      mikeLocalDataHome({
        platform: "win32",
        home: "C:\\Users\\Test",
        cwd: "C:\\repo\\backend",
        env: { LOCALAPPDATA: "D:\\Profiles\\Test\\Local" },
      }),
    ).toBe(
      path.resolve(
        "D:\\Profiles\\Test\\Local",
        "OpenLegalProducts",
        "LegalData",
        "apps",
        "mike",
        "library",
      ),
    );
  });

  it("honours the Mike Library override", () => {
    expect(
      mikeLocalDataHome({
        env: {
          MIKE_LOCAL_DATA_DIR: "E:\\MikeLibrary",
          OPEN_LEGAL_DATA_HOME: "D:\\SharedLegalData",
        },
      }),
    ).toBe(path.resolve("E:\\MikeLibrary"));
  });

  it("discovers a legacy Library until the shared Library has an index", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mike-library-path-"));
    const backend = path.join(root, "backend");
    const legacy = path.join(backend, ".mike-local");
    const shared = path.join(root, "shared");
    const current = path.join(shared, "apps", "mike", "library");
    try {
      await mkdir(legacy, { recursive: true });
      await writeFile(path.join(legacy, "library.json"), "{}", "utf8");
      expect(
        mikeLocalDataHome({
          cwd: backend,
          env: { OPEN_LEGAL_DATA_HOME: shared },
        }),
      ).toBe(legacy);

      await mkdir(current, { recursive: true });
      await writeFile(path.join(current, "library.json"), "{}", "utf8");
      expect(
        mikeLocalDataHome({
          cwd: backend,
          env: { OPEN_LEGAL_DATA_HOME: shared },
        }),
      ).toBe(current);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
