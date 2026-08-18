export function mergeIntervals(
  intervals: Array<[number, number]>,
): Array<[number, number]> {
  const sorted = intervals
    .map(([start, end]): [number, number] =>
      start <= end ? [start, end] : [end, start])
    .filter(([start, end]) => end > start)
    .sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

export function coveredLength(
  intervals: Array<[number, number]>,
  start: number,
  end: number,
) {
  return mergeIntervals(intervals).reduce(
    (total, [left, right]) =>
      total + Math.max(0, Math.min(right, end) - Math.max(left, start)),
    0,
  );
}

export function readCoversBody(read: {
  sourceChars?: number;
  deliveredChars?: number;
  bodyStart?: number;
  intervals?: Array<[number, number]>;
}) {
  const sourceChars = read.sourceChars ?? 0;
  if (sourceChars <= 0) return false;
  if (!read.intervals) return (read.deliveredChars ?? 0) >= sourceChars;
  const bodyStart = read.bodyStart ?? 0;
  return coveredLength(read.intervals, bodyStart, sourceChars) >=
    sourceChars - bodyStart;
}
