// Note-up probe: what the citator graph actually knows about leading
// decisions, and whether the alias closure is doing its job.
//
// The graph keys citations literally (the corpus lookup-index key space), so
// "2019 SCC 65", its S.C.R. parallel citation and its French twin are three
// DIFFERENT keys. They are unioned at query time only when the corpus lookup
// index resolves them to one decision unambiguously. That union is the thing
// most worth checking: if it silently stopped working, every note-up would
// undercount and still look plausible.
//
//   npx tsx scripts/citator-noteup-probe.ts ["2019 SCC 65" ...]
import { graphStats, noteUpCitations } from "../src/lib/caselawCitator";

const LEADING = [
  "2019 SCC 65", // Vavilov
  "2008 SCC 9", // Dunsmuir
  "[1999] 2 SCR 817", // Baker
  "2015 SCC 5", // Carter
  "2016 SCC 27", // Jordan
  "2004 SCC 4", // Bell ExpressVu
];

/** Forms of one decision that the alias closure should treat as equivalent. */
const ALIAS_SETS = [
  ["2019 SCC 65", "2019 CSC 65", "[2019] 4 SCR 653", "[2019] 4 RCS 653"],
  ["2015 SCC 5", "2015 CSC 5", "[2015] 1 SCR 331"],
];

function main() {
  const stats = graphStats();
  if (!stats) {
    console.log("citator_not_installed — no graph at the configured path");
    return;
  }
  console.log("graph:", JSON.stringify(stats));

  const custom = process.argv.slice(2);
  console.log("\n--- citing cases (total, not page size) ---");
  for (const citation of custom.length ? custom : LEADING) {
    const result = noteUpCitations({ citation, size: 5 });
    if (!result) continue;
    const courts = new Map<string, number>();
    for (const entry of result.entries) {
      const court = entry.court ?? "?";
      courts.set(court, (courts.get(court) ?? 0) + 1);
    }
    console.log(
      `${citation.padEnd(18)} ${String(result.total).padStart(6)} citing cases` +
        `   newest page: ${[...courts.keys()].join(",") || "—"}`,
    );
  }

  if (custom.length) return;
  console.log("\n--- alias closure (all forms of one decision) ---");
  for (const forms of ALIAS_SETS) {
    const totals = forms.map((form) => ({
      form,
      total: noteUpCitations({ citation: form, size: 1 })?.total ?? -1,
    }));
    const distinct = new Set(totals.map((t) => t.total));
    console.log(
      `${distinct.size === 1 ? "UNIONED " : "SPLIT   "} ${totals
        .map((t) => `${t.form}=${t.total}`)
        .join("  ")}`,
    );
  }
}

main();
