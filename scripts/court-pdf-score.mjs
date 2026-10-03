// Immutable v2 policy. Pair indices remain coupled across all four timing cells.
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  if (!sorted.length || sorted.some(value => !Number.isFinite(value) || value <= 0))
    throw new Error("Invalid positive timing ratio");
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const geometricMean = values => Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length);
export function pairedScore(cells, { bootstrapRepeats = 5000, bootstrapSeed = 60493, pairedWinFraction = 0.8 } = {}) {
  const values = Object.values(cells), count = values[0]?.length;
  if (!count || values.length !== 4 || values.some(rows => rows.length !== count))
    throw new Error("Expected four matched cold/warm timing cells");
  const ratios = Object.fromEntries(Object.entries(cells).map(([key, rows]) => [key, median(rows)]));
  const normalizedRatio = geometricMean(Object.values(ratios));
  const pairRatios = Array.from({ length: count }, (_, index) => geometricMean(values.map(rows => rows[index])));
  let seed = bootstrapSeed >>> 0;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const draws = Array.from({ length: bootstrapRepeats }, () => {
    const indices = Array.from({ length: count }, () => Math.floor(random() * count));
    return geometricMean(values.map(rows => median(indices.map(index => rows[index]))));
  }).sort((a, b) => a - b);
  const upper95 = draws[Math.ceil(draws.length * 0.95) - 1];
  const lower05 = draws[Math.ceil(draws.length * 0.05) - 1];
  return { ratios, normalizedRatio, improvement: 1 - normalizedRatio, pairRatios,
    wins: pairRatios.filter(value => value < 1).length, upper95, lower05,
    repeatablyBetter: normalizedRatio < 1 && upper95 < 1 && pairRatios.filter(value => value < 1).length / count >= pairedWinFraction };
}
