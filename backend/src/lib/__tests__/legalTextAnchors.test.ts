import { describe, expect, it } from "vitest";

import {
  anchorCoverage,
  bilingualConcordance,
  extractAnchors,
  numeralWordPairs,
  wordPhraseToNumber,
} from "../legalTextAnchors";

const norms = (text: string, cls?: string) =>
  extractAnchors(text)
    .filter((hit) => !cls || hit.cls === cls)
    .map((hit) => hit.norm);

describe("extractAnchors: money", () => {
  it("canonicalizes written-out and numeral forms to the same key", () => {
    expect(norms("a fee of $2.25 million")).toEqual(["money:dlr:2250000"]);
    expect(norms("a fee of $2,250,000")).toEqual(["money:dlr:2250000"]);
    expect(norms("2,250,000 dollars")).toEqual(["money:dlr:2250000"]);
    expect(norms("40 million dollars")).toEqual(["money:dlr:40000000"]);
  });

  it("inherits the multiplier across a range", () => {
    expect(norms("$40–$50 million of pricing opportunity")).toEqual([
      "money:dlr:40000000",
      "money:dlr:50000000",
    ]);
    expect(norms("$40 to $50 million")).toEqual([
      "money:dlr:40000000",
      "money:dlr:50000000",
    ]);
  });

  it("does not inherit across ordinary prose", () => {
    expect(norms("$40 fee and later $50 million")).toEqual([
      "money:dlr:40",
      "money:dlr:50000000",
    ]);
  });

  it("does not let a fully written amount borrow a range multiplier", () => {
    expect(norms("costs of $500,000–$2 million per platform")).toEqual([
      "money:dlr:500000",
      "money:dlr:2000000",
    ]);
  });

  it("reads attached finance suffixes", () => {
    expect(norms("liquidity of $20.0M")).toEqual(["money:dlr:20000000"]);
    expect(norms("the $2.25M filing fee")).toEqual(["money:dlr:2250000"]);
    expect(norms("$50MM revolver and $3B notes and $500K deposit")).toEqual([
      "money:dlr:50000000",
      "money:dlr:3000000000",
      "money:dlr:500000",
    ]);
  });
});

describe("extractAnchors: percent and ratio", () => {
  it("extracts percentages", () => {
    expect(norms("approximately 81% of the market")).toEqual(["pct:81"]);
    expect(norms("a margin of 0.50%")).toEqual(["pct:0.5"]);
  });

  it("unifies x-multiples and to-1.00 ratio forms", () => {
    expect(norms("not to exceed 4.50x", "ratio")).toEqual(["ratio:4.5"]);
    expect(norms("not to exceed 4.50 to 1.00", "ratio")).toEqual(["ratio:4.5"]);
    expect(norms("of 1.15:1.00 as of", "ratio")).toEqual(["ratio:1.15"]);
  });

  it("does not read an increase 'to 1.5' as a ratio", () => {
    expect(norms("steps up to 1.5 next year", "ratio")).toEqual([]);
  });
});

describe("extractAnchors: dates", () => {
  it("canonicalizes all full-date forms to one key", () => {
    expect(norms("matures on March 15, 2027")).toEqual(["date:2027-03-15"]);
    expect(norms("matures on 3/15/2027")).toEqual(["date:2027-03-15"]);
    expect(norms("matures on 15 March 2027")).toEqual(["date:2027-03-15"]);
  });

  it("reads recital-style ordinal dates (CUAD-measured gap)", () => {
    expect(norms("executed on the 15th day of March, 2027")).toEqual([
      "date:2027-03-15",
    ]);
    expect(norms("dated March 15th, 2027")).toEqual(["date:2027-03-15"]);
    expect(norms("on the 1st of June, 2020")).toEqual(["date:2020-06-01"]);
  });

  it("reads worded percentages", () => {
    expect([...new Set(norms("fifty percent (50%) of Net Revenue"))]).toEqual([
      "pct:50",
    ]);
    expect(norms("twenty-five percent of the fees")).toEqual(["pct:25"]);
    expect(norms("a large percent of users")).toEqual([]);
  });

  it("deliberately ignores month-year mentions", () => {
    expect(norms("the March 2027 maturity")).toEqual([]);
  });

  it("swaps obviously day-first numeric dates", () => {
    expect(norms("dated 15/3/2027")).toEqual(["date:2027-03-15"]);
  });
});

