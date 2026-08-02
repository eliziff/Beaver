import { createHash } from "node:crypto";
import type { NormalizedToolResult } from "../llm/types";

type Range = { start: number; end: number };
type EvidenceKind = "candidate" | "evidence";

// Initial research is deliberately bounded. If drafting later exposes a
// concrete gap, the existing draft -> targeted research -> checkpoint ->
// redraft path remains available and preserves the newly gathered evidence.
export const INITIAL_RESEARCH_CHECKPOINT_MAX_COUNT = 3;

export function continueInitialResearch(
  requested: boolean,
  checkpointNumber: number,
) {
  return (
    requested && checkpointNumber < INITIAL_RESEARCH_CHECKPOINT_MAX_COUNT
  );
}

type StoredRange = Range & {
  documentId: string;
  versionId: string;
  filename: string;
  locator?: string;
  projection: string;
  kind: EvidenceKind;
  sequence: number;
};

type StoredRef = {
  handle: string;
  text: string;
  filename: string;
  locator?: string;
  exactSha256: string;
  kind: EvidenceKind;
  sequence: number;
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
  nextSequence: number;
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
  promptChars: number;
  evidenceMapChars: number;
  orientationChars: number;
  briefChars: number;
};

export type EvidenceResearchCheckpoint = {
  prompt: string;
  sourceChars: number;
  evidenceItems: number;
  latestResultChars: number;
  promptChars: number;
  evidenceMapChars: number;
  orientationChars: number;
  priorBriefChars: number;
};

export type EvidenceVirtualWorkingSet = {
  path: string;
  text: string;
  sourceChars: number;
  matchedSourceChars: number;
  immutableSourceChars: number;
  mapChars: number;
  budgetChars: number;
  mappedVersions: string[];
  segments: Array<{
    virtualStart: number;
    virtualEnd: number;
    documentId: string;
    versionId: string;
    sourceStart: number;
    sourceEnd: number;
    projection?: string;
    durableUnionBacked: true;
  }>;
  refs: Array<{
    virtualStart: number;
    virtualEnd: number;
    handle: string;
    filename: string;
    locator?: string;
    exactSha256: string;
    durableUnionBacked: true;
  }>;
  demandPaged: true;
  readGrants: Set<string>;
};

export type EvidencePagedHandoff = {
  prompt: string;
  manifest: EvidenceManifestItem[];
  sourceChars: number;
  hotSourceChars: number;
  hotPacketChars: number;
  hotItems: Array<{
    filename: string;
    locator: string;
    chars: number;
    exactSha256: string;
  }>;
  evidenceMapChars: number;
  orientationChars: number;
  workingSet: EvidenceVirtualWorkingSet;
};

