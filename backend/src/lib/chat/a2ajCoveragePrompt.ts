import { getA2AJCoverage, type A2AJCoverageResult } from "../a2aj";

const COVERAGE_CACHE_MS = 24 * 60 * 60_000;
let cached: { expiresAt: number; prompt: string } | null = null;

function year(value: string | null) {
  return value?.slice(0, 4) || "unknown";
}

export function formatA2AJCoveragePrompt(rows: A2AJCoverageResult[]) {
  const lines = (["cases", "laws"] as const).flatMap((docType) => {
    const byJurisdiction = new Map<string, A2AJCoverageResult[]>();
    for (const row of rows.filter((item) => item.docType === docType)) {
      byJurisdiction.set(row.jurisdictionCode, [
        ...(byJurisdiction.get(row.jurisdictionCode) ?? []),
        row,
      ]);
    }
    const groups = [...byJurisdiction.entries()].map(
      ([jurisdiction, items]) =>
        `${jurisdiction}: ${items
          .map(
            (item) =>
              `${item.dataset} (${year(item.earliestDate)}-${year(item.latestDate)})`,
          )
          .join(", ")}`,
    );
    return groups.length
      ? [`${docType === "cases" ? "Cases" : "Laws"}: ${groups.join("; ")}`]
      : [];
  });
  if (!lines.length) return "";
  return [
    "CURRENT A2AJ COVERAGE:",
    ...lines,
    "Use these exact dataset and date boundaries when searching A2AJ or assigning A2AJ-backed reader work. If a requested court, tribunal, jurisdiction, or period is absent, do not waste a reader lane asking A2AJ for it; use another available legal-source provider or say that A2AJ does not cover it. Absence from A2AJ is not proof that no responsive authority exists.",
  ].join("\n");
}

export async function currentA2AJCoveragePrompt() {
  if (cached && cached.expiresAt > Date.now()) return cached.prompt;
  try {
    const rows = (
      await Promise.all([getA2AJCoverage("cases"), getA2AJCoverage("laws")])
    ).flat();
    const prompt = formatA2AJCoveragePrompt(rows);
    cached = { expiresAt: Date.now() + COVERAGE_CACHE_MS, prompt };
    return prompt;
  } catch {
    return "";
  }
}
