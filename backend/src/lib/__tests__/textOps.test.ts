import { describe, expect, it } from "vitest";
import {
  configuredSpellingDictionaries,
  runTextOp,
} from "../textOps";

const apply = async (
  op: string,
  text: string,
  params: Record<string, unknown> = {},
) => runTextOp(op, text, params);

describe("case ops", () => {
  it("mirror Word's Change Case menu", async () => {
    expect((await apply("uppercase", "the Quick fox")).text).toBe(
      "THE QUICK FOX",
    );
    expect((await apply("lowercase", "The QUICK Fox")).text).toBe(
      "the quick fox",
    );
    expect((await apply("toggle_case", "The QUICK fox")).text).toBe(
      "tHE quick FOX",
    );
    expect((await apply("capitalize_each_word", "the QUICK brown-fox")).text).toBe(
      "The Quick Brown-Fox",
    );
  });

  it("sentence_case capitalizes sentence starts and keeps the pronoun I", async () => {
    expect(
      (
        await apply(
          "sentence_case",
          "THIS IS FIRST. second sentence here? i think i'm sure.\nnew paragraph.",
        )
      ).text,
    ).toBe(
      "This is first. Second sentence here? I think I'm sure.\nNew paragraph.",
    );
  });

  it("title_case lowercases small words but keeps edges and acronyms", async () => {
    expect(
      (await apply("title_case", "the sale of the NDA assets and a warranty")).text,
    ).toBe("The Sale of the NDA Assets and a Warranty");
    expect((await apply("title_case", "of counsel")).text).toBe("Of Counsel");
  });
});

describe("replace_text", () => {
  it("replaces every occurrence case-insensitively by default", async () => {
    const result = await apply("replace_text", "Purchaser pays. The purchaser signs.", {
      find: "purchaser",
      replace: "Buyer",
    });
    expect(result.text).toBe("Buyer pays. The Buyer signs.");
  });

  it("honors match_case, whole_word, and occurrence", async () => {
    expect(
      (
        await apply("replace_text", "Purchaser pays. The purchaser signs.", {
          find: "purchaser",
          replace: "Buyer",
          match_case: true,
        })
      ).text,
    ).toBe("Purchaser pays. The Buyer signs.");
    expect(
      (
        await apply("replace_text", "art and artful art", {
          find: "art",
          replace: "science",
          whole_word: true,
        })
      ).text,
    ).toBe("science and artful science");
    expect(
      (
        await apply("replace_text", "a b a b a", {
          find: "a",
          replace: "x",
          occurrence: 2,
        })
      ).text,
    ).toBe("a b x b a");
  });

  it("rejects empty and multi-paragraph needles", async () => {
    await expect(apply("replace_text", "abc", { find: "" })).rejects.toThrow(
      /non-empty/,
    );
    await expect(
      apply("replace_text", "a\nb", { find: "a\nb", replace: "c" }),
    ).rejects.toThrow(/span paragraphs/);
  });
});

describe("sentence_spacing", () => {
  it("normalizes to one or two spaces at real sentence ends only", async () => {
    const text = "It ends here.  Next starts. Then more. Done.";
    const one = await apply("sentence_spacing", text, { style: "one" });
    expect(one.text).toBe("It ends here. Next starts. Then more. Done.");
    const two = await apply("sentence_spacing", text, { style: "two" });
    expect(two.text).toBe("It ends here.  Next starts.  Then more.  Done.");
  });

  it("skips abbreviations, initials, and numbered citations and reports them", async () => {
    const result = await apply(
      "sentence_spacing",
      "See Smith v. Jones at para. 12. The court agreed with J. Smith. Art. 5 applies.",
      { style: "two" },
    );
    // "12. The" (digit before the period) and "J. Smith" (initial) are
    // conservative skips; "Smith. Art" is a real sentence end.
    expect(result.text).toBe(
      "See Smith v. Jones at para. 12. The court agreed with J. Smith.  Art. 5 applies.",
    );
    expect(
      result.notes.some((n) => n.reason.includes("abbreviation or citation")),
    ).toBe(true);
  });
});

