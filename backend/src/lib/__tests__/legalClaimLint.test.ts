import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";

import {
  alienPhrases,
  corpusAlienness,
  fnv1a64,
  lintLegalClaim,
} from "../legalClaimLint";

/**
 * Parity vectors computed by scripts/build_alienness_index.py's fnv1a64
 * on 2026-07-30. If these drift, the TS reader and the Python builder
 * no longer address the same index rows.
 */
const PARITY: Array<[string, bigint]> = [
  ["if rent is", 4250648548032937587n],
  ["the landlord may", 1521234908171332799n],
  ["n'y a pas", 3676051971472155154n],
];

const directory = mkdtempSync(path.join(os.tmpdir(), "alienness-test-"));
const indexPath = path.join(directory, "trigrams-en.sqlite");

function buildFixtureIndex() {
  const database = new DatabaseSync(indexPath);
  database.exec(
    "create table trigram (hash integer primary key, n integer not null) without rowid",
  );
  database.exec("create table meta (key text primary key, value text not null)");
  const insert = database.prepare("insert into trigram (hash, n) values (?, ?)");
  // Reference "corpus": one sentence, plus one boilerplate trigram.
  const sentence =
    "if rent is unpaid when due the landlord may deliver a written notice";
  const tokens = sentence.split(" ");
  for (let index = 0; index + 2 < tokens.length; index += 1) {
    insert.run(fnv1a64(tokens.slice(index, index + 3).join(" ")), 2);
  }
  insert.run(fnv1a64("of the act"), 500);
  const meta = database.prepare("insert into meta (key, value) values (?, ?)");
  meta.run("schema_version", "1");
  meta.run("doc_count", "1");
  database.close();
}
buildFixtureIndex();

afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("fnv1a64 cross-runtime parity", () => {
  it("matches the Python builder's vectors", () => {
    for (const [input, expected] of PARITY) {
      expect(fnv1a64(input)).toBe(expected);
    }
  });
});

describe("corpusAlienness", () => {
  it("scores attested text low and alien text high", () => {
    const attested = corpusAlienness(
      "if rent is unpaid when due the landlord may deliver a written notice",
      { indexPath },
    )!;
    expect(attested.unattested).toBeLessThan(0.2);
    const alien = corpusAlienness(
      "the state maintains a comprehensive statutory framework broadly regulating residential evictions",
      { indexPath },
    )!;
    expect(alien.unattested).toBe(1);
    expect(alien.index.docCount).toBe(1);
  });

  it("classifies boilerplate by reference count", () => {
    const spectrum = corpusAlienness("pursuant of the act", { indexPath })!;
    // "of the act" is the count-500 trigram; the other trigram is alien.
    expect(spectrum.boilerplate).toBeCloseTo(0.5);
    expect(spectrum.unattested).toBeCloseTo(0.5);
  });

  it("returns null when no index exists", () => {
    expect(
      corpusAlienness("anything", {
        indexPath: path.join(directory, "missing.sqlite"),
      }),
    ).toBeNull();
  });
});

describe("alienPhrases (Stage 9 H13-advisory)", () => {
  it("names the maximal unattested runs in the claim's own words", () => {
    expect(
      alienPhrases(
        "if rent is unpaid when due the landlord may comprehensively regulate everything",
        { indexPath },
      ),
    ).toEqual(["landlord may comprehensively regulate everything"]);
  });

  it("returns [] for fully attested text and for text too short to trigram", () => {
    expect(
      alienPhrases("if rent is unpaid when due the landlord may", {
        indexPath,
      }),
    ).toEqual([]);
    expect(alienPhrases("rent is", { indexPath })).toEqual([]);
  });

  it("returns null when no index exists — never an empty pass", () => {
    expect(
      alienPhrases("anything at all here", {
        indexPath: path.join(directory, "missing.sqlite"),
      }),
    ).toBeNull();
  });
});

describe("lintLegalClaim", () => {
  const span =
    "If rent is unpaid when due, the landlord may deliver a written notice " +
    "to terminate the lease not less than seven business days after receipt.";

  it("profiles the overreach shape and fires calibrated features only", () => {
    const result = lintLegalClaim(
      {
        claim:
          "Alabama maintains a comprehensive statutory framework broadly regulating residential evictions.",
        spans: [span],
        question: "Does Alabama regulate residential evictions?",
        alienessIndexPath: indexPath,
      },
      { novelContentFraction: 0.55, unattestedShare: 0.75 },
    );
    const byName = Object.fromEntries(
      result.receipts.map((receipt) => [receipt.feature, receipt]),
    );
    expect(byName.novel_content_fraction.fired).toBe(true);
    expect(byName.novel_abstraction_terms.value).toBeGreaterThanOrEqual(2);
    expect(byName.unattested_trigram_share.fired).toBe(true);
    expect(byName.prompt_only_share.value).toBeGreaterThan(0);
    expect(result.flagged).toBe(true);
  });

  it("keeps a faithful paraphrase unflagged under the same thresholds", () => {
    const result = lintLegalClaim(
      {
        claim:
          "If rent is unpaid when due, the landlord may deliver a written notice to terminate the lease.",
        spans: [span],
        question: "Does Alabama regulate residential evictions?",
        alienessIndexPath: indexPath,
      },
      { novelContentFraction: 0.55, unattestedShare: 0.75 },
    );
    expect(result.flagged).toBe(false);
  });

  it("hard-fires temporal inversion regardless of calibration", () => {
    const result = lintLegalClaim({
      claim: "The trial court followed the later appellate ruling.",
      spans: [span],
      claimCaseDate: "2004-06-01",
      citedCaseDate: "2019-12-01",
      alienessIndexPath: indexPath,
    });
    const temporal = result.receipts.find(
      (receipt) => receipt.feature === "temporal_inversion",
    );
    expect(temporal?.fired).toBe(true);
    expect(result.flagged).toBe(true);
  });

  it("never fires uncalibrated features", () => {
    const result = lintLegalClaim({
      claim: "Alabama broadly regulates evictions.",
      spans: [span],
      alienessIndexPath: indexPath,
    });
    expect(result.flagged).toBe(false);
    expect(
      result.receipts.every(
        (receipt) => receipt.fired === null || receipt.fired === false,
      ),
    ).toBe(true);
  });
});
