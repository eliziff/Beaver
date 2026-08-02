import { createHash } from "node:crypto";
import type { NormalizedToolResult } from "../llm/types";

type Range = { start: number; end: number };
type EvidenceKind = "candidate" | "evidence";

type StoredRange = Range & {
  documentId: string;
  versionId: string;
  filename: string;
  locator?: string;
  projection: string;
  kind: EvidenceKind;
};

type StoredRef = {
  handle: string;
  text: string;
  filename: string;
  locator?: string;
  exactSha256: string;
  kind: EvidenceKind;
};

export type EvidenceSourceLoader = (
  documentId: string,
  versionId: string,
) => Promise<{ filename: string; text: string } | null>;

export type EvidenceExposureState = {
  covered: Map<string, Range[]>;
  ranges: StoredRange[];
  refs: Map<string, StoredRef>;
  uniqueSourceChars: number;
  suppressedSourceChars: number;
};

export type EvidenceManifestItem = {
  alias: string;
  filename: string;
  locator: string;
  chars: number;
  preview: string;
};

/** Compact, deterministic selection surface; groups rows to avoid repeating filenames. */
export function renderEvidenceManifest(
  manifest: readonly EvidenceManifestItem[],
): string {
  const cell = (value: string) => value.replace(/[\t\r\n]+/gu, " ").trim();
  const groups = new Map<string, EvidenceManifestItem[]>();
  for (const item of manifest) {
    const rows = groups.get(item.filename) ?? [];
    rows.push(item);
    groups.set(item.filename, rows);
  }
  return [...groups].flatMap(([filename, items], index) => [
    ...(index ? [""] : []),
    `file\t${cell(filename)}`,
    "alias\tlocator\tchars\tpreview",
    ...items.map((item) =>
      [
        item.alias,
        cell(item.locator),
        String(item.chars),
        cell(item.preview),
      ].join("\t"),
    ),
  ]).join("\n");
}

export type EvidenceHandoff =
  | {
      status: "ready";
      prompt: string;
      manifest: EvidenceManifestItem[];
      sourceChars: number;
    }
  | {
      status: "selection_required" | "error";
      manifest: EvidenceManifestItem[];
      sourceChars: number;
      message: string;
    };

export type EvidenceResearchRefresh = {
  prompt: string;
  manifest: EvidenceManifestItem[];
  sourceChars: number;
  latestResultChars: number;
};