export function createEvidenceExposureState(): EvidenceExposureState {
  return {
    covered: new Map(),
    ranges: [],
    refs: new Map(),
    uniqueSourceChars: 0,
    suppressedSourceChars: 0,
    nextSequence: 0,
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

type ReviewedEvidenceWorkingSet = {
  text: string;
  segments: ReadonlyArray<{
    documentId: string;
    versionId: string;
    sourceStart: number;
    sourceEnd: number;
    projection?: string;
  }>;
  refs?: ReadonlyArray<{
    virtualStart: number;
    virtualEnd: number;
    handle: string;
  }>;
};

const projectionKey = (projection?: string) =>
  projection?.trim() || "canonical";

const refBaseHandle = (handle: string) =>
  handle.replace(/#chars=\d+-\d+$/u, "");

/**
 * Mark exact direct-source rereads that are wholly represented by the
 * reviewed mounted union. The durable union can then ignore the reread while
 * the fresh drafting-context guard still delivers it. A partial range, a new
 * projection, or a different provider handle remains new research evidence.
 */
export function markReviewedUnionEvidence(
  original: NormalizedToolResult,
  workingSet: ReviewedEvidenceWorkingSet,
): NormalizedToolResult {
  const coveredBySource = new Map<string, Range[]>();
  for (const segment of workingSet.segments) {
    if (
      !Number.isInteger(segment.sourceStart) ||
      !Number.isInteger(segment.sourceEnd) ||
      segment.sourceStart < 0 ||
      segment.sourceEnd <= segment.sourceStart
    ) {
      continue;
    }
    const key = [
      segment.documentId,
      segment.versionId,
      projectionKey(segment.projection),
    ].join("\u0000");
    const covered = coveredBySource.get(key) ?? [];
    mergeRange(covered, {
      start: segment.sourceStart,
      end: segment.sourceEnd,
    });
    coveredBySource.set(key, covered);
  }

  const refTextsByHandle = new Map<string, string[]>();
  for (const ref of workingSet.refs ?? []) {
    if (
      !Number.isInteger(ref.virtualStart) ||
      !Number.isInteger(ref.virtualEnd) ||
      ref.virtualStart < 0 ||
      ref.virtualEnd <= ref.virtualStart ||
      ref.virtualEnd > workingSet.text.length
    ) {
      continue;
    }
    const text = workingSet.text.slice(ref.virtualStart, ref.virtualEnd);
    for (const handle of new Set([ref.handle, refBaseHandle(ref.handle)])) {
      const values = refTextsByHandle.get(handle) ?? [];
      values.push(text);
      refTextsByHandle.set(handle, values);
    }
  }

  let reusedSourceChars = 0;
  let changed = false;
  const evidenceSegments = original.evidenceSegments?.map((segment) => {
    if (
      segment.durableUnionBacked ||
      !Number.isInteger(segment.start) ||
      !Number.isInteger(segment.end) ||
      segment.start < 0 ||
      segment.end <= segment.start
    ) {
      return segment;
    }
    const key = [
      segment.documentId,
      segment.versionId,
      projectionKey(segment.projection),
    ].join("\u0000");
    const covered = coveredBySource.get(key) ?? [];
    if (uncovered(segment, covered).length) return segment;
    changed = true;
    reusedSourceChars += segment.end - segment.start;
    return { ...segment, durableUnionBacked: true as const };
  });
  const evidenceRefs = original.evidenceRefs?.map((ref) => {
    if (ref.durableUnionBacked || !ref.text) return ref;
    const handles = new Set([ref.handle, refBaseHandle(ref.handle)]);
    const covered = [...handles].some((handle) =>
      (refTextsByHandle.get(handle) ?? []).some((text) =>
        text.includes(ref.text),
      ),
    );
    if (!covered) return ref;
    changed = true;
    reusedSourceChars += ref.text.length;
    return { ...ref, durableUnionBacked: true as const };
  });

  if (!changed) return original;
  return {
    ...original,
    ...(evidenceSegments && { evidenceSegments }),
    ...(evidenceRefs && { evidenceRefs }),
    reviewedUnionBackedSourceChars:
      (original.reviewedUnionBackedSourceChars ?? 0) + reusedSourceChars,
  };
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
  options?: { skipDurableUnionBacked?: boolean },
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
  let durableUnionBackedObserved = false;
  const sourceCache = new Map<string, Awaited<ReturnType<EvidenceSourceLoader>>>();

  for (const segment of original.evidenceSegments ?? []) {
    if (segment.durableUnionBacked) durableUnionBackedObserved = true;
    if (options?.skipDurableUnionBacked && segment.durableUnionBacked) {
      const width = Math.max(0, segment.end - segment.start);
      observed += width;
      suppressed += width;
      continue;
    }
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
        sequence: state.nextSequence++,
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
    if (ref.durableUnionBacked) durableUnionBackedObserved = true;
    if (options?.skipDurableUnionBacked && ref.durableUnionBacked) {
      observed += ref.text.length;
      suppressed += ref.text.length;
      continue;
    }
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
      sequence: state.nextSequence++,
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
  // The virtual working set already bounded the exact page. If that page
  // contains any fresh mounted evidence, preserve its cat/rg grammar rather
  // than JSON-escaping the unseen pieces: escaping can grow a 24k page beyond
  // its transport cap, and the fresh-context reader must actually see it.
  // A fully repeated page still takes the already_exposed path above.
  if (durableUnionBackedObserved) {
    return {
      ...original,
      evidenceSegments: unseenSegments,
      evidenceRefs: unseenRefs,
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

type HandoffExcerpt = {
  text: string;
  documentId?: string;
  versionId?: string;
  start?: number;
  end?: number;
  projection?: string;
  ref?: {
    handle: string;
    filename: string;
    locator?: string;
    exactSha256: string;
  };
};

type HandoffItem = EvidenceManifestItem & {
  text: string;
  key: string;
  sequence: number;
  excerpts: HandoffExcerpt[];
};

function renderHandoffExcerpts(excerpts: readonly HandoffExcerpt[]) {
  return excerpts.length === 1
    ? excerpts[0].text
    : excerpts
        .map(
          (excerpt, index) =>
            `--- exact excerpt ${index + 1} ---\n${excerpt.text}`,
        )
        .join("\n\n");
}

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
    const excerpts: HandoffExcerpt[] = merged.flatMap((range) =>
      range.start < 0 || range.end > source.text.length
        ? []
        : [
            {
              start: range.start,
              end: range.end,
              text: source.text.slice(range.start, range.end),
              documentId: first.documentId,
              versionId: first.versionId,
              projection: first.projection,
            },
          ],
    );
    if (!excerpts.length) continue;
    const identity = `${key}:${excerpts
      .map((excerpt) => `${excerpt.start}-${excerpt.end}`)
      .join(",")}`;
    const text = renderHandoffExcerpts(excerpts);
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
      sequence: Math.max(...ranges.map((range) => range.sequence)),
      excerpts,
    });
  }
  const provenRefs = new Set(
    [...state.refs.values()]
      .filter((ref) => ref.kind === "evidence")
      .map((ref) => `${ref.handle}:${ref.exactSha256}`),
  );
  for (const ref of state.refs.values()) {
    if (
      ref.kind === "candidate" &&
      provenRefs.has(`${ref.handle}:${ref.exactSha256}`)
    ) {
      continue;
    }
    const key = `ref:${ref.handle}:${ref.exactSha256}`;
    items.push({
      key,
      alias: `E-${sha256(key).slice(0, 8)}`,
      filename: ref.filename,
      locator: ref.locator ?? ref.handle,
      chars: ref.text.length,
      preview: ref.text.replace(/\s+/gu, " ").trim().slice(0, 96),
      text: ref.text,
      sequence: ref.sequence,
      excerpts: [
        {
          text: ref.text,
          ref: {
            handle: ref.handle,
            filename: ref.filename,
            ...(ref.locator ? { locator: ref.locator } : {}),
            exactSha256: ref.exactSha256,
          },
        },
      ],
    });
  }
  return items.sort(
    (left, right) =>
      left.filename.localeCompare(right.filename) ||
      left.locator.localeCompare(right.locator) ||
      left.alias.localeCompare(right.alias),
  );
}

function renderEvidenceMap(items: readonly HandoffItem[], maxChars = 12_000) {
  const cell = (value: string, limit = 240) =>
    value.replace(/[\t\r\n]+/gu, " ").trim().slice(0, limit);
  const files = new Map<
    string,
    { items: number; chars: number; locators: string[] }
  >();
  for (const item of items) {
    const prior = files.get(item.filename) ?? {
      items: 0,
      chars: 0,
      locators: [],
    };
    prior.items += 1;
    prior.chars += item.chars;
    if (
      item.locator &&
      !prior.locators.includes(item.locator) &&
      prior.locators.length < 3
    ) {
      prior.locators.push(item.locator);
    }
    files.set(item.filename, prior);
  }
  if (!files.size) return "(No durable evidence yet.)";
  const rows = [...files]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([filename, summary]) =>
      [
        cell(filename),
        String(summary.items),
        String(summary.chars),
        cell(summary.locators.join(" | "), 360),
      ].join("\t"),
    );
  const totalItems = items.length;
  const totalChars = items.reduce((total, item) => total + item.chars, 0);
  const lines = [
    `TOTAL\tfiles=${files.size}\titems=${totalItems}\tchars=${totalChars}`,
    "file\titems\tchars\tlocators",
  ];
  let rendered = lines.join("\n");
  let kept = 0;
  for (const row of rows) {
    const omission = `\n… ${rows.length - kept - 1} files omitted from this compact map; use the mounted exact union.`;
    if (rendered.length + row.length + 1 + omission.length > maxChars) break;
    rendered += `\n${row}`;
    kept += 1;
  }
  if (kept < rows.length) {
    rendered += `\n… ${rows.length - kept} files omitted from this compact map; use the mounted exact union.`;
  }
  return rendered.slice(0, maxChars);
}

function renderNamedResults(
  results: readonly { name: string; content: string }[],
) {
  return results
    .map(
      (result, index) =>
        `=== ${index + 1}. ${result.name} ===\n${result.content}`,
    )
    .join("\n\n");
}

export async function compileEvidenceResearchCheckpoint(args: {
  state: EvidenceExposureState;
  load: EvidenceSourceLoader;
  originalRequest: string;
  priorBrief: string;
  orientation: Array<{ name: string; content: string }>;
  latestResults: Array<{ name: string; content: string }>;
  maxBriefChars: number;
  forceComplete?: boolean;
}): Promise<EvidenceResearchCheckpoint> {
  const items = await handoffItems(args.state, args.load);
  const evidenceMap = renderEvidenceMap(items);
  const orientation = args.orientation.length
    ? renderNamedResults(args.orientation)
    : "";
  const latestResultChars = args.latestResults.reduce(
    (total, result) => total + result.content.length,
    0,
  );
  const prompt = [
    "Update the research checkpoint, then call checkpoint_research with the complete replacement brief and a continue_research decision.",
    `Keep it under ${args.maxBriefChars.toLocaleString("en-CA")} characters. Preserve material findings, contradictions, numbers, source names or locators, unresolved questions, and useful next checks. Correct prior notes when newer evidence conflicts. Set continue_research=true only for a concrete unresolved check available from the inventory that could materially change the requested deliverable; unread inventory or possible corroboration is not enough. Do not draft the deliverable.`,
    "Use dense ledger rows grouped by source or locator, not narrative. Keep every prior material row unless newer evidence corrects it, and consolidate duplicates instead of dropping them. The pinned orientation carries the file inventory, so spend checkpoint space on findings rather than repeating files with no material finding. End with compact CONTRADICTIONS, OPEN QUESTIONS, and NEXT CHECKS sections when nonempty.",
    ...(args.forceComplete
      ? [
          "This is the final initial-research checkpoint. Preserve any residual uncertainty in the brief and set continue_research=false. Draft/check may reopen targeted research for a concrete gap.",
        ]
      : []),
    "ORIGINAL REQUEST",
    args.originalRequest.trim(),
    "PRIOR RESEARCH CHECKPOINT",
    args.priorBrief.trim() || "(None yet.)",
    "EVIDENCE MAP",
    evidenceMap,
    ...(orientation ? ["PINNED ORIENTATION", orientation] : []),
    "LATEST RESULTS",
    renderNamedResults(args.latestResults),
  ].join("\n\n");
  return {
    sourceChars: items.reduce((total, item) => total + item.chars, 0),
    evidenceItems: items.length,
    latestResultChars,
    prompt,
    promptChars: prompt.length,
    evidenceMapChars: evidenceMap.length,
    orientationChars: orientation.length,
    priorBriefChars: args.priorBrief.trim().length,
  };
}

export async function compileCheckpointedEvidenceResearchRefresh(args: {
  state: EvidenceExposureState;
  load: EvidenceSourceLoader;
  originalRequest: string;
  researchBrief: string;
  continueResearch: boolean;
  orientation: Array<{ name: string; content: string }>;
}): Promise<EvidenceResearchRefresh> {
  const items = await handoffItems(args.state, args.load);
  const manifest = items.map(({ alias, filename, locator, chars, preview }) => ({
    alias,
    filename,
    locator,
    chars,
    preview,
  }));
  const evidenceMap = renderEvidenceMap(items);
  const orientation = args.orientation.length
    ? renderNamedResults(args.orientation)
    : "";
  const brief = args.researchBrief.trim();
  const prompt = [
    "You are the research agent reviewing a completed checkpoint.",
    args.continueResearch
      ? "Run only the concrete material next checks identified in the checkpoint. Do not scan unread sources merely for completeness or repeat corroborative research."
      : "The evidence reviewer marked research complete. Call describe_tools now for the appropriate drafting or output_document domain. The host will carry this exact reviewed checkpoint. Do not rewrite it in tool arguments. Do not make another research call.",
    "Do not draft the deliverable or finish this context with research prose or questions. Resolve ordinary ambiguities reasonably; do not stop for confirmation.",
    "ORIGINAL REQUEST",
    args.originalRequest.trim(),
    "RESEARCH CHECKPOINT",
    brief || "(No findings recorded yet.)",
    "EVIDENCE MAP",
    evidenceMap,
    ...(orientation ? ["PINNED ORIENTATION", orientation] : []),
  ].join("\n\n");
  return {
    manifest,
    sourceChars: items.reduce((total, item) => total + item.chars, 0),
    latestResultChars: 0,
    prompt,
    promptChars: prompt.length,
    evidenceMapChars: evidenceMap.length,
    orientationChars: orientation.length,
    briefChars: brief.length,
  };
}

function roundRobinByFile<T extends { filename: string; sequence: number }>(
  items: readonly T[],
) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(item.filename) ?? [];
    group.push(item);
    groups.set(item.filename, group);
  }
  const queues = [...groups.values()]
    .map((group) => group.sort((left, right) => right.sequence - left.sequence))
    .sort((left, right) => right[0].sequence - left[0].sequence);
  const ordered: T[] = [];
  while (queues.some((queue) => queue.length)) {
    for (const queue of queues) {
      const item = queue.shift();
      if (item) ordered.push(item);
    }
  }
  return ordered;
}

