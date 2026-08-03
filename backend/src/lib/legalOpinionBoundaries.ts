export type OpinionRole =
  | "majority"
  | "minority"
  | "concurring"
  | "separate"
  | "unknown";

export type OpinionAuthorBinding = {
  role: OpinionRole;
  names: string[];
  concurred: string[];
  from: number | null;
  to: number | null;
  page: number | null;
  line: string;
  excerpt: string;
  bodyStart: boolean;
};

export type OpinionBodyMarker = {
  kind: "para_start_judge" | "court";
  paragraph: number | null;
  name: string | null;
  role: OpinionRole | null;
  line: string;
};

export type OpinionStructure = {
  status: "usable" | "unresolved" | "unavailable";
  panel: string[];
  bindings: OpinionAuthorBinding[];
  bodyMarkers: OpinionBodyMarker[];
  refusals: string[];
  header: string;
};

export type OpinionSpan = { from: number; to: number };

export type OpinionPartition = {
  status: "ready" | "unresolved";
  judges: Array<{ name: string; role: OpinionRole }>;
  spans: Record<OpinionRole, OpinionSpan[]>;
  note?: string;
};

const SUFFIX_TOKENS = [
  "C.J.C",
  "J.C.Q",
  "J.C.S",
  "J.T.C.J",
  "J.S.C",
  "J.F.C",
  "J.C",
  "J.J.A",
  "J.C.A",
  "J.A",
  "C.J",
  "JCA",
  "J.J",
  "JJ",
  "J",
] as const;

const SUFFIX_SOURCE = SUFFIX_TOKENS.map((token) =>
  token.replaceAll(".", "\\."),
).join("|");

const NAME_CHARS = String.raw`\p{L}\p{M}'’\-‐‑‒–—`;

const NAME_TOKEN = String.raw`[\p{Lu}](?:\.[\p{Lu}]){0,2}\.?[${NAME_CHARS}]*`;

const SUFFIX_RE = new RegExp(`(?:${SUFFIX_SOURCE})(?:\\.)?`, "u");

const JUDGE_NAME_RE = new RegExp(
  `(${NAME_TOKEN}(?:\\s+${NAME_TOKEN})*?)\\s+(${SUFFIX_SOURCE})(?:\\.)?(?=[\\s:,;()\\[\\]\\/\\-‐‑‒–—]|$)`,
  "u",
);

const JUDGE_NAMES_RE = new RegExp(JUDGE_NAME_RE.source, "gu");

const HONOURABLE_NAME_RE = new RegExp(
  String.raw`^the\s+honourable\s+(?:mr\.?\s+|mrs\.?\s+|madam(?:e)?\s+|chief\s+justice\s+|juge\s+)?(?:justice\s+|juge\s+)?(${NAME_TOKEN}(?:\s+${NAME_TOKEN})*)\s*$`,
  "iu",
);

const PAR_START_RE =
  /^\[\s*(\d+)\s*\]\s+([^:\n]+?)\s*(?:[:：]\s*|[—–]\s+)/mu;

const CJ_TITLE_RE =
  /^\s*(?:the\s+)?chief\s+justice(?:\s+of\s+canada)?\.?\s*$/iu;

const RANGE_PAREN_RE =
  /^\s*paras?\.?\s*(\d+)\s*(?:to|[-–—])\s*(\d+)\s*$/iu;
const PAGE_PARA_PAREN_RE =
  /^\s*(?:page|p)\.?\s*(\d+)\s*,\s*(?:para|paragraph)s?\.?\s*(\d+)\s*$/iu;
const PARA_PAGE_PAREN_RE =
  /^\s*(?:para|paragraph)s?\.?\s*(\d+)\s*,\s*(?:page|p)\.?\s*(\d+)\s*$/iu;
const PARA_ONLY_PAREN_RE =
  /^\s*(?:para|paragraph)s?\.?\s*(\d+)\s*$/iu;
const PAGE_ONLY_PAREN_RE = /^\s*(?:page|p)\.?\s*(\d+)\s*$/iu;

const PANEL_PATTERNS: RegExp[] = [
  /^(?:coram|before|present|panel|composition(?:\s+of\s+the\s+court)?|judges)\s*[:：.—]+\s*(.*)$/iu,
];

