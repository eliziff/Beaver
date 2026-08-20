import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  requestTableOfAuthorities,
  shutdownTableOfAuthorities,
} from "./tableOfAuthorities";

let dataHome = "";
const previous = {
  dataHome: process.env.OPEN_LEGAL_DATA_HOME,
  directory: process.env.TOA_MAKER_DIR,
};

beforeAll(async () => {
  dataHome = await mkdtemp(path.join(tmpdir(), "beaver-authorities-test-"));
  process.env.OPEN_LEGAL_DATA_HOME = dataHome;
  process.env.TOA_MAKER_DIR = path.resolve(__dirname, "../../../AuthoritiesHelper");
});

afterAll(async () => {
  shutdownTableOfAuthorities();
  await rm(dataHome, { recursive: true, force: true });
  if (previous.dataHome === undefined) delete process.env.OPEN_LEGAL_DATA_HOME;
  else process.env.OPEN_LEGAL_DATA_HOME = previous.dataHome;
  if (previous.directory === undefined) delete process.env.TOA_MAKER_DIR;
  else process.env.TOA_MAKER_DIR = previous.directory;
});

describe("Authorities plugin", () => {
  it("uses the canonical handlers without a server and isolates user jobs", async () => {
    const created = await requestTableOfAuthorities("user-a", "POST", "/api/jobs");
    expect(created.status).toBe(201);

    const own = await requestTableOfAuthorities("user-a", "GET", "/api/jobs");
    const other = await requestTableOfAuthorities("user-b", "GET", "/api/jobs");
    expect(own.body).toMatchObject({ jobs: [expect.objectContaining(created.body)] });
    expect(other.body).toEqual({ jobs: [] });
  });
});
