import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configuredSpellingDictionaries, runTextOp, type TextOpParams } from "../textOps";

// The default-dictionary contract must not depend on the developer's environment.
beforeEach(() => vi.stubEnv("BEAVER_SPELLING_DICTIONARY", undefined));
afterEach(() => vi.unstubAllEnvs());

describe("text transformations", () => {
  it.each<[string, string, string, TextOpParams, string]>([
    ["uppercase", "Word uppercase", "the Quick fox", {}, "THE QUICK FOX"],
    ["lowercase", "Word lowercase", "The QUICK Fox", {}, "the quick fox"],
    ["toggle_case", "Word toggle case", "The QUICK fox", {}, "tHE quick FOX"],
    ["capitalize_each_word", "Word word case", "the QUICK brown-fox", {}, "The Quick Brown-Fox"],
    ["sentence_case", "sentence starts and pronoun I",
      "THIS IS FIRST. second sentence here? i think i'm sure.\nnew paragraph.", {},
      "This is first. Second sentence here? I think I'm sure.\nNew paragraph."],
    ["title_case", "small words and acronyms", "the sale of the NDA assets and a warranty", {},
      "The Sale of the NDA Assets and a Warranty"],
    ["title_case", "small word at the start", "of counsel", {}, "Of Counsel"],
    ["replace_text", "case-insensitive default", "Purchaser pays. The purchaser signs.",
      { find: "purchaser", replace: "Buyer" }, "Buyer pays. The Buyer signs."],
    ["replace_text", "case-sensitive match", "Purchaser pays. The purchaser signs.",
      { find: "purchaser", replace: "Buyer", match_case: true }, "Purchaser pays. The Buyer signs."],
    ["replace_text", "whole words", "art and artful art",
      { find: "art", replace: "science", whole_word: true }, "science and artful science"],
    ["replace_text", "selected occurrence", "a b a b a", { find: "a", replace: "x", occurrence: 2 }, "a b x b a"],
    ["sentence_spacing", "one space", "It ends here.  Next starts. Then more. Done.",
      { style: "one" }, "It ends here. Next starts. Then more. Done."],
    ["sentence_spacing", "two spaces", "It ends here.  Next starts. Then more. Done.",
      { style: "two" }, "It ends here.  Next starts.  Then more.  Done."],
    ["curl_quotes", "plain prose", 'He said "don\'t stop" and left.', {}, "He said “don’t stop” and left."],
    ["straighten_quotes", "plain prose", "He said “don’t stop” and left.", {}, 'He said "don\'t stop" and left.'],
    ["curl_quotes", "decades and possessives", "the '90s and James' hat", {}, "the ’90s and James’ hat"],
    ["collapse_double_spaces", "leading indentation", "  indented  text  here\nplain  run", {},
      "  indented text here\nplain run"],
    ["normalize_ellipses", "default character", "wait... what", {}, "wait… what"],
    ["normalize_ellipses", "explicit periods", "wait… what", { style: "periods" }, "wait... what"],
    ["normalize_ellipses", "four periods stay unchanged", "wait.... what", {}, "wait.... what"],
    ["nonbreaking_section_refs", "section numbers", "under § 12 and ss. 4 and s. 9", {},
      "under §\u00a012 and ss.\u00a04 and s.\u00a09"],
    ["nonbreaking_section_refs", "unrelated word endings", "the bus. plan", {}, "the bus. plan"],
    ["remove_trailing_whitespace", "paragraph ends", "one  \ntwo\t\nthree", {}, "one\ntwo\nthree"],
  ])("%s: %s", async (op, _name, text, params, expected) => {
    expect(await runTextOp(op, text, params)).toEqual({ text: expected, notes: [] });
  });

  it.each<[string, string, TextOpParams, RegExp]>([
    ["replace_text", "abc", { find: "" }, /non-empty/],
    ["replace_text", "a\nb", { find: "a\nb", replace: "c" }, /span paragraphs/],
    ["replace_text", "a\nb", { find: "a", replace: "x\ny" }, /altered paragraph boundaries/],
    ["erase_everything", "abc", {}, /Unknown text op/],
  ])("rejects %s with %j and %j", async (op, text, params, error) => {
    await expect(runTextOp(op, text, params)).rejects.toThrow(error);
  });
});

