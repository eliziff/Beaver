import { beforeAll, describe, expect, it } from "vitest";

import { buildPathologyFixtures } from "../../src/lib/__tests__/fixtures/docx-pathologies/generate";
import { extractDocxBodyText } from "../../src/lib/docxTrackedChanges";
import {
  applyNumberingToText,
  resolveDocxNumbering,
} from "./numbering";
import { extractDocxStories } from "./stories";

const packages = new Map<string, Buffer>();

beforeAll(async () => {
  for (const [name, bytes] of await buildPathologyFixtures()) {
    packages.set(name, bytes);
  }
});

function fixture(name: string): Buffer {
  const bytes = packages.get(name);
  if (!bytes) throw new Error(`missing fixture ${name}`);
  return bytes;
}

describe("specialist DOCX analysis conformance", () => {
  it("reconstructs auto-numbering on the accepted body plane", async () => {
    const bytes = fixture("auto-numbered");
    const body = await extractDocxBodyText(bytes);
    const { labels, notes } = await resolveDocxNumbering(bytes);

    expect([...labels.entries()]).toEqual([
      [0, "1."],
      [1, "(a)"],
      [2, "2."],
    ]);
    expect(applyNumberingToText(body, labels)).toBe(
      "1. Definitions.\n(a) Affiliate has the meaning given.\n2. Governing law.",
    );
    expect(notes).toEqual([]);
  });

  it("keeps revision, header/footer, note, and text-box stories visible", async () => {
    const revisions = await extractDocxStories(fixture("tracked-changes"));
    expect(revisions.body[0].text).toBe("The seat of arbitration is Toronto.");
    expect(revisions.body[0].runs.find((run) => run.text === "Zurich")?.del).toBe(true);
    expect(revisions.body[0].runs.find((run) => run.text === "Toronto")?.ins).toBe(true);

    const running = await extractDocxStories(fixture("header-footer-text"));
    expect(running.headers.map((part) => part.map((p) => p.text).join(" "))).toEqual([
      "PRIVILEGED AND CONFIDENTIAL",
    ]);
    expect(running.footers.map((part) => part.map((p) => p.text).join(" "))).toEqual([
      "Execution version",
    ]);

    const notes = await extractDocxStories(fixture("footnotes"));
    expect([...notes.footnotes.keys()]).toEqual(["1", "2"]);
    expect([...notes.endnotes.keys()]).toEqual(["1"]);

    const textBoxes = await extractDocxStories(fixture("text-box"));
    expect(textBoxes.textBoxes.map((part) => part.map((p) => p.text).join(" "))).toEqual([
      "Draft only - not for execution.",
    ]);
  });
});
