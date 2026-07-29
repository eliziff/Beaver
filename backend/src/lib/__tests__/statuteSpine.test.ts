import { describe, expect, it } from "vitest";

import { computeStatuteSpine } from "../statuteSpine";

// Fixture shapes mirror the corpus families measured by
// scripts/skeleton-oracle-probe.py / skeleton-oracle-diff.ts (431 texts,
// 24 datasets): federal dotless heads, NT/PE dot-terminated heads, and
// Ontario-drafting paragraph lists nested inside dotless sections.

const line = (label: string, body: string) => `${label} ${body}`;

describe("computeStatuteSpine", () => {
  it("finds the dotless federal spine and pulls dotted descendants in", () => {
    const text = [
      line("1", "This Act may be cited as the Example Act."),
      line("2", "The following definitions apply in this Act."),
      line("3", "This Act is binding on Her Majesty."),
      line("5", "The purpose of this Act is to benefit all persons."),
      line("5.1", "(1) The area of communication referred to in paragraph 5(c)"),
      line("5.2", "Nothing in this Act should be construed as requiring."),
      line("6", "This Act is to be carried out in recognition of principles."),
      line("7", "(1) This Act applies to the following entities:"),
    ].join("\n");
    const spine = computeStatuteSpine(text);
    expect(spine.map((mark) => mark.label)).toEqual([
      "1", "2", "3", "5", "5.1", "5.2", "6", "7",
    ]);
    expect(spine.every((mark) => mark.style !== "dotterm")).toBe(true);
  });

  it("falls back to dot-terminated sections where bare marks do not exist", () => {
    const text = [
      "1. In this Act, “Registrar General” means the registrar.",
      "2. (1) A person who has adopted a child may apply.",
      "3. (1) On receipt of the information provided the court decides.",
      "4. A certificate filed in the Supreme Court is proof.",
    ].join("\n");
    const spine = computeStatuteSpine(text);
    expect(spine.map((mark) => mark.label)).toEqual(["1", "2", "3", "4"]);
    expect(spine.every((mark) => mark.style === "dotterm")).toBe(true);
  });

  it("prefers a bare spine over a longer nested paragraph list", () => {
    // Ontario drafting: "1." paragraphs inside dotless sections. The
    // dotterm chain is longer (5 > 3) but is not the spine.
    const text = [
      line("1", "A person is exempted if the person satisfies the following:"),
      "1. The person is registered with a regulatory authority.",
      "2. A regulatory authority has not refused the person.",
      "3. A finding of misconduct has not been made.",
      "4. The person is not the subject of any proceeding.",
      "5. The person has submitted an application.",
      line("2", "A person who is exempted must notify the College."),
      line("3", "Omitted (provides for coming into force)."),
    ].join("\n");
    const spine = computeStatuteSpine(text);
    expect(spine.map((mark) => mark.label)).toEqual(["1", "2", "3"]);
  });

  it("returns no spine for prose with scattered numbers", () => {
    const text = [
      "This agreement is made as of January 1, 2004 between the parties.",
      "2004 was the year of the closing (as defined below).",
      "The purchase price is 3 million dollars payable at closing.",
    ].join("\n");
    expect(computeStatuteSpine(text)).toEqual([]);
  });

  it("rejects a spine that begins in the final third of the text", () => {
    const filler = "Recitals and schedules occupy this document.\n".repeat(80);
    const tail = [
      line("1", "First provision of the late fragment."),
      line("2", "Second provision of the late fragment."),
      line("3", "Third provision of the late fragment."),
    ].join("\n");
    expect(computeStatuteSpine(filler + tail)).toEqual([]);
  });

  it("keeps monotone discipline: a restarted list opens a new scope", () => {
    const text = [
      line("1", "First provision about definitions."),
      line("2", "Second provision about application."),
      line("3", "Third provision about interpretation."),
      line("4", "Fourth provision about administration."),
      line("1", "A quoted enacted provision restarting numbering."),
      line("2", "Another quoted provision."),
    ].join("\n");
    const spine = computeStatuteSpine(text);
    expect(spine.map((mark) => mark.label)).toEqual(["1", "2", "3", "4"]);
  });
});