describe("ambiguous typography", () => {
  it("leaves citation and initial spacing alone and identifies each skipped site", async () => {
    const result = await runTextOp("sentence_spacing",
      "See Smith v. Jones at para. 12. The court agreed with J. Smith. Art. 5 applies.", { style: "two" });
    expect(result.text).toBe("See Smith v. Jones at para. 12. The court agreed with J. Smith.  Art. 5 applies.");
    expect(result.notes).toEqual([
      { site: expect.stringContaining("Smith v"), reason: expect.stringContaining("abbreviation or citation") },
      { site: expect.stringContaining("para. 12"), reason: expect.stringContaining("abbreviation or citation") },
      { site: expect.stringContaining("with J"), reason: expect.stringContaining("abbreviation or citation") },
    ]);
  });

  it("does not curl measurement marks and identifies the ambiguity", async () => {
    const result = await runTextOp("curl_quotes", 'a 5\'10" frame');
    expect(result.text).toBe('a 5\'10" frame');
    expect(result.notes).not.toHaveLength(0);
    for (const note of result.notes) expect(note).toMatchObject({
      site: expect.stringContaining('5\'10"'), reason: expect.stringContaining("measurement"),
    });
  });

  it("normalizes ascending ranges and reports the descending range it leaves alone", async () => {
    expect(await runTextOp("normalize_dashes", "pages 12-15 - the 2024-01 file -- done")).toEqual({
      text: "pages 12–15—the 2024-01 file—done",
      notes: [{ site: "2024-01", reason: expect.stringContaining("not an ascending range") }],
    });
  });
});

describe("check_spelling", () => {
  it("does not correct flagged words, but offers suggestions and surrounding context", async () => {
    const text = "The parties recieve notice and definately agree.";
    expect(await runTextOp("check_spelling", text)).toEqual({ text, notes: [
      { site: "recieve", reason: "possible misspelling", suggestions: expect.arrayContaining(["receive"]),
        context: expect.stringContaining("recieve notice") },
      { site: "definately", reason: "possible misspelling", suggestions: ["definitely"],
        context: expect.stringContaining("definately agree") },
    ] });
  });

  it.each([
    ["Canadian spelling", "the colour of the defence weighed in its favour before judgement"],
    ["acronyms, digits, quotations and citations",
      'The NDAA applies at para. 12 under s. 4. She wrote "recieve them" verbatim.'],
    ["legal drafting terms",
      "The tortious conduct is justiciable; the indemnitor asserts laches and estoppel arguendo."],
  ])("leaves %s untouched", async (_name, text) => {
    expect(await runTextOp("check_spelling", text)).toEqual({ text, notes: [] });
  });

  it("flags American spellings under the Canadian default without changing them", async () => {
    const text = "the color of the defense weighed in its favor";
    const result = await runTextOp("check_spelling", text);
    expect(result.text).toBe(text);
    expect(result.notes.map(({ site }) => site)).toEqual(["color", "defense", "favor"]);
  });

  it("flags party-name-shaped words without suggesting lookalike names for either one", async () => {
    const text = "Mr. Hansman spoke to Darryn.";
    expect(await runTextOp("check_spelling", text)).toEqual({ text, notes: [
      { site: "Hansman", reason: "possible proper noun — verify manually", context: expect.stringContaining("Hansman") },
      { site: "Darryn", reason: "possible proper noun — verify manually", context: expect.stringContaining("Darryn") },
    ] });
  });
});

it.each([
  [undefined, ["en-ca"]], ["", ["en-ca"]], ["klingon", ["en-ca"]],
  ["en-US", ["en-us"]], ["en-CA,en-US", ["en-ca", "en-us"]], ["en-CA, en-CA", ["en-ca"]],
])("selects spelling dictionaries for %j", (raw, expected) => {
  expect(configuredSpellingDictionaries(raw)).toEqual(expected);
});

it("reads the spelling dictionary override from the environment", () => {
  vi.stubEnv("BEAVER_SPELLING_DICTIONARY", "en-US");
  expect(configuredSpellingDictionaries()).toEqual(["en-us"]);
});
