import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { crossReferenceGraphFromSkeleton } from "../legalCrossReference";
import {
  bakeStructure,
  bakedCrossReferenceGraph,
  bakedSkeleton,
} from "../legalStructureSidecar";
import {
  clearSkeletonCache,
  compileAgreementSkeleton,
  readSection,
  type TableCellSpan,
} from "../legalTextSkeleton";

const AGREEMENT = [
  "Section 1.01 Definitions.",
  '"Borrower" means Acme Corp.',
  "Section 1.02 Notices.",
  "Notices under Section 1.01 must be written.",
  "Section 1.03 Remedies.",
  "The Agent may enforce Section 1.02.",
].join("\n");

const COLLAPSED =
  "MERGER AGREEMENT   ARTICLE I DEFINITIONS   " +
  "1.01 Defined Terms.  Capitalized terms have the meanings given.   " +
  "1.02 Interpretation.  References to Articles are to this Agreement.   " +
  "ARTICLE II THE MERGER   " +
  "2.01 The Merger.  Merger Sub shall merge into the Company as set forth in Section 1.01.   " +
  "2.02 Closing.  The Closing shall occur as provided in Section 2.01 and Section 1.02.   " +
  "2.03 Effective Time.  Subject to Section 2.02, the Effective Time occurs at filing.";

const TABLE_TEXT = [
  "Section 4.1 Signing authority.",
  "Officer",
  "Secretary",
  "Section 4.2 Reports.",
].join("\n");

const cell = (value: string): TableCellSpan => ({
  table: 1,
  row: 1,
  column: 1,
  start: TABLE_TEXT.indexOf(value),
  end: TABLE_TEXT.indexOf(value) + value.length,
});

let temporaryDirectory = "";
let previousDataDirectory: string | undefined;

beforeEach(async () => {
  previousDataDirectory = process.env.MIKE_LOCAL_DATA_DIR;
  temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "beaver-structure-sidecar-"),
  );
  process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
  clearSkeletonCache();
});

afterEach(async () => {
  clearSkeletonCache();
  if (previousDataDirectory === undefined) {
    delete process.env.MIKE_LOCAL_DATA_DIR;
  } else {
    process.env.MIKE_LOCAL_DATA_DIR = previousDataDirectory;
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("legal structure sidecars", () => {
  it("rehydrates the requested document id without changing structure", async () => {
    const cold = await compileAgreementSkeleton(AGREEMENT, "baker-id");
    await bakeStructure(AGREEMENT, "baker-id");
    clearSkeletonCache();

    const hit = await bakedSkeleton(AGREEMENT, "library-id");

    expect(hit.doc.id).toBe("library-id");
    expect(hit.nodes).toEqual(cold.nodes);
    expect(hit.doc.blocks).toEqual(cold.doc.blocks);
  });

  it("keeps recovery and no-recovery artifacts separate", async () => {
    await bakeStructure(COLLAPSED, "recovered");
    await bakeStructure(COLLAPSED, "authoritative", {
      recoverExtraction: false,
    });
    clearSkeletonCache();

    const recovered = await bakedSkeleton(COLLAPSED, "requested-recovered");
    const authoritative = await bakedSkeleton(COLLAPSED, "requested-source", {
      recoverExtraction: false,
    });
    const files = await readdir(path.join(temporaryDirectory, "structure-cache"));

    expect(recovered.nodes.map((node) => node.label)).toContain("sec2.03");
    expect(authoritative.nodes.map((node) => node.label)).not.toContain("sec2.03");
    expect(files.filter((name) => name.includes(".skeleton."))).toHaveLength(2);
    expect(files.some((name) => name.includes(".recover.skeleton."))).toBe(true);
    expect(files.some((name) => name.includes(".norecover.skeleton."))).toBe(true);
  });

  it("keys native cell maps separately and reproduces the cold structure", async () => {
    const officerCells = [cell("Officer")];
    const secretaryCells = [cell("Secretary")];
    const cold = await compileAgreementSkeleton(TABLE_TEXT, "cold", {
      tableCells: officerCells,
    });

    await bakeStructure(TABLE_TEXT, "officer", { tableCells: officerCells });
    await bakeStructure(TABLE_TEXT, "secretary", { tableCells: secretaryCells });
    clearSkeletonCache();

    const officer = await bakedSkeleton(TABLE_TEXT, "requested-officer", {
      tableCells: officerCells,
    });
    const secretary = await bakedSkeleton(TABLE_TEXT, "requested-secretary", {
      tableCells: secretaryCells,
    });
    const files = await readdir(path.join(temporaryDirectory, "structure-cache"));

    expect(officer.nodes).toEqual(cold.nodes);
    expect(readSection(officer, "table:1/row:1/col:1").block?.text).toBe(
      "Officer",
    );
    expect(readSection(secretary, "table:1/row:1/col:1").block?.text).toBe(
      "Secretary",
    );
    expect(files.filter((name) => name.includes(".skeleton."))).toHaveLength(2);
  });

  it("compiles safely when sidecars are missing", async () => {
    const expectedSkeleton = await compileAgreementSkeleton(AGREEMENT, "missing");
    const expectedGraph = crossReferenceGraphFromSkeleton(AGREEMENT, expectedSkeleton);
    clearSkeletonCache();

    const skeleton = await bakedSkeleton(AGREEMENT, "missing");
    const graph = await bakedCrossReferenceGraph(AGREEMENT, "missing");
    const files = await readdir(path.join(temporaryDirectory, "structure-cache"));

    expect(skeleton.nodes).toEqual(expectedSkeleton.nodes);
    expect(graph).toEqual(expectedGraph);
    expect(files.some((name) => name.includes(".skeleton."))).toBe(true);
    expect(files.some((name) => name.includes(".graph."))).toBe(true);
  });

  it("recompiles safely when sidecars are corrupt", async () => {
    await bakeStructure(AGREEMENT, "corrupt");
    const expectedSkeleton = await compileAgreementSkeleton(AGREEMENT, "corrupt");
    const expectedGraph = crossReferenceGraphFromSkeleton(AGREEMENT, expectedSkeleton);
    const cacheDirectory = path.join(temporaryDirectory, "structure-cache");
    for (const name of await readdir(cacheDirectory)) {
      await writeFile(path.join(cacheDirectory, name), "{not-json", "utf8");
    }
    clearSkeletonCache();

    const skeleton = await bakedSkeleton(AGREEMENT, "corrupt");
    const graph = await bakedCrossReferenceGraph(AGREEMENT, "corrupt");

    expect(skeleton.nodes).toEqual(expectedSkeleton.nodes);
    expect(graph).toEqual(expectedGraph);
  });
});