describe("extractAnchors: durations and statutes", () => {
  it("normalizes duration units and plurality", () => {
    expect(norms("within 5 Business Days")).toEqual(["dur:5:business_day"]);
    expect(norms("within 1 business day")).toEqual(["dur:1:business_day"]);
    expect(norms("a period of 30 days")).toEqual(["dur:30:day"]);
  });

  it("reads the numeral of a words-and-numerals pair", () => {
    expect(norms("thirty (30) days", "duration")).toEqual(["dur:30:day"]);
  });

  it("extracts reporter-style and named-act citations", () => {
    expect(norms("under 6 Del. C. § 8106", "statute")).toEqual([
      "stat:6delc:8106",
    ]);
    expect(norms("15 U.S.C. § 18 applies", "statute")).toEqual([
      "stat:15usc:18",
    ]);
    expect(norms("Section 7 of the Clayton Act prohibits", "statute")).toEqual([
      "stat:claytonact:s7",
    ]);
  });
});

describe("extractAnchors: currencies and Canadian forms", () => {
  it("tags currencies distinctly", () => {
    expect(norms("EU turnover of €870 million")).toEqual([
      "money:eur:870000000",
    ]);
    expect(norms("a £5,000 deposit")).toEqual(["money:gbp:5000"]);
  });

  it("extracts Canadian statute citations", () => {
    expect(norms("R.S.C. 1985, c. C-46, s. 231", "statute")).toEqual([
      "stat:rsc1985:cc-46:s231",
    ]);
    expect(norms("S.O. 2002, c. 24, Sched. B", "statute")).toEqual([
      "stat:so2002:c24:schedb",
    ]);
    expect(norms("C.C.S.M. c. F158", "statute")).toEqual(["stat:ccsm:cf158"]);
  });

  it("extracts Canadian federal instrument citations across year widths", () => {
    expect(norms("under SOR/2005-407 and SI/2004-121", "statute")).toEqual([
      "stat:sor:2005-407",
      "stat:si:2004-121",
    ]);
    expect(norms("the IRPR, SOR/83-593, as amended", "statute")).toEqual([
      "stat:sor:1983-593",
    ]);
  });

  it("extracts named-Code references", () => {
    expect(norms("section 231 of the Criminal Code", "statute")).toEqual([
      "stat:criminalcode:s231",
    ]);
  });

  it("extracts neutral and US reporter case citations", () => {
    expect(norms("R v Smith, 2015 SCC 5 at para 12", "cite")).toEqual([
      "cite:2015scc5",
    ]);
    expect(norms("Gideon v. Wainwright, 372 U.S. 335 (1963)", "cite")).toEqual([
      "cite:372us335",
    ]);
  });
});

describe("extractAnchors: French productions", () => {
  it("normalizes French dates to the same keys as English", () => {
    expect(norms("le 15 mars 2027")).toEqual(["date:2027-03-15"]);
    expect(norms("le 1er juin 2020")).toEqual(["date:2020-06-01"]);
    expect(norms("le 3 février 2026")).toEqual(["date:2026-02-03"]);
    expect(norms("le 3 fevrier 2026")).toEqual(["date:2026-02-03"]); // OCR-stripped accent
  });

  it("reads trailing-sign and worded French money", () => {
    expect(norms("une somme de 2 250 000 $")).toEqual(["money:dlr:2250000"]);
    expect(norms("des frais de 50 $", "money")).toEqual(["money:dlr:50"]);
    expect(norms("40 millions de dollars")).toEqual(["money:dlr:40000000"]);
    expect(norms("870 millions d'euros")).toEqual(["money:eur:870000000"]);
    expect(norms("2,5 milliards de dollars")).toEqual(["money:dlr:2500000000"]);
  });

  it("reads French decimal-comma percentages", () => {
    expect(norms("environ 0,5 %", "percent")).toEqual(["pct:0.5"]);
    expect(norms("81 % du marché", "percent")).toEqual(["pct:81"]);
  });

  it("normalizes French duration units to English keys", () => {
    expect(norms("dans les trente (30) jours", "duration")).toEqual(["dur:30:day"]);
    expect(norms("un délai de 5 jours ouvrables", "duration")).toEqual([
      "dur:5:business_day",
    ]);
    expect(norms("un préavis de 60 jours francs", "duration")).toEqual([
      "dur:60:clear_day",
    ]);
    expect(norms("une période de 12 mois", "duration")).toEqual(["dur:12:month"]);
  });

  it("normalizes French statute citations to the English keys", () => {
    expect(norms("L.R.C. (1985), ch. C-46, art. 231", "statute")).toEqual([
      "stat:rsc1985:cc-46:s231",
    ]);
    expect(norms("la Loi, L.C. 1991, ch. 46, art. 427", "statute")).toEqual([
      "stat:sc1991:c46:s427",
    ]);
    expect(norms("sous le régime du RLRQ, c. S-2.1", "statute")).toEqual([
      "stat:cqlr:cs-2.1",
    ]);
    expect(norms("DORS/2005-407 et TR/2004-121", "statute")).toEqual([
      "stat:sor:2005-407",
      "stat:si:2004-121",
    ]);
  });

  it("maps French neutral-citation courts onto English twins", () => {
    expect(norms("R c Smith, 2015 CSC 5", "cite")).toEqual(["cite:2015scc5"]);
    expect(norms("2020 CAF 112", "cite")).toEqual(["cite:2020fca112"]);
  });
});