const BINDING_PATTERNS: Array<{ role: OpinionRole; re: RegExp; dissentByParen?: boolean; ofClause?: boolean }> = [
  {
    role: "majority",
    re: /^joint\s+reasons?\s+for\s+judg(?:e)?ment\s*:?\s*(.*)$/iu,
  },
  {
    role: "majority",
    re: /^(?:the\s+)?(?:written|oral|reserved)?\s*reasons?\s+(?:(?:for\s+judg(?:e)?ment|for\s+decision|of\s+the\s+court)\s+)?(?:delivered\s+)?(?:of|by)\s*:?\s*(.*)$/iu,
  },
  {
    role: "majority",
    ofClause: true,
    re: /^(?:the\s+)?(?:judg(?:e)?ment|decision)\s+(?:of\s+(.*?)\s+)?(?:was\s+)?delivered\s+(?:orally\s+)?by\s*[:：]?\s*(.*)$/iu,
  },
  { role: "majority", re: /^per\s+(.+?)\s*[:：]\s+/iu, dissentByParen: true },
  {
    role: "minority",
    re: /^dissenting\s+reasons?\s*(?:of|by)?\s*:?\s*(.*)$/iu,
  },
  { role: "minority", re: /^held\s+\((.+?)\)\s*[:：]/iu },
  {
    role: "concurring",
    re: /^concurring\s+reasons?\s*(?:of|by)?\s*:?\s*(.*)$/iu,
  },
  { role: "concurring", re: /^concurred\s+in\s+by\s*:?\s*(.*)$/iu },
  {
    role: "concurring",
    re: /^reasons?\s+concurring\s+in\s+the\s+result\s*:?\s*(.*)$/iu,
  },
  {
    role: "concurring",
    re: /^concurring\s+in\s+the\s+result\s*:?\s*(.*)$/iu,
  },
  {
    role: "separate",
    re: /^separate\s+reasons?\s*(?:of|by)?\s*:?\s*(.*)$/iu,
  },
  {
    role: "separate",
    re: /^additional\s+reasons?\s*(?:of|by)?\s*:?\s*(.*)$/iu,
  },
  {
    role: "majority",
    re: /^reasons?\s+for\s+judg(?:e)?ment\s*[:：]\s*(.*)$/iu,
  },
];

const BODY_HEADING_RE =
  /^(?:(?:written|oral|reserved)\s+)?(?:reasons?\s+for\s+judg(?:e)?ment|reasons?\s+of\s+the\s+court|by\s+the\s+court)\s*$/iu;

const MAX_HEADER = 40_000;
const MAX_CONTINUATION = 8;
const MAX_MARKERS = 80;
const MARKER_SCAN_WINDOW = 120_000;

