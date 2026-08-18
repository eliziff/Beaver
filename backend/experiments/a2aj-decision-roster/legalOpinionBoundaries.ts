
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
  nonparticipants: string[];
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

export type OpinionAlignment =
  | "lead"
  | "same_result_separate_reasons"
  | "different_result"
  | "mixed"
  | "unknown";

export type JudgeResultSide = "majority" | "minority" | "mixed" | "unknown";

export type JudgeOpinionRelationship =
  | "authors"
  | "joins_reasons"
  | "concurs_in_result_only"
  | "mixed"
  | "unknown";

export type TextOpinion = {
  id: string;
  authors: string[];
  alignment: OpinionAlignment;
  start: number;
  end: number;
  startQuote: string;
  endQuote: string;
  substantiveWords: number;
  evidence: string[];
};

export type JudgeVote = {
  name: string;
  resultSide: JudgeResultSide;
  relationship: JudgeOpinionRelationship;
  opinionIds: string[];
  evidence: string[];
};

export type TextOpinionStructure = {
  status: "ready" | "unresolved" | "unavailable";
  panel: string[];
  nonparticipants: string[];
  opinions: TextOpinion[];
  judges: JudgeVote[];
  refusals: string[];
};

type OffsetBlock = { label: string; start: number; end: number };

