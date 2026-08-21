/**
 * Collapse enumerated legal provision locators into their shortest honest
 * display form.
 *
 * "Honest" means endpoint-style: reading ss 49(1)-(4) is rendered
 * "49(1)-49(4)" even if the reader only saw some interior subsections,
 * because the endpoints name what was actually requested. Two structural
 * rules apply before endpoint pairing:
 *
 * 1. A label nested under another present label disappears - reading the
 *    parent provision includes its children ("49(2)" subsumes "49(2)(a)").
 * 2. Provisions sharing one root section pair by their outermost siblings;
 *    different roots render as separate groups.
 *
 * Paragraph locators have no nesting, so they instead run-length into
 * ranges over consecutive integers, keeping genuine gaps visible.
 */

type Provision = { root: string; tokens: string[] };

const PROVISION_RE = /^([A-Za-z]?\d+(?:\.\d+)*)((?:\([^()[\]]{1,12}\))*)$/u;

function parseProvision(label: string): Provision | null {
  const match = label.match(PROVISION_RE);
  if (!match) return null;
  const tokens: string[] = [];
  for (const token of match[2]?.matchAll(/\([^()[\]]{1,12}\)/gu) ?? []) {
    tokens.push(token[0]);
  }
  return { root: match[1], tokens };
}

function provisionText(provision: Provision): string {
  return `${provision.root}${provision.tokens.join("")}`;
}

function isDescendantOf(child: Provision, parent: Provision): boolean {
  return (
    child.root === parent.root &&
    child.tokens.length > parent.tokens.length &&
    parent.tokens.every((token, index) => child.tokens[index] === token)
  );
}

function collapseSectionLabels(labels: readonly string[]): string[] | null {
  const parsed: Provision[] = [];
  for (const label of labels) {
    // A label may itself name a range ("49(1)\u201349(4)"); both ends are
    // provisions the reader saw.
    const parts = label.split(/[\u2013\u2014-]/u).map(parseProvision);
    if (parts.some((part) => !part)) return null;
    parsed.push(...(parts as Provision[]));
  }
  const kept = parsed.filter(
    (provision) =>
      !parsed.some((other) => other !== provision && isDescendantOf(provision, other)),
  );
  const groups: Array<Provision[]> = [];
  for (const provision of kept) {
    const group = groups.find(([first]) => first.root === provision.root);
    if (group) group.push(provision);
    else groups.push([provision]);
  }
  return groups.map((group) =>
    group.length === 1
      ? provisionText(group[0])
      : `${provisionText(group[0])}\u2013${provisionText(group.at(-1)!)}`,
  );
}

function collapseParagraphLabels(labels: readonly string[]): string[] | null {
  const numbers = labels.map((label) =>
    /^\d{1,6}$/u.test(label) ? Number(label) : null,
  );
  if (numbers.some((number) => number === null)) return null;
  const groups: string[] = [];
  let index = 0;
  while (index < numbers.length) {
    const start = numbers[index]!;
    let end = start;
    while (
      index + 1 < numbers.length &&
      numbers[index + 1] === end + 1
    ) {
      index += 1;
      end = numbers[index]!;
    }
    groups.push(start === end ? String(start) : `${start}\u2013${end}`);
    index += 1;
  }
  return groups;
}

/**
 * Render collapsed display groups for locator labels of one kind. Returns
 * null when any label does not fit the kind's grammar; callers then fall
 * back to plain enumeration rather than guessing.
 */
export function collapseProvisionLabels(
  labels: readonly string[],
  kind: string,
): string[] | null {
  if (!labels.length) return null;
  if (kind === "paragraph") return collapseParagraphLabels(labels);
  if (kind === "section") return collapseSectionLabels(labels);
  return null;
}

const LOCATOR_PREFIX = /^(?:sections?|secs?|ss?|paragraphs?|paras?|par)\.?/iu;

function parseLocatorProvision(label: string): Provision | null {
  const stripped = label
    .split(/[\u2013\u2014-]/u)
    .map((part) => part.replace(LOCATOR_PREFIX, "").trim())
    .join("-");
  return parseProvision(stripped);
}

/**
 * Minimal citation form for provisions cited together. Unlike tool-label
 * display, a citation keeps every attached receipt: when an ancestor is
 * present it stands in for its descendants ("s 50(1)" covers "(a)-(c)",
 * because the parent provision legally encompasses them); otherwise
 * siblings pair under their shared token prefix ("49(1)\u2013(4)").
 * Returns null when any label is not a well-formed provision.
 */
export function renderSectionSpan(labels: readonly string[]): string | null {
  const parsed: Provision[] = [];
  for (const label of labels) {
    const parts = label
      .split(/[\u2013\u2014-]/u)
      .map(parseLocatorProvision);
    if (parts.some((part) => !part)) return null;
    parsed.push(...(parts as Provision[]));
  }
  const unique = [...new Map(parsed.map((provision) => [provisionText(provision), provision])).values()];
  const minimal = unique.filter(
    (provision) =>
      !unique.some((other) => other !== provision && isDescendantOf(provision, other)),
  );
  if (minimal.length === 1) return provisionText(minimal[0]);
  const tokenLists = minimal.map(
    (provision) => [provision.root, ...provision.tokens] as const,
  );
  let shared = 0;
  while (tokenLists.every((list) => list.length > shared + 1)) {
    const token = tokenLists[0]![shared];
    if (tokenLists.some((list) => list[shared] !== token)) break;
    shared += 1;
  }
  if (shared === 0) return null;
  const first = tokenLists[0]!.slice(shared).join("");
  const last = tokenLists.at(-1)!.slice(shared).join("");
  if (!first || !last) return null;
  return `${tokenLists[0]!.slice(0, shared).join("")}${first}\u2013${last}`;
}

/** The root section number of a locator label ("sec50(2)" -> "50"), or null. */
export function provisionRoot(label: string): string | null {
  return parseLocatorProvision(label)?.root ?? null;
}