function compact(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function suffixWord(token: string) {
  const plain = token.toLocaleLowerCase().replaceAll(".", "");
  return /^(?:cjc?|jcq?|jcs?|jtcj?|jsc?|jfc?|jja?|jca?|ja|jca|cj|jj|j)$/u.test(
    plain,
  );
}

function nameKey(name: string) {
  const tokens = name.split(/[\s'’\-]+/u).filter((token) => token.length > 0);
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    if (!suffixWord(tokens[i])) return tokens[i].toLocaleLowerCase();
  }
  return "";
}

function pushUnique(list: string[], name: string) {
  const key = nameKey(name);
  if (!key || key.length < 2) return;
  const index = list.findIndex((item) => nameKey(item) === key);
  if (index === -1) {
    list.push(name);
    return;
  }
  if (list[index].length < name.length) list[index] = name;
}

const WORD_RE = new RegExp(
  String.raw`^[\p{Lu}][${NAME_CHARS}]+(?:\s+[\p{Lu}][${NAME_CHARS}]+){0,2}$`,
  "u",
);

const COMMA_SUFFIX_RE = new RegExp(
  `,\\s*(${SUFFIX_SOURCE})(?:\\.)?(?=[\\s,;—–-]|$)`,
  "giu",
);

function parseNames(text: string, loose = false): string[] {
  const normalized = text
    .replace(/([\p{Lu}])\.\s+(?=[\p{Lu}]\b)/gu, "$1.")
    .replace(/\s+and\s+/giu, ", ")
    .replace(COMMA_SUFFIX_RE, " $1 ");
  const withoutParens = normalized
    .replace(/\([^()\n]*\)/gu, " ")
    .replace(/[:：]\s*$/u, "");
  const names: string[] = [];
  const honourable = HONOURABLE_NAME_RE.exec(withoutParens.trim());
  if (honourable) pushUnique(names, honourable[1]);
  for (const match of withoutParens.matchAll(JUDGE_NAMES_RE)) {
    pushUnique(names, match[0].trim());
  }
  if (CJ_TITLE_RE.test(withoutParens.trim())) {
    pushUnique(names, "The Chief Justice");
  }
  if (names.length || loose) {
    const flat = withoutParens.replace(/\s+and\s+/giu, ", ");
    const suffixEnd = new RegExp(`(?:${SUFFIX_SOURCE})\\.?$`, "u");
    for (const token of flat.split(/,\s*/u)) {
      const word = token.replace(suffixEnd, "").trim();
      if (
        word.length >= 2 &&
        WORD_RE.test(word) &&
        !CJ_TITLE_RE.test(word)
      ) {
        pushUnique(names, word);
      }
    }
  }
  return names;
}

function stripParens(text: string) {
  return text.replace(/\([^()\n]*\)/gu, " ").replace(/\s+/gu, " ").trim();
}

function parseCompletedList(text: string) {
  const normalized = text.replace(/\s+and\s+/giu, ", ");
  const names: string[] = [];
  for (const raw of normalized.split(",")) {
    const token = raw.trim();
    if (!token) continue;
    const parsed = SUFFIX_RE.test(token)
      ? parseNames(token)
      : parseNames(`${token} J.`);
    for (const name of parsed) pushUnique(names, name);
  }
  return names;
}

function parseParens(text: string) {
  const groups: Array<{
    from: number | null;
    to: number | null;
    page: number | null;
    concurred: string[];
  }> = [];
  for (const match of text.matchAll(/\(([^()\n]*)\)/gu)) {
    const raw = match[1].trim();
    const range = RANGE_PAREN_RE.exec(raw);
    const pagePara = PAGE_PARA_PAREN_RE.exec(raw);
    const paraPage = PARA_PAGE_PAREN_RE.exec(raw);
    const single = PARA_ONLY_PAREN_RE.exec(raw);
    const page = PAGE_ONLY_PAREN_RE.exec(raw);
    groups.push({
      from: range
        ? Number(range[1])
        : pagePara
          ? Number(pagePara[2])
          : paraPage
            ? Number(paraPage[1])
            : single
              ? Number(single[1])
              : null,
      to: range ? Number(range[2]) : null,
      page: pagePara
        ? Number(pagePara[1])
        : paraPage
          ? Number(paraPage[2])
          : page
            ? Number(page[1])
            : null,
      concurred: /\bconcurring\b/iu.test(raw)
        ? parseNames(raw.replace(/\bconcurring\b.*$/iu, ""))
        : [],
    });
  }
  return groups;
}

function firstNonNull(values: Array<number | null>): number | null {
  for (const value of values) if (value !== null) return value;
  return null;
}

function mergeGroups(
  target: { from: number | null; to: number | null; page: number | null; concurred: string[] },
  groups: ReturnType<typeof parseParens>,
) {
  for (const group of groups) {
    if (target.from === null) target.from = group.from;
    if (target.to === null) target.to = group.to;
    if (target.page === null) target.page = group.page;
    for (const name of group.concurred) pushUnique(target.concurred, name);
  }
}

function isHeadingLine(line: string) {
  const trimmed = line
    .replace(/^[\s\u00a0•·]+/u, "")
    .replace(/[\s\u00a0]+$/u, "");
  if (PANEL_PATTERNS.some((re) => re.test(trimmed))) return true;
  if (BINDING_PATTERNS.some(({ re }) => re.test(trimmed))) return true;
  if (BODY_HEADING_RE.test(trimmed)) return true;
  return false;
}

function nameLineRest(line: string) {
  return stripParens(line.replace(/\s*(?:[—–]|--).*$/u, ""));
}

function isNameLine(line: string) {
  if (isHeadingLine(line)) return false;
  if (/^\[\s*\d+\s*\]/u.test(line)) return false;
  if (/[:：][\s\u00a0]/u.test(line)) return false;
  const rest = nameLineRest(line);
  if (!rest) return false;
  if (/;/u.test(rest)) return false;
  if (HONOURABLE_NAME_RE.test(rest)) return true;
  return parseNames(rest).length > 0;
}

function isContinuationNameLine(line: string) {
  if (!isNameLine(line)) return false;
  const head = nameLineRest(line);
  const tokens = head.split(/\s+/u).filter(Boolean);
  if (tokens.length <= 3) return true;
  if (HONOURABLE_NAME_RE.test(head)) return true;
  if (/^[\s\S]{0,40}?(?:[—–]|--)/u.test(line)) return true;
  const shaped = tokens.filter((token) =>
    /^[\p{Lu}][\p{L}\p{M}'’\-\.]*(?:\.)?$/u.test(token),
  ).length;
  return shaped / tokens.length >= 0.6;
}

function scanBodyMarkers(text: string, firstParagraphStart: number): OpinionBodyMarker[] {
  const markers: OpinionBodyMarker[] = [];
  const window = text.slice(0, firstParagraphStart + MARKER_SCAN_WINDOW);
  for (const line of window.split(/\r?\n/u)) {
    const match = PAR_START_RE.exec(line);
    if (!match) continue;
    const paragraph = Number(match[1]);
    if (!Number.isInteger(paragraph) || paragraph < 1 || paragraph > 999_999) {
      continue;
    }
    const head = match[2].trim();
    if (head.length > 40) continue;
    let marker: OpinionBodyMarker | null = null;
    if (/^the\s+honourable\b/iu.test(head)) {
      const name = HONOURABLE_NAME_RE.exec(head)?.[1] ?? null;
      if (name) marker = { kind: "para_start_judge", paragraph, name, role: null, line: head };
    } else if (/^(?:the\s+court|by\s+the\s+court)$/iu.test(head)) {
      marker = { kind: "court", paragraph, name: null, role: "majority", line: head };
    } else {
      const judge = JUDGE_NAME_RE.exec(head);
      if (judge) {
        const name = judge[0].trim();
        const role = /dissents?|dissenting|dissented/iu.test(head)
          ? "minority"
          : /concurring|concurs?|concurrence/iu.test(head)
            ? "concurring"
            : null;
        marker = { kind: "para_start_judge", paragraph, name, role, line: head };
      }
    }
    if (marker) {
      markers.push(marker);
      if (markers.length >= MAX_MARKERS) break;
    }
  }
  return markers;
}

function compress(numbers: number[]): OpinionSpan[] {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const ranges: OpinionSpan[] = [];
  for (const number of sorted) {
    const last = ranges.at(-1);
    if (last && number === last.to + 1) last.to = number;
    else ranges.push({ from: number, to: number });
  }
  return ranges;
}

export function analyzeOpinionStructure(args: {
  text: string;
  firstParagraphStart?: number;
}): OpinionStructure {
  const firstParagraphStart = Math.max(0, args.firstParagraphStart ?? 0);
  const headerBound =
    firstParagraphStart > 0 ? Math.min(firstParagraphStart, MAX_HEADER) : MAX_HEADER;
  const header = args.text.slice(0, headerBound);
  const lines = header.split(/\r?\n/u);
  const panel: string[] = [];
  const bindings: OpinionAuthorBinding[] = [];
  const refusals: string[] = [];
  const pendingNameLines: string[] = [];

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line
      .replace(/^[\s\u00a0•·]+/u, "")
      .replace(/[\s\u00a0]+$/u, "");
    index += 1;
    if (!trimmed) continue;

    let panelRest = "";
    if (PANEL_PATTERNS.some((re) => { const match = re.exec(trimmed); if (!match) return false; panelRest = match[1]; return true; })) {
      for (const name of parseNames(panelRest, true)) pushUnique(panel, name);
      let consumed = 0;
      let pendingBlank = false;
      while (index < lines.length && consumed < MAX_CONTINUATION) {
        const next = lines[index].trim();
        if (!next) {
          if (pendingBlank) break;
          pendingBlank = true;
          index += 1;
          continue;
        }
        if (!isContinuationNameLine(next)) break;
        pendingBlank = false;
        for (const name of parseNames(nameLineRest(next))) pushUnique(panel, name);
        index += 1;
        consumed += 1;
      }
      continue;
    }

    const bindingMatch = BINDING_PATTERNS.find(({ re }) => re.exec(trimmed));
    if (bindingMatch) {
      const match = bindingMatch.re.exec(trimmed)!;
      const rest = bindingMatch.ofClause ? match[2] : match[1];
      const ofClause = bindingMatch.ofClause ? match[1] : undefined;
      const groups = parseParens(rest);
      const lineGroups: { from: number | null; to: number | null; page: number | null; concurred: string[] } = {
        from: null,
        to: null,
        page: null,
        concurred: [],
      };
      mergeGroups(lineGroups, groups);
      const names = parseNames(rest);
      const ofNames: string[] = [];
      if (ofClause) {
        const trimmedOf = ofClause.trim();
        if (/^(?:the\s+)?chief\s+justice(?:\s+of\s+canada)?\.?\s+and\s+(.+)$/iu.test(trimmedOf)) {
          pushUnique(ofNames, "The Chief Justice");
          for (const name of parseCompletedList(
            trimmedOf.replace(
              /^(?:the\s+)?chief\s+justice(?:\s+of\s+canada)?\.?\s+and\s+/iu,
              "",
            ),
          )) {
            pushUnique(ofNames, name);
          }
        } else if (!/^the\s+court$/iu.test(trimmedOf)) {
          for (const name of parseNames(trimmedOf)) pushUnique(ofNames, name);
        }
      }
      const continuation: string[] = [];
      let consumed = 0;
      let pendingBlank = false;
      while (index < lines.length && consumed < MAX_CONTINUATION) {
        const next = lines[index].trim();
        if (!next) {
          if (pendingBlank) break;
          pendingBlank = true;
          index += 1;
          continue;
        }
        const nextGroups = parseParens(next);
        if (isContinuationNameLine(next)) {
          pendingBlank = false;
          const nextNames = parseNames(nameLineRest(next));
          for (const name of nextNames) pushUnique(continuation, name);
          mergeGroups(lineGroups, nextGroups);
          index += 1;
          consumed += 1;
          continue;
        }
        const rangeOnly =
          nextGroups.some(
            (group) => group.from !== null || group.page !== null,
          ) &&
          nextGroups.every((group) => group.concurred.length === 0) &&
          !isHeadingLine(next);
        if (rangeOnly) {
          // "(paras. 43 to 74)" alone on its own line: merge the range and
          // stop; any later name line lands in pendingNameLines and is
          // aligned to unnamed range bindings in order.
          mergeGroups(lineGroups, nextGroups);
          index += 1;
          break;
        }
        {
          // A paragraph-marked line directly after a role heading can name
          // the author when the heading itself names no one ("delivered by
          // [1] Abella J."). Take at most one such attribution and stop.
          const paraMatch = PAR_START_RE.exec(next);
          const paraHead = paraMatch ? paraMatch[2].trim() : "";
          const paraNames = paraHead
            ? parseNames(nameLineRest(paraHead))
            : [];
          if (
            paraMatch &&
            paraNames.length &&
            continuation.length === 0 &&
            names.length === 0
          ) {
            for (const name of paraNames) pushUnique(continuation, name);
            index += 1;
          }
          break;
        }
      }
      const allNames = [...names];
      for (const name of ofNames) pushUnique(allNames, name);
      for (const name of continuation) pushUnique(allNames, name);
      const lineCompact = compact(trimmed);
      const restClean = stripParens(rest);
      const role =
        bindingMatch.dissentByParen && /\bdissenting\b/iu.test(rest)
          ? "minority"
          : bindingMatch.role;
      const hasRange = lineGroups.from !== null && lineGroups.to !== null;
      if (
        bindingMatch.dissentByParen &&
        !hasRange &&
        lineCompact.length > 140
      ) {
        continue;
      }
      const junk = !allNames.length && restClean.length > 0;
      if (!junk) {
        bindings.push({
          role,
          names: allNames,
          concurred: lineGroups.concurred,
          from: lineGroups.from,
          to: lineGroups.to,
          page: lineGroups.page,
          line: lineCompact,
          excerpt: compact(
            `${lineCompact}${allNames.length ? ` → ${allNames.slice(0, 3).join(", ")}` : ""}`,
          ),
          bodyStart: /^the\s+honourable\b/iu.test(restClean),
        });
      }
      if (!allNames.length && !hasRange) {
        refusals.push(
          `role heading without recognizable judge names: ${compact(trimmed)}`,
        );
      }
      continue;
    }

    if (BODY_HEADING_RE.test(trimmed)) {
      let bodyNames: string[] = [];
      let consumed = 0;
      while (index < lines.length && consumed < 3) {
        const next = lines[index].trim();
        if (!next) {
          index += 1;
          consumed += 1;
          continue;
        }
        if (isNameLine(next)) {
          bodyNames = parseNames(next);
          index += 1;
          break;
        }
        break;
      }
      bindings.push({
        role: "majority",
        names: bodyNames,
        concurred: [],
        from: null,
        to: null,
        page: null,
        line: compact(trimmed),
        excerpt: compact(
          `${trimmed}${bodyNames.length ? ` → ${bodyNames.join(", ")}` : ""}`,
        ),
        bodyStart: true,
      });
      if (!bodyNames.length) {
        refusals.push(
          `body heading without recognizable judge names: ${compact(trimmed)}`,
        );
      }
      continue;
    }

    if (isContinuationNameLine(trimmed)) {
      pendingNameLines.push(trimmed);
    }
  }

  let pendingIndex = 0;
  for (const binding of bindings) {
    if (binding.from === null || binding.names.length > 0) continue;
    const line = pendingNameLines[pendingIndex];
    if (!line) break;
    pendingIndex += 1;
    for (const name of parseNames(nameLineRest(line))) {
      pushUnique(binding.names, name);
    }
    for (const group of parseParens(line)) {
      for (const name of group.concurred) pushUnique(binding.concurred, name);
    }
  }

  const hasExplicitRange = bindings.some(
    (binding) => binding.from !== null && binding.to !== null,
  );
  const panelChiefs = panel.filter((name) =>
    /(?:^|\s)(?:C\.?J\.?C?\.?|juge\s+en\s+chef)\.?$/iu.test(name),
  );
  if (panelChiefs.length === 1) {
    const chiefName = panelChiefs[0];
    for (let index = 0; index < panel.length; index += 1) {
      if (CJ_TITLE_RE.test(panel[index])) panel[index] = chiefName;
    }
    for (const binding of bindings) {
      binding.names = binding.names.map((name) =>
        CJ_TITLE_RE.test(name) ? chiefName : name,
      );
      binding.concurred = binding.concurred.map((name) =>
        CJ_TITLE_RE.test(name) ? chiefName : name,
      );
    }
  }
  const status: OpinionStructure["status"] =
    bindings.length || panel.length
      ? hasExplicitRange
        ? "usable"
        : "unresolved"
      : "unavailable";
  if (status === "unavailable") {
    refusals.push("no opinion role bindings found in the header");
    refusals.push("no panel or coram roster found");
    refusals.push("no judge paragraph-start markers found");
  }
  return {
    status,
    panel,
    bindings,
    bodyMarkers: scanBodyMarkers(
      args.text,
      firstParagraphStart > 0 ? firstParagraphStart : MAX_HEADER,
    ),
    refusals,
    header,
  };
}

export function partitionOpinionStructure(
  structure: OpinionStructure,
  paragraphNumbers: number[],
): OpinionPartition {
  const spans: Record<OpinionRole, OpinionSpan[]> = {
    majority: [],
    minority: [],
    concurring: [],
    separate: [],
    unknown: [],
  };
  const available = [...new Set(paragraphNumbers)].sort((a, b) => a - b);
  if (available.length === 0) {
    return {
      status: "unresolved",
      judges: [],
      spans,
      note: "no paragraph spine",
    };
  }
  const explicit = structure.bindings.filter(
    (binding) =>
      binding.from !== null && binding.to !== null && binding.role !== "unknown",
  );
  const assigned = new Map<number, OpinionRole>();
  for (const binding of explicit) {
    for (let number = binding.from!; number <= binding.to!; number += 1) {
      if (!available.includes(number)) continue;
      if (assigned.has(number)) {
        return {
          status: "unresolved",
          judges: [],
          spans,
          note: "explicit opinion ranges overlap",
        };
      }
      assigned.set(number, binding.role);
    }
  }
  if (assigned.size !== available.length) {
    return {
      status: "unresolved",
      judges: [],
      spans,
      note: `opinion ranges cover ${assigned.size} of ${available.length} paragraphs`,
    };
  }
  const byRole = new Map<OpinionRole, number[]>();
  for (const [number, role] of assigned) {
    const list = byRole.get(role) ?? [];
    list.push(number);
    byRole.set(role, list);
  }
  for (const [role, list] of byRole) spans[role] = compress(list);
  const judges: Array<{ name: string; role: OpinionRole }> = [];
  for (const binding of structure.bindings) {
    for (const name of [...binding.names, ...binding.concurred]) {
      const key = nameKey(name);
      if (!key || judges.some((judge) => nameKey(judge.name) === key)) continue;
      judges.push({ name, role: binding.role });
    }
  }
  return { status: "ready", judges, spans };
}
