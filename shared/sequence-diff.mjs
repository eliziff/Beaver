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

/** The fewest inserted and deleted characters that turn `t` (the text at `base`, `spanLength` positions
 *  long) into `s`, as [start, length, replacement] edits in ascending order: a character LCS, each gap
 *  between matched characters one edit. A span whose positions are not its characters (hidden content,
 *  fields), or a side longer than 200 characters, is replaced whole. Equal texts plan nothing.
 *  Ported exactly from the ALR macro (typesetting-macro-upload source/vba/ALR_Rules.bas ALR_PlanTextEdits,
 *  Option Compare Binary): same tie-breaks, UTF-16 units as VBA's Len and Mid$ count them. */
export function minimalEditPlan(t, s, base = 0, spanLength = t.length) {
  if (t === s) return [];
  const a = t.length, b = s.length;
  if (a !== spanLength || a > 200 || b > 200) return [[base, spanLength, s]];
  const width = b + 1, L = new Int32Array((a + 1) * width);
  for (let i = a - 1; i >= 0; i -= 1) for (let j = b - 1; j >= 0; j -= 1)
    L[i * width + j] = t[i] === s[j] ? L[(i + 1) * width + j + 1] + 1
      : Math.max(L[(i + 1) * width + j], L[i * width + j + 1]);
  const plan = [];
  let i = 0, j = 0, gapT = -1, gapS = 0;
  while (i < a || j < b) {
    if (i < a && j < b && t[i] === s[j]) {
      if (gapT >= 0) { plan.push([base + gapT, i - gapT, s.slice(gapS, j)]); gapT = -1; }
      i += 1; j += 1;
      continue;
    }
    if (gapT < 0) { gapT = i; gapS = j; }
    if (i < a && j < b) { if (L[(i + 1) * width + j] >= L[i * width + j + 1]) i += 1; else j += 1; }
    else if (i < a) i += 1; else j += 1;
  }
  if (gapT >= 0) plan.push([base + gapT, a - gapT, s.slice(gapS)]);
  return plan;
}

/** A plan's edits in the order the ALR macro writes them: later starts first, so earlier offsets stay valid,
 *  and edits that share a start in plan order. Ported from ALR_Rules.bas SortPlanDesc (a stable insertion sort);
 *  Array.prototype.sort is stable. */
export const descendingPlan = (plan) => [...plan].sort((a, b) => b[0] - a[0]);

/** The characters that differ between `t` and `s`, as [start, length, replacement] edits: the macro's plan, and
 *  where that plan replaces a long text whole (its 200-character cutoff), the character alignment of sequenceOpcodes,
 *  so a highlight still shows which letters differ. */
export function characterPlan(t, s) {
  const plan = minimalEditPlan(t, s);
  if (!(plan.length === 1 && plan[0][0] === 0 && plan[0][1] === t.length && t.length && s.length)) return plan;
  return sequenceOpcodes([...t], [...s]).filter(([kind]) => kind !== "equal")
    .map(([, a0, a1, b0, b1]) => [offset(t, a0), offset(t, a1) - offset(t, a0), [...s].slice(b0, b1).join("")]);
}
/** The UTF-16 offset of code point `index` in `text`. */
const offset = (text, index) => [...text].slice(0, index).join("").length;

/** The text `t` (at `base`) as runs [start, end, edited], marking what `plan` changes: the characters an edit
 *  removes or replaces; the characters an edit brackets (an editorial target writes an authored word the source does
 *  not have as "[word]"); and for any other edit that only inserts, the space at that point (a missing word), else
 *  the character after it, or the last character at the text's end. Runs cover `t` in order. */
export function highlightRuns(t, plan, base = 0) {
  const edited = new Uint8Array(t.length), space = /\s/u;
  const edits = [...plan].sort((a, b) => a[0] - b[0]);
  edits.forEach(([start, length, replacement], index) => {
    const at = start - base;
    if (length) { edited.fill(1, at, at + length); return; }
    const close = replacement.endsWith("[") && edits.slice(index + 1).find(([, , text]) => text.startsWith("]"));
    if (close) { edited.fill(1, at, close[0] - base); return; }
    if (replacement.startsWith("]") && edits.slice(0, index).some(([, , text]) => text.endsWith("["))) return;
    if (t.length) edited[at > 0 && space.test(t[at - 1]) ? at - 1 : at < t.length ? at : t.length - 1] = 1;
  });
  const runs = [];
  for (let i = 0; i < t.length;) {
    let j = i + 1;
    while (j < t.length && edited[j] === edited[i]) j += 1;
    runs.push([base + i, base + j, edited[i] === 1]);
    i = j;
  }
  return runs;
}
