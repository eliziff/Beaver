import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireLocalRuntimeLock } from "./localRuntimeLock";

const originalBeaverData = process.env.MIKE_LOCAL_DATA_DIR;
const originalLegalData = process.env.OPEN_LEGAL_DATA_HOME;
const roots: string[] = [];
const releases: Array<() => void> = [];

async function temporaryRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "beaver-runtime-lock-"));
  roots.push(root);
  return root;
}

function acquire(root?: string) {
  const release = acquireLocalRuntimeLock(root);
  releases.push(release);
  return release;
}

afterEach(async () => {
  for (const release of releases.splice(0).reverse()) release();
  for (const root of roots.splice(0).reverse()) {
    await rm(root, { recursive: true, force: true });
  }
  if (originalBeaverData === undefined) delete process.env.MIKE_LOCAL_DATA_DIR;
  else process.env.MIKE_LOCAL_DATA_DIR = originalBeaverData;
  if (originalLegalData === undefined) delete process.env.OPEN_LEGAL_DATA_HOME;
  else process.env.OPEN_LEGAL_DATA_HOME = originalLegalData;
});

describe("local runtime lock", () => {
  it("locks the configured Beaver mutable data root", async () => {
    const mikeRoot = await temporaryRoot();
    const legalRoot = await temporaryRoot();
    process.env.MIKE_LOCAL_DATA_DIR = mikeRoot;
    process.env.OPEN_LEGAL_DATA_HOME = legalRoot;

    acquire();

    expect(existsSync(path.join(mikeRoot, "backend.lock.sqlite"))).toBe(true);
    expect(
      existsSync(path.join(legalRoot, "apps", "mike", "backend.lock.sqlite")),
    ).toBe(false);
    expect(() => acquireLocalRuntimeLock()).toThrow(/already running/u);
  });

  it("reclaims a released lock without a stale-delete race", async () => {
    const root = await temporaryRoot();
    const oldRelease = acquire(root);
    oldRelease();
    const freshRelease = acquire(root);

    oldRelease();
    expect(() => acquireLocalRuntimeLock(root)).toThrow(/already running/u);

    freshRelease();
    acquire(root);
  });
});