describe("extractAnchors: worded durations (statutory drafting)", () => {
  it("reads English worded durations", () => {
    expect(norms("not later than eighteen months after", "duration")).toEqual([
      "dur:18:month",
    ]);
    expect(norms("within thirty days of demand", "duration")).toEqual([
      "dur:30:day",
    ]);
  });

  it("reads French worded durations to the same keys", () => {
    expect(norms("dans les dix-huit mois suivant", "duration")).toEqual([
      "dur:18:month",
    ]);
    expect(norms("dans les quinze mois suivant", "duration")).toEqual([
      "dur:15:month",
    ]);
    expect(norms("un délai de quatre-vingt-dix jours", "duration")).toEqual([
      "dur:90:day",
    ]);
    expect(norms("vingt et un jours francs", "duration")).toEqual([
      "dur:21:clear_day",
    ]);
  });

  it("keeps real bilingual statute text concordant (CBCA s. 133 probe)", () => {
    // Verbatim (condensed) from A2AJ, laws-lois source, OGL-Canada.
    const en = {
      name: "cbca-133-en",
      text:
        "The directors of a corporation shall call an annual meeting of " +
        "shareholders (a) not later than eighteen months after the " +
        "corporation comes into existence; and (b) subsequently, not later " +
        "than fifteen months after holding the last preceding annual " +
        "meeting but no later than six months after the end of the " +
        "corporation's preceding financial year.",
    };
    const fr = {
      name: "cbca-133-fr",
      text:
        "Les administrateurs doivent convoquer une assemblée annuelle : " +
        "a) dans les dix-huit mois suivant la création de la société; " +
        "b) par la suite, dans les quinze mois suivant l'assemblée annuelle " +
        "précédente mais au plus tard dans les six mois suivant la fin de " +
        "chaque exercice.",
    };
    const report = bilingualConcordance(en, fr);
    expect(report.classes.duration.matched).toBe(3); // 18, 15, 6 months
    expect(report.discordant).toBe(0);
  });
});

describe("bilingualConcordance", () => {
  const en = {
    name: "en",
    text:
      "The fee is $2,250,000, payable within 30 days of March 15, 2027, " +
      "under R.S.C. 1985, c. C-46, s. 231 and SOR/2005-407.",
  };
  const fr = {
    name: "fr",
    text:
      "Les droits sont de 2 250 000 $, payables dans les 30 jours suivant " +
      "le 15 mars 2027, sous le régime de la L.R.C. (1985), ch. C-46, " +
      "art. 231 et du DORS/2005-407.",
  };

  it("reports full concordance when both versions carry the same anchors", () => {
    const report = bilingualConcordance(en, fr);
    expect(report.discordant).toBe(0);
    expect(report.classes.money.matched).toBe(1);
    expect(report.classes.date.matched).toBe(1);
    expect(report.classes.duration.matched).toBe(1);
    expect(report.classes.statute.matched).toBe(2);
  });

  it("surfaces version drift as english_only/french_only rows", () => {
    const frDrifted = {
      name: "fr",
      text: fr.text.replace("2 250 000 $", "2 500 000 $"),
    };
    const report = bilingualConcordance(en, frDrifted);
    expect(report.discordant).toBe(2);
    expect(report.classes.money.english_only.map((row) => row.norm)).toEqual([
      "money:dlr:2250000",
    ]);
    expect(report.classes.money.french_only.map((row) => row.norm)).toEqual([
      "money:dlr:2500000",
    ]);
  });
});