const SUFFIX_TOKENS = [
  "C.J.P.E.I",
  "C.J.N.S",
  "C.J.B.C",
  "C.J.N.B",
  "C.J.N.L",
  "A.C.J.O",
  "C.J.O",
  "C.J.A",
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

const NONPARTICIPATION_RE =
  /^\s*(?:\[\s*\*\s*\]\s*)?(.{2,180}?)\s+(?:took\s+no\s+part|did\s+not\s+(?:take\s+part|participate)|n['’]\s+a\s+pas\s+participé)\b/iu;

const TRAILING_CASE_METADATA_RE =
  /^(?:(?:appearances?|counsel|solicitors?)\b[^:\n]{0,160}|place\s+of\s+hearing|date\s+of\s+hearing|reasons?\s+for\s+judg(?:e)?ment\s+by|dated|docket|style\s+of\s+cause)\s*[:：]/iu;

function compact(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function suffixWord(token: string) {
  const plain = token.toLocaleLowerCase().replaceAll(".", "");
  return /^(?:cjpei|cjns|cjbc|cjnb|cjnl|acjo|cjo|cja|cjc?|jcq?|jcs?|jtcj?|jsc?|jfc?|jja?|jca?|ja|jca|cj|jj|j)$/u.test(
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
  if (/^(?:Q\.?C\.?|K\.?C\.?|Board\s+Member|(?:Vice[-\s]?)?Chair(?:person)?)$/iu.test(name.trim())) return;
  if (
    !SUFFIX_RE.test(name) &&
    !/^the\s+honourable\b|\bchief\s+justice\b/iu.test(name) &&
    /\b(?:board|court|commission|tribunal|agency|department|ministry|council|authority|service|office|(?:vice[-\s]?)?chair(?:person)?)\s*$/iu.test(name)
  ) {
    return;
  }
  const key = nameKey(name);
  if (!key || key.length < 2) return;
  const index = list.findIndex((item) => nameKey(item) === key);
  if (index === -1) {
    list.push(name);
    return;
  }
  if (list[index].length < name.length) list[index] = name;
}

const LOOSE_NAME_RE = new RegExp(
  `^${NAME_TOKEN}(?:\\s+${NAME_TOKEN}){0,3}$`,
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
        LOOSE_NAME_RE.test(word) &&
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

function nonparticipantNames(lines: readonly TextLine[]) {
  const names: string[] = [];
  for (const line of lines) {
    const match = NONPARTICIPATION_RE.exec(line.trimmed);
    if (!match) continue;
    for (const name of parseCompletedList(match[1])) pushUnique(names, name);
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

function scanBodyMarkers(lines: readonly TextLine[], firstParagraphStart: number): OpinionBodyMarker[] {
  const markers: OpinionBodyMarker[] = [];
  const end = firstParagraphStart + MARKER_SCAN_WINDOW;
  for (const line of lines) {
    if (line.start >= end) break;
    const match = PAR_START_RE.exec(line.text);
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
  return analyzeOpinionStructureFromLines(args, offsetLines(args.text));
}

function analyzeOpinionStructureFromLines(
  args: { text: string; firstParagraphStart?: number },
  textLines: readonly TextLine[],
): OpinionStructure {
  const firstParagraphStart = Math.max(0, args.firstParagraphStart ?? 0);
  const headerBound =
    firstParagraphStart > 0 ? Math.min(firstParagraphStart, MAX_HEADER) : MAX_HEADER;
  const header = args.text.slice(0, headerBound);
  const lines: string[] = [];
  for (const line of textLines) {
    if (line.start >= headerBound) break;
    lines.push(line.end <= headerBound ? line.text : line.text.slice(0, headerBound - line.start));
  }
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
  const nonparticipants = nonparticipantNames(textLines);
  for (let index = panel.length - 1; index >= 0; index -= 1) {
    if (!nonparticipants.some((name) => nameKey(name) === nameKey(panel[index]))) continue;
    refusals.push(`nonparticipating judge excluded from deciding panel: ${panel[index]}`);
    panel.splice(index, 1);
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
    nonparticipants,
    bindings,
    bodyMarkers: scanBodyMarkers(
      textLines,
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
  const availableSet = new Set(available);
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
      if (!availableSet.has(number)) continue;
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
  const judgeKeys = new Set<string>();
  for (const binding of structure.bindings) {
    for (const name of [...binding.names, ...binding.concurred]) {
      const key = nameKey(name);
      if (!key || judgeKeys.has(key)) continue;
      judgeKeys.add(key);
      judges.push({ name, role: binding.role });
    }
  }
  return { status: "ready", judges, spans };
}

type TextLine = { start: number; end: number; text: string; trimmed: string };
type OpinionStart = {
  start: number;
  kind: "heading" | "paragraph_author" | "paragraph_fallback";
  authors: string[];
  alignment: OpinionAlignment | null;
  evidence: string;
};

export const MIN_OPINION_WORDS = 40;
const MIN_FALLBACK_OPINION_WORDS = 80;
const ANCHOR_WORDS = 12;

function offsetLines(text: string): TextLine[] {
  const lines: TextLine[] = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline < 0 ? text.length : newline + 1;
    const value = text.slice(start, end).replace(/\r?\n$/u, "");
    lines.push({ start, end, text: value, trimmed: value.trim() });
    start = end;
  }
  return lines;
}

function addNames(target: string[], names: string[]) {
  for (const name of names) pushUnique(target, name);
}

function headingRole(line: string): OpinionAlignment | null {
  if (/\b(?:dissenting|dissent)\b/iu.test(line)) return "different_result";
  if (/\b(?:concurring|concurrence)\b/iu.test(line)) {
    return "same_result_separate_reasons";
  }
  if (/\b(?:separate|additional)\s+reasons?\b/iu.test(line)) return "unknown";
  return null;
}

function headingAuthors(line: string) {
  const cleaned = line
    .replace(
      /^.*?\b(?:reasons?\s+(?:for\s+judg(?:e)?ment|for\s+decision|of\s+the\s+court)|judg(?:e)?ment|decision)\s+(?:of|by)\s*/iu,
      "",
    )
    .replace(/[:：]\s*$/u, "")
    .trim();
  return parseNames(cleaned);
}

function isOpinionHeading(line: string) {
  return /^(?:(?:written|oral|reserved)\s+)?(?:(?:joint|dissenting|concurring|separate|additional)\s+)?reasons?\s+(?:for\s+judg(?:e)?ment|for\s+decision|of\s+the\s+court|(?:of|by)\b)/iu.test(
    line,
  ) || /^(?:the\s+)?(?:judg(?:e)?ment|decision)\s+.*\bdelivered\s+(?:orally\s+)?by\b/iu.test(
    line,
  );
}

function paragraphAuthor(line: string) {
  const match = /^\s*\[\s*\d+\s*\]\s+(.{1,100}?)(?:\s*[:：]\s*|\s+[—–-]\s+)(.*)$/u.exec(
    line,
  );
  if (!match) return null;
  const head = match[1].trim();
  const authors = /^(?:the\s+court|by\s+the\s+court)$/iu.test(head)
    ? []
    : parseNames(head);
  if (!authors.length && !/^(?:the\s+court|by\s+the\s+court)$/iu.test(head)) {
    return null;
  }
  return { authors, head, body: match[2].trim() };
}

function agreementOnly(text: string) {
  return /^(?:I|we)\s+(?:agree|concur)(?:\s+(?:in|with)\s+(?:the\s+)?(?:result|reasons?(?:\s+of\s+.+)?))?[.!]?$/iu.test(
    text.trim(),
  );
}

function signatureNames(line: string) {
  const cleaned = line.replace(/^["'“”]+|["'“”]+$/gu, "").trim();
  if (!/^the\s+honourable\b/iu.test(cleaned)) return [];
  return parseNames(cleaned);
}

type SourceWordOffset = { start: number; end: number };

function sourceWordOffsets(text: string): SourceWordOffset[] {
  const offsets: SourceWordOffset[] = [];
  const pattern = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    offsets.push({ start: match.index, end: match.index + match[0].length });
  }
  return offsets;
}

function firstWordAtOrAfter(words: SourceWordOffset[], offset: number) {
  let low = 0;
  let high = words.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (words[middle].start < offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function sourceWordCount(words: SourceWordOffset[], start: number, end: number) {
  if (end <= start) return 0;
  return firstWordAtOrAfter(words, end) - firstWordAtOrAfter(words, start);
}

function quoteEdges(text: string, words: SourceWordOffset[], start: number, end: number) {
  const firstIndex = firstWordAtOrAfter(words, start);
  const endIndex = firstWordAtOrAfter(words, end);
  if (endIndex <= firstIndex) return { startQuote: "", endQuote: "" };
  const firstLast = words[Math.min(endIndex, firstIndex + ANCHOR_WORDS) - 1];
  const lastFirst = words[Math.max(firstIndex, endIndex - ANCHOR_WORDS)];
  return {
    startQuote: text.slice(start, firstLast.end).trimEnd(),
    endQuote: text.slice(lastFirst.start, end).trimStart(),
  };
}

function trimOpinionEnd(
  text: string,
  lines: TextLine[],
  words: SourceWordOffset[],
  start: number,
  provisionalEnd: number,
  minimumWords: number,
) {
  let end = provisionalEnd;
  const firstWord = firstWordAtOrAfter(words, start);
  const minimumWord = words[firstWord + minimumWords - 1];
  const minimumEnd = minimumWord?.end ?? provisionalEnd;
  for (const line of lines) {
    if (line.start <= start || line.start >= provisionalEnd) continue;
    if (line.start < minimumEnd) continue;
    const mayBeAgreement = /\b(?:agree|concur)/iu.test(line.trimmed);
    const paragraph = mayBeAgreement ? paragraphAuthor(line.text) : null;
    if (
      signatureNames(line.trimmed).length ||
      agreementOnly(line.trimmed) ||
      NONPARTICIPATION_RE.test(line.trimmed) ||
      TRAILING_CASE_METADATA_RE.test(line.trimmed) ||
      (paragraph && agreementOnly(paragraph.body))
    ) {
      end = line.start;
      break;
    }
  }
  while (end > start && /\s/u.test(text[end - 1])) end -= 1;
  return end;
}

function inferredAlignment(
  requested: OpinionAlignment | null,
  ordinal: number,
  body: string,
): OpinionAlignment {
  if (requested) return requested;
  if (ordinal === 0) return "lead";
  const prefix = body.slice(0, 2_000);
  if (/\b(?:unable\s+to\s+agree|respectfully\s+disagree|I\s+dissent|dissenting)\b/iu.test(prefix)) {
    return "different_result";
  }
  if (/\b(?:agree\s+in\s+the\s+result|agree.*\b(?:except|but)\b|concurring)\b/iu.test(prefix)) {
    return "same_result_separate_reasons";
  }
  return "unknown";
}

function resultForAlignment(alignment: OpinionAlignment): JudgeResultSide {
  if (alignment === "lead" || alignment === "same_result_separate_reasons") return "majority";
  if (alignment === "different_result") return "minority";
  return alignment === "mixed" ? "mixed" : "unknown";
}

function mergeResult(left: JudgeResultSide, right: JudgeResultSide): JudgeResultSide {
  if (left === "unknown") return right;
  if (right === "unknown" || left === right) return left;
  return "mixed";
}

function deriveVotes(
  text: string,
  lines: TextLine[],
  structure: OpinionStructure,
  opinions: TextOpinion[],
) {
  const votes = new Map<string, JudgeVote>();
  const add = (
    name: string,
    opinion: TextOpinion | undefined,
    relationship: JudgeOpinionRelationship,
    evidence: string,
  ) => {
    const key = nameKey(name);
    if (!key) return;
    const resultSide = opinion ? resultForAlignment(opinion.alignment) : "unknown";
    const existing = votes.get(key);
    if (!existing) {
      votes.set(key, {
        name,
        resultSide,
        relationship,
        opinionIds: opinion ? [opinion.id] : [],
        evidence: [evidence],
      });
      return;
    }
    existing.resultSide = mergeResult(existing.resultSide, resultSide);
    if (relationship === "authors") existing.relationship = "authors";
    else if (existing.relationship !== relationship && existing.relationship !== "authors") {
      existing.relationship = "mixed";
    }
    if (opinion && !existing.opinionIds.includes(opinion.id)) existing.opinionIds.push(opinion.id);
    if (!existing.evidence.includes(evidence)) existing.evidence.push(evidence);
  };

  for (const opinion of opinions) {
    for (const author of opinion.authors) add(author, opinion, "authors", opinion.evidence[0] ?? "opinion author");
  }

  let current: TextOpinion | undefined;
  let awaiting: { opinion: TextOpinion; relationship: JudgeOpinionRelationship; evidence: string } | null = null;
  const orderedOpinions = [...opinions].sort((left, right) => left.start - right.start);
  let nextOpinion = 0;
  for (const line of lines) {
    while (orderedOpinions[nextOpinion]?.start <= line.start) {
      current = orderedOpinions[nextOpinion];
      nextOpinion += 1;
    }
    const mayBeAgreement = /\b(?:agree|concur)/iu.test(line.trimmed);
    const paragraph = mayBeAgreement ? paragraphAuthor(line.text) : null;
    if (paragraph && agreementOnly(paragraph.body) && current) {
      const relationship = /\bin\s+the\s+result\b/iu.test(paragraph.body)
        ? "concurs_in_result_only"
        : "joins_reasons";
      for (const name of paragraph.authors) add(name, current, relationship, compact(line.trimmed));
      continue;
    }
    const bare = /^(?:I|we)\s+(agree|concur)(?:\s+in\s+the\s+result)?\s*[:.]?\s*(.*)$/iu.exec(line.trimmed);
    if (bare && agreementOnly(line.trimmed.replace(/:\s*.*$/u, "")) && current) {
      const relationship = /\bin\s+the\s+result\b/iu.test(line.trimmed)
        ? "concurs_in_result_only"
        : "joins_reasons";
      const inline = signatureNames(bare[2]);
      if (inline.length) {
        for (const name of inline) add(name, current, relationship, compact(line.trimmed));
      } else {
        awaiting = { opinion: current, relationship, evidence: compact(line.trimmed) };
      }
      continue;
    }
    const signatures = signatureNames(line.trimmed);
    if (awaiting && signatures.length) {
      for (const name of signatures) add(name, awaiting.opinion, awaiting.relationship, awaiting.evidence);
      awaiting = null;
    }
  }

  const lead = opinions.find((opinion) => opinion.alignment === "lead") ?? opinions[0];
  for (const binding of structure.bindings) {
    if (!/^concurred\s+in\s+by\b/iu.test(binding.line)) continue;
    for (const name of binding.names) add(name, lead, "joins_reasons", binding.line);
  }
  for (const binding of structure.bindings) {
    const opinion = opinions.find((candidate) =>
      candidate.authors.some((author) => binding.names.some((name) => nameKey(name) === nameKey(author))),
    );
    for (const name of binding.concurred) add(name, opinion ?? lead, "joins_reasons", binding.line);
  }

  if (opinions.length === 1 && lead && lead.alignment === "lead") {
    for (const name of structure.panel) {
      if (!votes.has(nameKey(name))) add(name, lead, "joins_reasons", "sole unopposed opinion");
    }
  } else {
    for (const name of structure.panel) {
      if (!votes.has(nameKey(name))) add(name, undefined, "unknown", "panel member; vote not resolved");
    }
  }
  return [...votes.values()];
}

/**
 * High-precision text-boundary and voting extraction. Paragraph blocks are an
 * optional oracle/input aid; the returned contract is always source offsets.
 */
type DeriveTextOpinionArgs = {
  text: string;
  paragraphs?: OffsetBlock[];
  firstParagraphStart?: number;
  minimumSubstantiveWords?: number;
  structure?: OpinionStructure;
};

export function analyzeTextOpinionStructure(
  args: Omit<DeriveTextOpinionArgs, "structure">,
): { structure: OpinionStructure; deterministic: TextOpinionStructure } {
  const paragraphs = args.paragraphs ?? [];
  const firstParagraphStart = args.firstParagraphStart ?? paragraphs[0]?.start ?? 0;
  const lines = offsetLines(args.text);
  const structure = analyzeOpinionStructureFromLines(
    { text: args.text, firstParagraphStart },
    lines,
  );
  return {
    structure,
    deterministic: deriveTextOpinionStructureFromLines(args, lines, structure),
  };
}

export function deriveTextOpinionStructure(args: DeriveTextOpinionArgs): TextOpinionStructure {
  const paragraphs = args.paragraphs ?? [];
  const firstParagraphStart = args.firstParagraphStart ?? paragraphs[0]?.start ?? 0;
  const lines = offsetLines(args.text);
  const structure = args.structure ?? analyzeOpinionStructureFromLines(
    { text: args.text, firstParagraphStart },
    lines,
  );
  return deriveTextOpinionStructureFromLines(args, lines, structure);
}

function deriveTextOpinionStructureFromLines(
  args: DeriveTextOpinionArgs,
  lines: TextLine[],
  structure: OpinionStructure,
): TextOpinionStructure {
  const minimumWords = Math.max(1, args.minimumSubstantiveWords ?? MIN_OPINION_WORDS);
  const paragraphs = args.paragraphs ?? [];
  let wordOffsets: SourceWordOffset[] | null = null;
  const words = () => wordOffsets ??= sourceWordOffsets(args.text);
  const refusals = [...structure.refusals];
  const starts: OpinionStart[] = [];

  const ranged = structure.bindings.filter(
    (binding) => binding.from !== null && binding.to !== null && binding.role !== "unknown",
  );
  const rangedKeys = new Set<string>();
  const rangedOpinions: TextOpinion[] = [];
  for (const binding of ranged) {
    const key = `${binding.role}|${binding.from}|${binding.to}`;
    if (rangedKeys.has(key)) continue;
    rangedKeys.add(key);
    const first = paragraphs.find((block) => block.label.toLowerCase() === `par${binding.from}`);
    const last = paragraphs.find((block) => block.label.toLowerCase() === `par${binding.to}`);
    if (!first || !last || last.end <= first.start) continue;
    const wordIndex = words();
    const end = trimOpinionEnd(args.text, lines, wordIndex, first.start, last.end, Math.min(12, minimumWords));
    const substantiveWords = sourceWordCount(wordIndex, first.start, end);
    if (substantiveWords < Math.min(12, minimumWords)) {
      refusals.push(`explicit range ${binding.from}-${binding.to} has only ${substantiveWords} substantive words`);
      continue;
    }
    const alignment: OpinionAlignment = binding.role === "majority"
      ? "lead"
      : binding.role === "minority"
        ? "different_result"
        : binding.role === "concurring"
          ? "same_result_separate_reasons"
          : "unknown";
    rangedOpinions.push({
      id: `o${rangedOpinions.length + 1}`,
      authors: [...binding.names],
      alignment,
      start: first.start,
      end,
      ...quoteEdges(args.text, wordIndex, first.start, end),
      substantiveWords,
      evidence: [binding.line],
    });
  }

  let opinions = rangedOpinions;
  if (!opinions.length) {
    const agreementAuthors = new Set<string>();
    for (const line of lines) {
      if (isOpinionHeading(line.trimmed)) {
        const authors = headingAuthors(line.trimmed);
        // BCCA front matter commonly contains bare labels such as "Written
        // Reasons by:" or "Oral Reasons for Judgment" before the real,
        // author-bearing body heading.  They are metadata, not opinions.
        if (!authors.length && !/\breasons?\s+of\s+the\s+court\b|\bby\s+the\s+court\b/iu.test(line.trimmed)) {
          continue;
        }
        starts.push({
          start: line.start,
          kind: "heading",
          authors,
          alignment: headingRole(line.trimmed),
          evidence: compact(line.trimmed),
        });
        continue;
      }
      const paragraph = paragraphAuthor(line.text);
      if (!paragraph) continue;
      if (agreementOnly(paragraph.body)) {
        for (const author of paragraph.authors) agreementAuthors.add(nameKey(author));
        continue;
      }
      const remainingWords = sourceWordCount(words(), line.start, args.text.length);
      if (
        paragraph.authors.some((author) => agreementAuthors.has(nameKey(author))) &&
        remainingWords < 120
      ) {
        refusals.push(`terminal disposition by a judge who already joined the reasons: ${compact(paragraph.head)}`);
        continue;
      }
      starts.push({
        start: line.start,
        kind: "paragraph_author",
        authors: paragraph.authors.length ? paragraph.authors : [...structure.panel],
        alignment: headingRole(paragraph.head),
        evidence: compact(paragraph.head),
      });
    }

    starts.sort((left, right) => left.start - right.start);
    const merged: OpinionStart[] = [];
    for (const candidate of starts) {
      const previous = merged.at(-1);
      if (previous) {
        const betweenWords = sourceWordCount(words(), previous.start, candidate.start);
        const sameAuthors = !previous.authors.length || !candidate.authors.length || previous.authors.some(
          (left) => candidate.authors.some((right) => nameKey(left) === nameKey(right)),
        );
        if (candidate.start - previous.start < 2_000 && betweenWords < 24 && sameAuthors) {
          addNames(previous.authors, candidate.authors);
          previous.alignment = candidate.alignment ?? previous.alignment;
          previous.evidence = `${previous.evidence} | ${candidate.evidence}`;
          if (previous.kind === "heading" && candidate.kind === "heading") previous.start = candidate.start;
          continue;
        }
      }
      merged.push({ ...candidate, authors: [...candidate.authors] });
    }

    if (!merged.length && paragraphs.length) {
      const authors = structure.bindings.find((binding) => binding.names.length)?.names
        ?? (structure.panel.length === 1 ? structure.panel : []);
      if (authors.length) {
        merged.push({
          start: paragraphs[0].start,
          kind: "paragraph_fallback",
          authors: [...authors],
          alignment: "lead",
          evidence: "first source paragraph after sole author attribution",
        });
      }
    }

    opinions = merged.flatMap((candidate, ordinal) => {
      const provisionalEnd = merged[ordinal + 1]?.start ?? args.text.length;
      const candidateMinimum = candidate.kind === "paragraph_fallback"
        ? Math.max(minimumWords, MIN_FALLBACK_OPINION_WORDS)
        : minimumWords;
      const wordIndex = words();
      const end = trimOpinionEnd(args.text, lines, wordIndex, candidate.start, provisionalEnd, minimumWords);
      const substantiveWords = sourceWordCount(wordIndex, candidate.start, end);
      if (substantiveWords < candidateMinimum) {
        refusals.push(`candidate at offset ${candidate.start} has only ${substantiveWords} substantive words`);
        return [];
      }
      const alignment = inferredAlignment(candidate.alignment, ordinal, args.text.slice(candidate.start, end));
      return [{
        id: `o${ordinal + 1}`,
        authors: candidate.authors,
        alignment,
        start: candidate.start,
        end,
        ...quoteEdges(args.text, wordIndex, candidate.start, end),
        substantiveWords,
        evidence: [candidate.evidence],
      } satisfies TextOpinion];
    });
    opinions.forEach((opinion, index) => { opinion.id = `o${index + 1}`; });
  }

  const judges = deriveVotes(args.text, lines, structure, opinions);
  const status: TextOpinionStructure["status"] = !opinions.length
    ? "unavailable"
    : opinions.some((opinion) => !opinion.authors.length || opinion.alignment === "unknown") ||
        judges.some((judge) => judge.resultSide === "unknown")
      ? "unresolved"
      : "ready";
  if (!opinions.length) refusals.push("no substantive opinion block found");
  return {
    status,
    panel: structure.panel,
    nonparticipants: structure.nonparticipants,
    opinions,
    judges,
    refusals,
  };
}