async function compileHotEvidence(args: {
  state: EvidenceExposureState;
  load: EvidenceSourceLoader;
  fallback: readonly HandoffItem[];
  maxChars: number;
}) {
  if (args.maxChars <= 0) return { text: "", sourceChars: 0, items: [] };
  const sourceCache = new Map<string, Awaited<ReturnType<EvidenceSourceLoader>>>();
  const candidates: Array<{
    filename: string;
    locator: string;
    text: string;
    sequence: number;
  }> = [];
  for (const range of args.state.ranges) {
    if (range.kind !== "candidate") continue;
    const key = `${range.documentId}:${range.versionId}`;
    let source = sourceCache.get(key);
    if (source === undefined) {
      source = await args.load(range.documentId, range.versionId);
      sourceCache.set(key, source);
    }
    if (!source || range.start < 0 || range.end > source.text.length) continue;
    candidates.push({
      filename: range.filename || source.filename,
      locator: compactLocator(range.start, range.end, range.locator),
      text: source.text.slice(range.start, range.end),
      sequence: range.sequence,
    });
  }
  for (const ref of args.state.refs.values()) {
    if (ref.kind !== "candidate") continue;
    candidates.push({
      filename: ref.filename,
      locator: ref.locator ?? ref.handle,
      text: ref.text,
      sequence: ref.sequence,
    });
  }
  const pool = candidates.length
    ? roundRobinByFile(candidates)
    : roundRobinByFile(
        args.fallback
          .filter((item) => item.chars <= 8_000)
          .map((item) => ({
            filename: item.filename,
            locator: item.locator,
            text: item.text,
            sequence: item.sequence,
          })),
      );
  const rendered: string[] = [];
  const selected: Array<{
    filename: string;
    locator: string;
    chars: number;
    exactSha256: string;
  }> = [];
  let used = 0;
  let sourceChars = 0;
  for (const item of pool) {
    const header = `=== ${item.filename} | ${item.locator} ===\n`;
    const remaining = args.maxChars - used - header.length - 2;
    if (remaining < 256) continue;
    const text = item.text.slice(0, Math.min(8_000, remaining));
    if (!text) continue;
    const block = `${header}${text}`;
    rendered.push(block);
    selected.push({
      filename: item.filename,
      locator: item.locator,
      chars: text.length,
      exactSha256: sha256(text),
    });
    used += block.length + 2;
    sourceChars += text.length;
    if (args.maxChars - used < 256) break;
  }
  return { text: rendered.join("\n\n"), sourceChars, items: selected };
}