describe("numeralWordPairs", () => {
  it("passes agreeing pairs and flags disagreeing ones", () => {
    const ok = numeralWordPairs("terminates after thirty (30) days");
    expect(ok.checked).toBe(1);
    expect(ok.mismatches).toEqual([]);

    const bad = numeralWordPairs("terminates after thirty (20) days");
    expect(bad.checked).toBe(1);
    expect(bad.mismatches).toHaveLength(1);
    expect(bad.mismatches[0].wordsValue).toBe(30);
    expect(bad.mismatches[0].numeral).toBe(20);
  });

  it("parses only the trailing number-word phrase", () => {
    const result = numeralWordPairs("the panel shall be three (3) arbitrators");
    expect(result.checked).toBe(1);
    expect(result.mismatches).toEqual([]);
  });

  it("ignores parentheticals that are not numerals or lack number words", () => {
    expect(numeralWordPairs("as set out in clause (i)").checked).toBe(0);
    expect(numeralWordPairs("under Section 8.01 (2) hereof").checked).toBe(0);
  });

  it("handles compound number words", () => {
    expect(wordPhraseToNumber("one hundred twenty")).toBe(120);
    expect(wordPhraseToNumber("forty-five")).toBe(45);
    expect(wordPhraseToNumber("shall")).toBeNull();
    const compound = numeralWordPairs("one hundred twenty (120) days");
    expect(compound.checked).toBe(1);
    expect(compound.mismatches).toEqual([]);
  });
});

describe("anchorCoverage", () => {
  const sources = [
    {
      name: "credit-agreement.docx",
      text:
        "The Term Loan A matures on March 15, 2027. Outstanding balance of " +
        "$218.75 million. Interest defaults cure within 5 Business Days. " +
        "Leverage shall not exceed 4.50x.",
    },
  ];
  const drafts = [
    {
      name: "memo.docx",
      text:
        "The facility matures in March 2027 with a balance of $218,750,000. " +
        "We compute leverage of 3.68x against the 4.50x covenant.",
    },
  ];

  it("reports omissions, matches, and grounding candidates by class", () => {
    const report = anchorCoverage(sources, drafts);

    const dates = report.classes.date;
    expect(dates.source_only.map((row) => row.norm)).toEqual([
      "date:2027-03-15",
    ]);
    expect(dates.source_only[0].documents).toEqual(["credit-agreement.docx"]);

    const money = report.classes.money;
    expect(money.matched).toBe(1);
    expect(money.source_only).toEqual([]);

    const durations = report.classes.duration;
    expect(durations.source_only.map((row) => row.norm)).toEqual([
      "dur:5:business_day",
    ]);

    const ratios = report.classes.ratio;
    expect(ratios.matched).toBe(1); // 4.50x
    expect(ratios.draft_only.map((row) => row.norm)).toEqual(["ratio:3.68"]);
  });

  it("caps rows per class and reports truncation", () => {
    const manyMoney = {
      name: "s",
      text: "$1 million and $2 million and $3 million",
    };
    const report = anchorCoverage([manyMoney], [{ name: "d", text: "none" }], {
      maxRowsPerClass: 1,
    });
    expect(report.classes.money.source_only).toHaveLength(1);
    expect(report.classes.money.source_only_truncated).toBe(true);
  });
});

describe("anchor rows as citable spans", () => {
  const moneyRow = (source: { name: string; text: string }) =>
    anchorCoverage([source], [{ name: "d", text: "none" }]).classes.money
      .source_only[0];

  it("addresses the first occurrence and vouches for a clean excerpt", () => {
    const source = { name: "s", text: "Fee: $2,250,000 due." };
    const row = moneyRow(source);
    expect(row.at).toBe(5);
    expect(source.text.slice(row.at, row.at + row.display.length)).toBe(
      "$2,250,000",
    );
    expect(row.excerpt).toBe(source.text);
    expect(row.verbatim).toBe(true);
  });

  it("withholds the vouch when the excerpt was collapsed", () => {
    const source = { name: "s", text: "Fee:\n$2,250,000 due." };
    const row = moneyRow(source);
    // The display string is unchanged; only the claim about it is.
    expect(row.excerpt).toBe("Fee: $2,250,000 due.");
    expect(row.verbatim).toBe(false);
    expect(source.text.slice(row.at, row.at + row.display.length)).toBe(
      "$2,250,000",
    );
  });

  it("withholds the vouch when the excerpt was cut at either end", () => {
    const source = {
      name: "s",
      text:
        "The parties agree as follows and without limitation: the purchase " +
        "price is $2,250,000 payable in immediately available funds at the " +
        "closing contemplated by this agreement.",
    };
    const row = moneyRow(source);
    expect(row.verbatim).toBe(false);
    expect(row.excerpt).not.toBe(source.text);
    expect(source.text.slice(row.at, row.at + row.display.length)).toBe(
      "$2,250,000",
    );
  });
});