export function createEvidenceExposureState(): EvidenceExposureState {
  return {
    covered: new Map(),
    ranges: [],
    refs: new Map(),
    uniqueSourceChars: 0,
    suppressedSourceChars: 0,
  };
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function mergeRange(ranges: Range[], added: Range) {
  const ordered = [...ranges, added].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const merged: Range[] = [];
  for (const range of ordered) {
    const prior = merged.at(-1);
    if (!prior || range.start > prior.end) merged.push({ ...range });
    else prior.end = Math.max(prior.end, range.end);
  }
  ranges.splice(0, ranges.length, ...merged);
}

function uncovered(range: Range, covered: readonly Range[]) {
  const open: Range[] = [];
  let cursor = range.start;
  for (const prior of covered) {
    if (prior.end <= cursor) continue;
    if (prior.start >= range.end) break;
    if (prior.start > cursor) {
      open.push({ start: cursor, end: Math.min(prior.start, range.end) });
    }
    cursor = Math.max(cursor, prior.end);
    if (cursor >= range.end) break;
  }
  if (cursor < range.end) open.push({ start: cursor, end: range.end });
  return open;
}

function compactLocator(start: number, end: number, locator?: string) {
  return locator?.trim() || `chars ${start}-${end}`;
}

/**
 * Make one tool turn accretive. Candidate previews and evidence reads have
 * separate unions, so a Grep hit never suppresses the later Read that proves
 * it. If exact source rehydration fails, the original result passes through.
 */
export async function applyEvidenceExposure(
  state: EvidenceExposureState,
  original: NormalizedToolResult,
  load: EvidenceSourceLoader,
): Promise<NormalizedToolResult> {
  const pieces: Array<{
    filename: string;
    locator: string;
    text: string;
  }> = [];
  const unseenSegments: NonNullable<NormalizedToolResult["evidenceSegments"]> = [];
  const unseenRefs: NonNullable<NormalizedToolResult["evidenceRefs"]> = [];
  let unique = 0;
  let suppressed = 0;
  let observed = 0;
  let safeToRewrite = true;
  const sourceCache = new Map<string, Awaited<ReturnType<EvidenceSourceLoader>>>();

  for (const segment of original.evidenceSegments ?? []) {
    const sourceKey = `${segment.documentId}:${segment.versionId}`;
    let source = sourceCache.get(sourceKey);
    if (source === undefined) {
      source = await load(segment.documentId, segment.versionId);
      sourceCache.set(sourceKey, source);
    }
    if (
      !source ||
      !Number.isInteger(segment.start) ||
      !Number.isInteger(segment.end) ||
      segment.start < 0 ||
      segment.end <= segment.start ||
      segment.end > source.text.length
    ) {
      safeToRewrite = false;
      continue;
    }
    const kind = segment.kind ?? "evidence";
    const projection = segment.projection?.trim() || "canonical";
    const coverageKey = `${sourceKey}:${projection}:${kind}`;
    const covered = state.covered.get(coverageKey) ?? [];
    const open = uncovered(segment, covered);
    const width = segment.end - segment.start;
    const added = open.reduce((total, range) => total + range.end - range.start, 0);
    observed += width;
    unique += added;
    suppressed += width - added;
    for (const range of open) {
      const stored: StoredRange = {
        ...range,
        documentId: segment.documentId,
        versionId: segment.versionId,
        filename: segment.filename?.trim() || source.filename,
        ...(segment.locator ? { locator: segment.locator } : {}),
        projection,
        kind,
      };
      state.ranges.push(stored);
      unseenSegments.push({ ...segment, start: range.start, end: range.end });
      pieces.push({
        filename: stored.filename,
        locator: compactLocator(range.start, range.end, stored.locator),
        text: source.text.slice(range.start, range.end),
      });
    }
    mergeRange(covered, segment);
    state.covered.set(coverageKey, covered);
  }

  for (const ref of original.evidenceRefs ?? []) {
    if (!ref.text) continue;
    const kind = ref.kind ?? "evidence";
    const exactSha256 = ref.exactSha256?.trim() || sha256(ref.text);
    const key = `${ref.handle}:${exactSha256}:${kind}`;
    observed += ref.text.length;
    if (state.refs.has(key)) {
      suppressed += ref.text.length;
      continue;
    }
    const stored: StoredRef = {
      handle: ref.handle,
      text: ref.text,
      filename: ref.filename?.trim() || ref.handle,
      ...(ref.locator ? { locator: ref.locator } : {}),
      exactSha256,
      kind,
    };
    state.refs.set(key, stored);
    unseenRefs.push(ref);
    unique += ref.text.length;
    pieces.push({
      filename: stored.filename,
      locator: stored.locator ?? stored.handle,
      text: stored.text,
    });
  }

  if (!observed) return original;
  state.uniqueSourceChars += unique;
  state.suppressedSourceChars += suppressed;
  const exposure = {
    uniqueSourceChars: unique,
    suppressedSourceChars: suppressed,
  };
  if (!safeToRewrite) return { ...original, exposure };
  if (unique === 0) {
    return {
      ...original,
      status: "already_exposed",
      content: JSON.stringify({
        ok: true,
        status: "already_exposed",
        already_exposed: true,
        unique_source_chars: 0,
        suppressed_source_chars: suppressed,
      }),
      evidenceSegments: [],
      evidenceRefs: [],
      exposure,
    };
  }
  if (!suppressed) {
    return {
      ...original,
      evidenceSegments: unseenSegments,
      evidenceRefs: unseenRefs,
      exposure,
    };
  }
  return {
    ...original,
    status: "ok",
    content: JSON.stringify({
      ok: true,
      status: "ok",
      new_evidence: pieces.map((piece) => ({
        source: piece.filename,
        locator: piece.locator,
        text: piece.text,
      })),
      unique_source_chars: unique,
      suppressed_source_chars: suppressed,
    }),
    evidenceSegments: unseenSegments,
    evidenceRefs: unseenRefs,
    exposure,
  };
}

type HandoffItem = EvidenceManifestItem & { text: string; key: string };

async function handoffItems(
  state: EvidenceExposureState,
  load: EvidenceSourceLoader,
): Promise<HandoffItem[]> {
  const evidenceCoverage = new Map<string, Range[]>();
  const sourceKey = (range: StoredRange) =>
    [range.documentId, range.versionId, range.projection].join(":");
  for (const range of state.ranges.filter((item) => item.kind === "evidence")) {
    const key = sourceKey(range);
    const covered = evidenceCoverage.get(key) ?? [];
    mergeRange(covered, range);
    evidenceCoverage.set(key, covered);
  }
  const handoffRanges = state.ranges.flatMap((range) => {
    if (range.kind === "evidence") return [range];
    return uncovered(range, evidenceCoverage.get(sourceKey(range)) ?? []).map(
      (open) => ({ ...range, ...open }),
    );
  });
  const grouped = new Map<string, StoredRange[]>();
  for (const range of handoffRanges) {
    const key = [
      range.documentId,
      range.versionId,
      range.projection,
      range.filename,
      range.locator ?? "",
    ].join(":");
    const group = grouped.get(key) ?? [];
    group.push(range);
    grouped.set(key, group);
  }
  const items: HandoffItem[] = [];
  for (const [key, ranges] of grouped) {
    const first = ranges[0];
    const source = await load(first.documentId, first.versionId);
    if (!source) continue;
    const merged: Range[] = [];
    for (const range of [...ranges].sort((left, right) => left.start - right.start)) {
      const prior = merged.at(-1);
      const gap = prior ? source.text.slice(prior.end, range.start) : "";
      // Coding reads expose one source line per rendered row. Rejoin only the
      // exact newline bytes between adjacent rows; otherwise a 200-line Read
      // would become 200 evidence objects and spend more boundary text than
      // source text at handoff.
      if (prior && range.start >= prior.end && /^(?:\r?\n)+$/u.test(gap)) {
        prior.end = Math.max(prior.end, range.end);
      } else {
        mergeRange(merged, range);
      }
    }
    const excerpts = merged.flatMap((range) =>
      range.start < 0 || range.end > source.text.length
        ? []
        : [
            {
              start: range.start,
              end: range.end,
              text: source.text.slice(range.start, range.end),
            },
          ],
    );
    if (!excerpts.length) continue;
    const identity = `${key}:${excerpts
      .map((excerpt) => `${excerpt.start}-${excerpt.end}`)
      .join(",")}`;
    const text =
      excerpts.length === 1
        ? excerpts[0].text
        : excerpts
            .map(
              (excerpt, index) =>
                `--- exact excerpt ${index + 1} ---\n${excerpt.text}`,
            )
            .join("\n\n");
    items.push({
      key: identity,
      alias: `E-${sha256(identity).slice(0, 8)}`,
      filename: first.filename || source.filename,
      locator:
        first.locator?.trim() ||
        (excerpts.length === 1 ? "document excerpt" : `${excerpts.length} exact excerpts`),
      chars: excerpts.reduce((total, excerpt) => total + excerpt.text.length, 0),
      preview: excerpts[0].text.replace(/\s+/gu, " ").trim().slice(0, 96),
      text,
    });
  }
  for (const ref of state.refs.values()) {
    if (ref.kind !== "evidence") continue;
    const key = `ref:${ref.handle}:${ref.exactSha256}`;
    items.push({
      key,
      alias: `E-${sha256(key).slice(0, 8)}`,
      filename: ref.filename,
      locator: ref.locator ?? ref.handle,
      chars: ref.text.length,
      preview: ref.text.replace(/\s+/gu, " ").trim().slice(0, 96),
      text: ref.text,
    });
  }
  return items.sort(
    (left, right) =>
      left.filename.localeCompare(right.filename) ||
      left.locator.localeCompare(right.locator) ||
      left.alias.localeCompare(right.alias),
  );
}

export async function compileEvidenceResearchRefresh(args: {
  state: EvidenceExposureState;
  load: EvidenceSourceLoader;
  originalRequest: string;
  latestResults: Array<{ name: string; content: string }>;
}): Promise<EvidenceResearchRefresh> {
  const items = await handoffItems(args.state, args.load);
  const manifest = items.map(({ alias, filename, locator, chars, preview }) => ({
    alias,
    filename,
    locator,
    chars,
    preview,
  }));
  const latestResultChars = args.latestResults.reduce(
    (total, result) => total + result.content.length,
    0,
  );
  return {
    manifest,
    sourceChars: items.reduce((total, item) => total + item.chars, 0),
    latestResultChars,
    prompt: [
      "Continue the original task in this fresh research context.",
      "Earlier tool transcript was discarded. Exact evidence already gathered remains durable and will be restored in full for drafting. The compact index below is orientation only; use an available search or read tool to inspect a passage again.",
      "ORIGINAL REQUEST",
      args.originalRequest.trim(),
      "DURABLE EVIDENCE INDEX",
      renderEvidenceManifest(manifest) || "(No durable evidence yet.)",
      "LATEST TOOL RESULTS",
      args.latestResults
        .map(
          (result, index) =>
            `=== ${index + 1}. ${result.name} ===\n${result.content}`,
        )
        .join("\n\n"),
    ].join("\n\n"),
  };
}

export async function compileEvidenceHandoff(args: {
  state: EvidenceExposureState;
  load: EvidenceSourceLoader;
  originalRequest: string;
  maxChars: number;
  carryEvidence?: string[];
  domainGuidance?: string;
}): Promise<EvidenceHandoff> {
  const all = await handoffItems(args.state, args.load);
  const manifest = all.map(({ alias, filename, locator, chars, preview }) => ({
    alias,
    filename,
    locator,
    chars,
    preview,
  }));
  const requested = new Set(
    (args.carryEvidence ?? []).map((alias) => alias.trim()).filter(Boolean),
  );
  const unknown = [...requested].filter(
    (alias) => !all.some((item) => item.alias === alias),
  );
  if (unknown.length) {
    return {
      status: "error",
      // The immediately preceding selection_required result already carried
      // the manifest. Replaying a large manifest on a typo both pollutes the
      // context and makes the model pay to rediscover the same aliases.
      manifest: [],
      sourceChars: 0,
      message:
        `Unknown evidence aliases: ${unknown.join(", ")}. ` +
        "Use exact aliases from the prior manifest; wildcards and placeholders are not accepted. " +
        "Omit carry_evidence to show the manifest again.",
    };
  }
  const selected = requested.size
    ? all.filter((item) => requested.has(item.alias))
    : all;
  const selectedManifest = selected.map(
    ({ alias, filename, locator, chars, preview }) => ({
      alias,
      filename,
      locator,
      chars,
      preview,
    }),
  );
  const sourceChars = selected.reduce((total, item) => total + item.chars, 0);
  if (sourceChars > args.maxChars) {
    return {
      status: "selection_required",
      // Once the caller has selected a known subset, show only that subset
      // when it remains too large. The full manifest is already in context.
      manifest: requested.size ? selectedManifest : manifest,
      sourceChars,
      message:
        `The exact evidence union is ${sourceChars.toLocaleString("en-CA")} characters; ` +
        `the handoff cap is ${args.maxChars.toLocaleString("en-CA")}. Call describe_tools again ` +
        "with carry_evidence set to the aliases needed for the deliverable.",
    };
  }
  const evidence = selected.length
    ? selected
        .map(
          (item) =>
            `=== ${item.alias} | ${item.filename} | ${item.locator} ===\n${item.text}`,
        )
        .join("\n\n")
    : "(No source passage was committed during research.)";
  return {
    status: "ready",
    manifest: selectedManifest,
    sourceChars,
    prompt: [
      "Complete the requested deliverable in this fresh drafting context.",
      "Use the exact evidence below as source material. Do not assume omitted research or tool output.",
      "The tool domain that triggered this handoff is already loaded. Use it directly; discovery is closed in this drafting context.",
      args.domainGuidance?.trim() || "",
      "ORIGINAL REQUEST",
      args.originalRequest.trim(),
      "EXACT EVIDENCE UNION",
      evidence,
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}
