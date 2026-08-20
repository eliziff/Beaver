import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  legalDataHome,
  mikeLocalDataHome,
  withSearchReadonlySqlite,
} from "../legalDataPath";

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

  it("keeps Beaver application state separate from shared provider data", () => {
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

  it("defaults Beaver Library data to its shared AppData namespace", () => {
    expect(
      mikeLocalDataHome({
        platform: "win32",
        home: "C:\\Users\\Test",
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

  it("honours the Beaver Library override", () => {
    expect(
      mikeLocalDataHome({
        env: {
          MIKE_LOCAL_DATA_DIR: "E:\\BeaverLibrary",
          OPEN_LEGAL_DATA_HOME: "D:\\SharedLegalData",
        },
      }),
    ).toBe(path.resolve("E:\\BeaverLibrary"));
  });

  it("reopens configured search databases so updates are visible", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "beaver-search-db-"));
    const filename = path.join(directory, "search.sqlite");
    try {
      const write = new DatabaseSync(filename);
      write.exec("CREATE TABLE state (value INTEGER); INSERT INTO state VALUES (1)");
      write.close();
      const read = () => withSearchReadonlySqlite(filename, false, (database) =>
        (database.prepare("SELECT value FROM state").get() as { value: number }).value);
      expect(read()).toBe(1);

      const update = new DatabaseSync(filename);
      update.exec("UPDATE state SET value = 2");
      update.close();
      expect(read()).toBe(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
