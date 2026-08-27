type Provision = { root: string; tokens: string[] };

const PROVISION = /^([A-Za-z]?\d+(?:\.\d+)*)((?:\([^()[\]]{1,12}\))*)$/u;
const PREFIX = /^(?:sections?|secs?|ss?|s|paragraphs?|paras?|par)\.?\s*/iu;

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
  const parsed = labels.flatMap((label) => label.split(/[–—-]/u).map(parse));
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
  return [...groups.values()].map((group) => group.length === 1
    ? text(group[0])
    : `${text(group[0])}–${text(group.at(-1)!)}`);
}

function paragraphs(labels: readonly string[]) {
  const values = labels.map((label) => /^\d{1,6}$/u.test(label) ? Number(label) : null);
  if (values.some((value) => value === null)) return null;
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
  return kind === "paragraph" ? paragraphs(labels)
    : kind === "section" ? sections(labels) : null;
}

export const provisionRoot = (label: string) => parse(label)?.root ?? null;

export function renderSectionSpan(labels: readonly string[]) {
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
