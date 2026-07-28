import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyProposedUpdates,
  createMatterStateLog,
  projectMatterState,
  type MatterStateLog,
} from "../chat/matterState";

let dataHome: string;

async function loadStore() {
  vi.resetModules();
  return import("../matterStateStore");
}

function stateDirectory() {
  return path.join(dataHome, "apps", "mike", "matter-state");
}

beforeEach(async () => {
  dataHome = await mkdtemp(path.join(os.tmpdir(), "beaver-matter-state-"));
  process.env.OPEN_LEGAL_DATA_HOME = dataHome;
});

afterEach(async () => {
  delete process.env.OPEN_LEGAL_DATA_HOME;
  vi.restoreAllMocks();
  vi.resetModules();
  await rm(dataHome, { recursive: true, force: true });
});

function buildLog(chatId: string): MatterStateLog {
  const first = applyProposedUpdates(createMatterStateLog(chatId), "TURN-1", [
    { op: "add", item: { kind: "fact", text: "Signed 2024-03-01." } },
  ]);
  const factId =
    first.accepted[0].op === "add" ? first.accepted[0].item.id : "";
  const second = applyProposedUpdates(first.log, "TURN-2", [
    {
      op: "supersede",
      target_id: factId,
      replacement: { kind: "fact", text: "Signed 2024-03-05." },
    },
  ]);
  return second.log;
}

describe("matter state store", () => {
  it("round-trips active AND superseded state across a module reload", async () => {
    const chatId = randomUUID();
    const log = buildLog(chatId);
    const store = await loadStore();
    store.saveMatterState(log);

    const reloaded = await loadStore();
    const loaded = reloaded.loadMatterState(chatId);
    expect(loaded).toEqual(log);
    const projection = projectMatterState(loaded!);
    expect(projection.active).toHaveLength(1);
    expect(projection.active[0].text).toBe("Signed 2024-03-05.");
    expect(projection.superseded).toHaveLength(1);
    expect(projection.superseded[0]).toMatchObject({
      status: "superseded",
      text: "Signed 2024-03-01.",
      superseded_by: projection.active[0].id,
    });
  });

  it("returns null for missing state without warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = await loadStore();
    expect(store.loadMatterState(randomUUID())).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns null with a warning for corrupt or invalid files", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await mkdir(stateDirectory(), { recursive: true });
    const corruptId = randomUUID();
    const invalidId = randomUUID();
    const mismatchedId = randomUUID();
    await writeFile(path.join(stateDirectory(), `${corruptId}.json`), "{");
    await writeFile(
      path.join(stateDirectory(), `${invalidId}.json`),
      JSON.stringify({ version: 1, log: { chat_id: invalidId } }),
    );
    await writeFile(
      path.join(stateDirectory(), `${mismatchedId}.json`),
      JSON.stringify({ version: 1, log: buildLog(randomUUID()) }),
    );

    const store = await loadStore();
    expect(store.loadMatterState(corruptId)).toBeNull();
    expect(store.loadMatterState(invalidId)).toBeNull();
    expect(store.loadMatterState(mismatchedId)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("refuses to persist an invalid log and leaves no file behind", async () => {
    const store = await loadStore();
    const log = buildLog(randomUUID());
    const invalid = {
      ...log,
      events: [...log.events, { op: "explode" }],
    } as unknown as MatterStateLog;

    expect(() => store.saveMatterState(invalid)).toThrow(
      "Invalid matter-state log",
    );
    await expect(readdir(stateDirectory())).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects non-uuid chat ids without touching the filesystem", async () => {
    const store = await loadStore();
    expect(store.loadMatterState("../escape")).toBeNull();
  });
});