function materializeEvidenceWorkingSet(
  items: readonly HandoffItem[],
  path: string,
): EvidenceVirtualWorkingSet {
  const parts: string[] = [];
  const segments: EvidenceVirtualWorkingSet["segments"] = [];
  const refs: EvidenceVirtualWorkingSet["refs"] = [];
  const mappedVersions = new Set<string>();
  let cursor = 0;
  const append = (text: string) => {
    parts.push(text);
    cursor += text.length;
  };
  for (const item of items) {
    append(`=== ${item.filename} | ${item.locator} ===\n`);
    item.excerpts.forEach((excerpt, index) => {
      if (item.excerpts.length > 1) {
        append(`--- exact excerpt ${index + 1} ---\n`);
      }
      const virtualStart = cursor;
      append(excerpt.text);
      if (
        excerpt.documentId &&
        excerpt.versionId &&
        typeof excerpt.start === "number" &&
        typeof excerpt.end === "number"
      ) {
        segments.push({
          virtualStart,
          virtualEnd: cursor,
          documentId: excerpt.documentId,
          versionId: excerpt.versionId,
          sourceStart: excerpt.start,
          sourceEnd: excerpt.end,
          projection: excerpt.projection,
          durableUnionBacked: true,
        });
        mappedVersions.add(`${excerpt.documentId}:${excerpt.versionId}`);
      }
      if (excerpt.ref) {
        refs.push({
          virtualStart,
          virtualEnd: cursor,
          ...excerpt.ref,
          durableUnionBacked: true,
        });
      }
      append("\n");
    });
    append("\n");
  }
  const text = parts.join("");
  const sourceChars = items.reduce((total, item) => total + item.chars, 0);
  return {
    path,
    text,
    sourceChars,
    matchedSourceChars: sourceChars,
    immutableSourceChars: sourceChars,
    mapChars: Math.max(0, text.length - sourceChars),
    budgetChars: 0,
    mappedVersions: [...mappedVersions],
    segments,
    refs,
    demandPaged: true,
    readGrants: new Set(),
  };
}

