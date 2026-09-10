function extractExhibitMentions(text) {
  const mentions = {}, flat = text.replace(/\s+/gu, " ").trim();
  for (const match of flat.matchAll(/\bExhibit\s*["“”'‘’]?\s*([A-Z]{1,2})\s*["“”'‘’]?\b/giu)) {
    const lower = Math.max(0, match.index - 280), upper = Math.min(flat.length,
      match.index + match[0].length + 300);
    const before = [".", "?", "!", ";"].reduce((position, mark) =>
      Math.max(position, flat.lastIndexOf(mark, match.index - 1)), -1);
    const after = [".", "?", "!", ";"].map((mark) =>
      flat.indexOf(mark, match.index + match[0].length)).filter((index) => index >= 0);
    const end = Math.min(upper, after.length ? Math.min(...after) + 1 : upper);
    let start = before >= lower ? before + 1 : lower;
    let statement = flat.slice(start, end).replace(/^\s*\d+[.)]?\s*/u, "").trim();
    if (statement.split(/\s+/u).length < 5 && before >= lower) {
      const prior = [".", "?", "!", ";"].reduce((position, mark) =>
        Math.max(position, flat.lastIndexOf(mark, before - 1)), -1);
      start = prior >= lower ? prior + 1 : lower;
      statement = flat.slice(start, end).replace(/^\s*\d+[.)]?\s*/u, "").trim();
    }
    if (!statement || /This is Exhibit\b.{0,120}\b(?:referred to in|to) the Affidavit/iu
      .test(statement)) continue;
    const values = mentions[match[1].toUpperCase()] ??= [];
    const key = mentionKey(statement);
    if (!values.some((value) => mentionKey(value) === key)) values.push(statement);
  }
  return mentions;
}

function sourceExhibitLabels(pages) {
  const labels = Object.keys(extractExhibitMentions(pages.filter((page) => page.trim())
    .join("\n.\n")));
  const highest = Math.max(0, ...labels.map((label) => [...label].reduce((value, character) =>
    value * 26 + character.charCodeAt(0) - 64, 0)));
  return Array.from({ length: highest }, (_, index) => {
    let value = index + 1, label = "";
    while (value) { value -= 1; label = String.fromCharCode(65 + value % 26) + label;
      value = Math.floor(value / 26); }
    return label;
  });
}

const mentionKey = (value) => value.normalize("NFKC").toLocaleLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, "");

export { extractExhibitMentions, mentionKey, sourceExhibitLabels };
