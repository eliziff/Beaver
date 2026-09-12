type Provision = { root: string; tokens: string[] };

const PROVISION = /^([A-Za-z]?\d+(?:\.\d+)*)((?:\([^()[\]]{1,12}\))*)$/u;
const PREFIX = /^(?:sections?|secs?|ss?|s|paragraphs?|paras?|par|pages?|pp?|footnotes?|notes?|nn?|fn)\.?[\s._=-]*/iu;

function parse(label: string): Provision | null {
  const match = label.replace(PREFIX, "").match(PROVISION);
  return match ? {
    root: match[1],
    tokens: Array.from(match[2].matchAll(/\([^()[\]]{1,12}\)/gu),
      (token) => token[0]),
  } : null;
}

const text = ({ root, tokens }: Provision) => root + tokens.join("");
const contains = (parent: Provision, child: Provision) =>
  parent.root === child.root && parent.tokens.length < child.tokens.length &&
  parent.tokens.every((token, index) => child.tokens[index] === token);

function sections(labels: readonly string[]) {
  const unique = [...new Set(labels)];
  if (unique.length === 1 && /[–—-]/u.test(unique[0])) {
    const endpoints = unique[0].split(/[–—-]/u).map(parse);
    return endpoints.some((value) => !value)
      ? null
      : [renderSectionSpan((endpoints as Provision[]).map(text)) ?? (endpoints as Provision[]).map(text).join("–")];
  }
  const parsed = unique.flatMap((label) => label.split(/[–—-]/u).map(parse));
  if (parsed.some((value) => !value)) return null;
  const values = parsed as Provision[];
  const minimal = values.filter((value) =>
    !values.some((other) => other !== value && contains(other, value)));
  const groups = new Map<string, Provision[]>();
  for (const value of minimal) {
    const group = groups.get(value.root) ?? [];
    group.push(value);
    groups.set(value.root, group);
  }
  return [...groups.values()].flatMap((group) => {
    const spans: string[] = [];
    for (let index = 0; index < group.length; index += 1) {
      const first = group[index];
      let last = first;
      while (index + 1 < group.length && consecutiveSiblings(last, group[index + 1]))
        last = group[++index];
      spans.push(first === last ? text(first) : renderSectionSpan([text(first), text(last)])!);
    }
    return spans;
  });
}

function consecutiveSiblings(left: Provision, right: Provision) {
  if (!left.tokens.length || left.tokens.length !== right.tokens.length ||
      !left.tokens.slice(0, -1).every((token, index) => token === right.tokens[index])) return false;
  const a = left.tokens.at(-1)!.slice(1, -1);
  const b = right.tokens.at(-1)!.slice(1, -1);
  if (/^\d+(?:\.\d+)*$/u.test(a) && /^\d+(?:\.\d+)*$/u.test(b)) {
    const from = a.split(".").map(Number);
    const to = b.split(".").map(Number);
    return b === `${a}.1` || to.length <= from.length &&
      to.slice(0, -1).every((part, index) => part === from[index]) &&
      to.at(-1) === from[to.length - 1] + 1;
  }
  return /^[a-z]$/u.test(a) && /^[a-z]$/u.test(b) && b.charCodeAt(0) === a.charCodeAt(0) + 1;
}

function numericRanges(labels: readonly string[]) {
  const values = [...new Set(labels.map((label) => label.replace(PREFIX, "").trim()))]
    .map((label) => /^\d{1,6}$/u.test(label) ? Number(label) : null);
  if (values.some((value) => value === null)) return null;
  values.sort((left, right) => left! - right!);
  const groups: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const start = values[index]!;
    let end = start;
    while (values[index + 1] === end + 1) end = values[++index]!;
    groups.push(start === end ? String(start) : `${start}–${end}`);
  }
  return groups;
}

export function collapseProvisionLabels(labels: readonly string[], kind: string) {
  if (!labels.length) return null;
  return ["paragraph", "page", "footnote"].includes(kind) ? numericRanges(labels)
    : kind === "section" ? sections(labels) : null;
}

function renderSectionSpan(labels: readonly string[]) {
  const parsed = labels.map(parse);
  if (parsed.some((value) => !value)) return null;
  const unique = [...new Map((parsed as Provision[]).map((value) =>
    [text(value), value])).values()];
  const minimal = unique.filter((value) =>
    !unique.some((other) => other !== value && contains(other, value)));
  if (minimal.length === 1) return text(minimal[0]);
  const paths = minimal.map(({ root, tokens }) => [root, ...tokens]);
  let shared = 0;
  while (paths.every((path) => path.length > shared + 1) &&
      paths.every((path) => path[shared] === paths[0][shared])) shared += 1;
  return shared
    ? `${paths[0].slice(0, shared).join("")}${paths[0].slice(shared).join("")}–${paths.at(-1)!.slice(shared).join("")}`
    : null;
}