/** Mount the exact observed evidence without creating a prompt or context boundary. */
export async function compileEvidenceWorkingSet(args: {
  state: EvidenceExposureState;
  load: EvidenceSourceLoader;
  path: string;
}): Promise<EvidenceVirtualWorkingSet> {
  return materializeEvidenceWorkingSet(
    await handoffItems(args.state, args.load),
    args.path,
  );
}

export async function compilePagedEvidenceHandoff(args: {
  state: EvidenceExposureState;
  load: EvidenceSourceLoader;
  originalRequest: string;
  researchBrief: string;
  orientation?: Array<{ name: string; content: string }>;
  workingSetPath: string;
  hotMaxChars: number;
  domainGuidance?: string;
}): Promise<EvidencePagedHandoff> {
  const items = await handoffItems(args.state, args.load);
  const manifest = items.map(({ alias, filename, locator, chars, preview }) => ({
    alias,
    filename,
    locator,
    chars,
    preview,
  }));
  const workingSet = materializeEvidenceWorkingSet(items, args.workingSetPath);
  const hot = await compileHotEvidence({
    state: args.state,
    load: args.load,
    fallback: items,
    maxChars: args.hotMaxChars,
  });
  const evidenceMap = renderEvidenceMap(items);
  const orientation = args.orientation?.length
    ? renderNamedResults(args.orientation)
    : "";
  const prompt = [
    "You are the drafting agent. A previous research agent produced the brief and gathered the exact evidence.",
    "The checkpoint is the reviewed factual drafting basis, not a request to repeat the research pass.",
    "Use the checkpoint as a coverage checklist: address or explicitly disposition every material finding, contradiction, number, unresolved question, and next action in the appropriate deliverable before finishing.",
    "Produce every requested artifact at production-appropriate depth. A requested full draft must contain complete operative provisions rather than an outline or shortened specimen.",
    "The mounted union has already been reviewed. Paging it, or rereading a mapped source span, stays in drafting; use source or provider tools beyond that union only for a concrete missing fact, which the host will checkpoint before drafting resumes.",
    `Grep(path=${JSON.stringify(args.workingSetPath)}, output_mode="content") returns exact match-centred evidence and executable Read recipes. Use those hits directly. Read(file_path=${JSON.stringify(args.workingSetPath)}) only from a recipe when exact adjacent wording, a pinpoint, or an unresolved conflict is needed. Never page through the union sequentially or reread it for completeness.`,
    args.domainGuidance?.trim() || "",
    "ORIGINAL REQUEST",
    args.originalRequest.trim(),
    ...(orientation ? ["PINNED ORIENTATION", orientation] : []),
    "RESEARCH CHECKPOINT",
    args.researchBrief.trim() || "(No research notes were recorded.)",
    "EVIDENCE MAP",
    evidenceMap,
    ...(hot.text ? ["HOT EXACT EVIDENCE", hot.text] : []),
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    manifest,
    sourceChars: workingSet.sourceChars,
    hotSourceChars: hot.sourceChars,
    hotPacketChars: hot.text.length,
    hotItems: hot.items,
    evidenceMapChars: evidenceMap.length,
    orientationChars: orientation.length,
    workingSet,
    prompt,
  };
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
  const prompt = [
    "Continue the original task.",
    "The index lists prior evidence. Inspect an indexed passage again only when its exact text is needed.",
    "ORIGINAL REQUEST",
    args.originalRequest.trim(),
    "DURABLE EVIDENCE INDEX",
    renderEvidenceManifest(manifest) || "(No durable evidence yet.)",
    "LATEST RESULTS",
    args.latestResults
      .map(
        (result, index) =>
          `=== ${index + 1}. ${result.name} ===\n${result.content}`,
      )
      .join("\n\n"),
  ].join("\n\n");
  return {
    manifest,
    sourceChars: items.reduce((total, item) => total + item.chars, 0),
    latestResultChars,
    prompt,
    promptChars: prompt.length,
    evidenceMapChars: renderEvidenceManifest(manifest).length,
    orientationChars: 0,
    briefChars: 0,
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
      "You are the drafting agent. A previous research agent gathered the exact evidence below.",
      "Produce the requested deliverable from the original request and this evidence. Do not rely on omitted material.",
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