describe("typographic ops", () => {
  it("straighten_quotes and curl_quotes are inverse on plain prose", async () => {
    const straight = 'He said "don\'t stop" and left.';
    const curled = (await apply("curl_quotes", straight)).text;
    expect(curled).toBe("He said “don’t stop” and left.");
    expect((await apply("straighten_quotes", curled)).text).toBe(straight);
  });

  it("curl_quotes is apostrophe-aware and skips measurements", async () => {
    expect((await apply("curl_quotes", "the '90s and James' hat")).text).toBe(
      "the ’90s and James’ hat",
    );
    const measurement = await apply("curl_quotes", 'a 5\'10" frame');
    expect(measurement.text).toBe('a 5\'10" frame');
    expect(measurement.notes.length).toBeGreaterThan(0);
    expect(measurement.notes[0].reason).toContain("measurement");
  });

  it("collapse_double_spaces keeps leading indentation", async () => {
    expect(
      (await apply("collapse_double_spaces", "  indented  text  here\nplain  run")).text,
    ).toBe("  indented text here\nplain run");
  });

  it("normalize_dashes converts spaced hyphens and ascending ranges only", async () => {
    const result = await apply(
      "normalize_dashes",
      "pages 12-15 - the 2024-01 file -- done",
    );
    expect(result.text).toBe("pages 12–15—the 2024-01 file—done");
    expect(result.notes[0].reason).toContain("not an ascending range");
  });

  it("normalize_ellipses supports both directions", async () => {
    expect((await apply("normalize_ellipses", "wait... what")).text).toBe(
      "wait… what",
    );
    expect(
      (await apply("normalize_ellipses", "wait… what", { style: "periods" })).text,
    ).toBe("wait... what");
    expect((await apply("normalize_ellipses", "wait.... what")).text).toBe(
      "wait.... what",
    );
  });

  it("nonbreaking_section_refs binds section symbols to their numbers", async () => {
    expect(
      (await apply("nonbreaking_section_refs", "under § 12 and ss. 4 and s. 9")).text,
    ).toBe("under § 12 and ss. 4 and s. 9");
    expect((await apply("nonbreaking_section_refs", "the bus. plan")).text).toBe(
      "the bus. plan",
    );
  });

  it("remove_trailing_whitespace trims paragraph ends", async () => {
    expect(
      (await apply("remove_trailing_whitespace", "one  \ntwo\t\nthree")).text,
    ).toBe("one\ntwo\nthree");
  });
});

describe("check_spelling", () => {
  it("never mutates: it flags possible misspellings with suggestions", async () => {
    const text = "The parties recieve notice and definately agree.";
    const result = await apply("check_spelling", text);
    expect(result.text).toBe(text);
    expect(result.notes).toMatchObject([
      { site: "recieve", reason: "possible misspelling" },
      {
        site: "definately",
        reason: "possible misspelling",
        suggestions: ["definitely"],
      },
    ]);
    expect(result.notes[0].suggestions).toContain("receive");
    expect(result.notes[0].context).toContain("recieve notice");
  });

  it("uses Canadian English by default: favour/defence pass, favor/defense flag", async () => {
    const canadian =
      "the colour of the defence weighed in its favour before judgement";
    expect((await apply("check_spelling", canadian)).notes).toEqual([]);
    const american = "the color of the defense weighed in its favor";
    const flagged = (await apply("check_spelling", american)).notes;
    expect(flagged.map((note) => note.site)).toEqual([
      "color",
      "defense",
      "favor",
    ]);
  });

  it("leaves acronyms, digits, quotes, and citations out of scope", async () => {
    const text =
      'The NDAA applies at para. 12 under s. 4. She wrote "recieve them" verbatim.';
    const result = await apply("check_spelling", text);
    expect(result.text).toBe(text);
    expect(result.notes).toEqual([]);
  });

  it("knows common legal drafting terms", async () => {
    const text =
      "The tortious conduct is justiciable; the indemnitor asserts laches and estoppel arguendo.";
    const result = await apply("check_spelling", text);
    expect(result.text).toBe(text);
    expect(result.notes).toEqual([]);
  });

  it("flags proper-noun-shaped words without offering lookalike suggestions", async () => {
    // "Hansman" is one edit from "Hangman"; a party name gets no suggestions.
    const result = await apply("check_spelling", "Mr. Hansman spoke to Darryn.");
    expect(result.text).toBe("Mr. Hansman spoke to Darryn.");
    expect(result.notes).toMatchObject([
      { site: "Hansman", reason: "possible proper noun — verify manually" },
      { site: "Darryn", reason: "possible proper noun — verify manually" },
    ]);
    expect(result.notes[0].suggestions).toBeUndefined();
  });
});

describe("spelling dictionary configuration", () => {
  it("defaults to Canadian English only", () => {
    expect(configuredSpellingDictionaries(undefined)).toEqual(["en-ca"]);
    expect(configuredSpellingDictionaries("")).toEqual(["en-ca"]);
    expect(configuredSpellingDictionaries("klingon")).toEqual(["en-ca"]);
  });

  it("supports the single env override to switch or add en-US", () => {
    expect(configuredSpellingDictionaries("en-US")).toEqual(["en-us"]);
    expect(configuredSpellingDictionaries("en-CA,en-US")).toEqual([
      "en-ca",
      "en-us",
    ]);
    expect(configuredSpellingDictionaries("en-CA, en-CA")).toEqual(["en-ca"]);
  });
});

it("rejects unknown text operations", async () => {
  await expect(runTextOp("erase_everything", "abc")).rejects.toThrow(
    /Unknown text op/,
  );
});
