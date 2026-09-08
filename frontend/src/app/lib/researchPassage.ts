const PREFIX: Record<string, string> = { paragraph: "¶", section: "s.", page: "p.", footnote: "n." };
type Locator = { kind: string; label: string };

/** A locator as a reader says it: "¶ 12", "s. 24(2)", "p. 3" — never the stored key ("par12"). */
export function passageLabel({ kind, label }: Locator) {
  const raw = (label ?? "").trim();
  const bare = raw.replace(/^(?:par(?:a(?:graph)?)?|sec(?:tion)?|page|p|fn|n|s)[.\s]*(?=[\d(])/iu, "").trim() || raw;
  const prefix = PREFIX[kind] ?? "";
  return prefix ? `${prefix} ${bare}` : bare;
}

/** Passage text carries the printed marker of its own paragraph; a row that already names the locator must not repeat it. */
export function trimPassageMarker(text: string, locator: Locator) {
  const bare = passageLabel(locator).replace(/^[^\d(]*\s*/u, "");
  const match = /^\s*[[(]\s*([\w.()-]+?)\s*[\])]\s*/u.exec(text);
  return match && bare && match[1].toLowerCase() === bare.toLowerCase() ? text.slice(match[0].length) : text;
}
