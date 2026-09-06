/** No-junk sequence alignment shared by editorial rendering and the visible diff. */
export function sequenceOpcodes(left, right) {
  if (left.length * right.length > 4_000_000) return [["replace", 0, left.length, 0, right.length]];
  const blocks = [], pending =
    [[0, left.length, 0, right.length]];
  while (pending.length) {
    const [a0, a1, b0, b1] = pending.pop();
    let best = [a0, b0, 0];
    let prior = new Map();
    for (let i = a0; i < a1; i += 1) {
      const current = new Map();
      for (let j = b0; j < b1; j += 1) if (left[i] === right[j]) {
        const size = (prior.get(j - 1) ?? 0) + 1;
        current.set(j, size);
        if (size > best[2]) best = [i - size + 1, j - size + 1, size];
      }
      prior = current;
    }
    const [i, j, size] = best;
    if (!size) continue;
    blocks.push(best);
    if (a0 < i && b0 < j) pending.push([a0, i, b0, j]);
    if (i + size < a1 && j + size < b1) pending.push([i + size, a1, j + size, b1]);
  }
  blocks.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const block of blocks) {
    const last = merged.at(-1);
    if (last && last[0] + last[2] === block[0] && last[1] + last[2] === block[1]) last[2] += block[2];
    else merged.push([...block]);
  }
  const result = []; let i = 0, j = 0;
  for (const [nextI, nextJ, size] of [...merged, [left.length, right.length, 0]]) {
    if (i < nextI || j < nextJ) result.push([i < nextI && j < nextJ ? "replace"
      : i < nextI ? "delete" : "insert", i, nextI, j, nextJ]);
    if (size) result.push(["equal", nextI, nextI + size, nextJ, nextJ + size]);
    i = nextI + size; j = nextJ + size;
  }
  return result;
}
