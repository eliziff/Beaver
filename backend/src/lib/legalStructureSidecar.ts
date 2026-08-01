/**
 * Durable structure sidecars for the documents that are worth pre-baking.
 *
 * The in-memory memo in `legalTextSkeleton` fixes repetition WITHIN a
 * process. It does nothing for the case that actually hurts: a landmark
 * statute, compiled cold, on a laptop. Measured on the Income Tax Act
 * (7,318,921 characters) the skeleton costs ~750 ms and the cross-reference
 * graph ~13.7 SECONDS — and every restart pays it again. These are exactly
 * the documents a model should be able to navigate leanly, because they are
 * far too large to read and their structure is the only way in.
 *
 * So: compute once, offline, and keep it. The cache is content-addressed on
 * the text, so a consolidation update simply misses and re-bakes; there is no
 * staleness to manage and no invalidation to get wrong.
 *
 * WHAT IS AND IS NOT PERSISTED. A `SourceDoc` cannot be serialized: its
 * `index` is a `Map` (JSON gives `{}`, and every lookup would then silently
 * answer "not found"), and `tokens` is a non-enumerable lazy accessor that
 * `structuredClone` drops and cannot re-attach. So the sidecar stores the
 * JSON-safe inventory and rebuilds the doc through `createSourceDoc` on load,
 * which is O(blocks) and does not tokenize. The graph is plain data and is
 * stored whole.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { devLog } from "./chat/types";
import { mikeLocalDataHome } from "./legalDataPath";
import {
  compileAgreementSkeleton,
  type AgreementSkeleton,
  type CompileSkeletonOptions,
} from "./legalTextSkeleton";
import { crossReferenceGraph, type CrossReferenceGraph } from "./legalCrossReference";
import { createSourceDoc, type SourceDocBlock } from "./sourceDoc";

/**
 * Bumped whenever the compiler's output for the same text changes, so a
 * stale bake can never be served. This is the same discipline `parseCache`
 * applies to parser versions — the alternative is a cache that quietly
 * disagrees with the code that reads it.
 */
const SIDECAR_VERSION = 1;

type SkeletonPayload = {
  version: number;
  id: string;
  nodes: AgreementSkeleton["nodes"];
  blocks: SourceDocBlock[];
  definedTerms: AgreementSkeleton["definedTerms"];
  schedules: AgreementSkeleton["schedules"];
  crossReferences: AgreementSkeleton["crossReferences"];
  ladder: AgreementSkeleton["ladder"];
  outline: AgreementSkeleton["outline"];
  outlineRefusal: AgreementSkeleton["outlineRefusal"];
};

const sidecarRoot = () => path.join(mikeLocalDataHome(), "structure-cache");

const textDigest = (text: string) =>
  createHash("sha256").update(text).digest("hex");

function sidecarPath(digest: string, variant: string, kind: string) {
  return path.join(sidecarRoot(), `${digest}.${variant}.${kind}.v${SIDECAR_VERSION}.json`);
}

const variantOf = (id: string, options: CompileSkeletonOptions) =>
  `${options.recoverExtraction === false ? "norecover" : "recover"}-${
    createHash("sha256").update(id).digest("hex").slice(0, 8)
  }`;

/** Rebuild a skeleton from its payload; `createSourceDoc` does not tokenize. */
function rehydrate(text: string, payload: SkeletonPayload): AgreementSkeleton {
  return {
    nodes: payload.nodes,
    doc: createSourceDoc({
      provider: null,
      id: payload.id,
      text,
      blocks: payload.blocks,
    }),
    definedTerms: payload.definedTerms,
    schedules: payload.schedules,
    crossReferences: payload.crossReferences,
    ladder: payload.ladder,
    outline: payload.outline,
    outlineRefusal: payload.outlineRefusal,
  };
}

/**
 * Skeleton for `text`, served from a bake when one exists.
 *
 * A cache read that fails for ANY reason falls through to a real compile:
 * correctness never depends on a hit, only speed does.
 */
export async function bakedSkeleton(
  text: string,
  id = "",
  options: CompileSkeletonOptions = {},
): Promise<AgreementSkeleton> {
  const file = sidecarPath(textDigest(text), variantOf(id, options), "skeleton");
  try {
    const payload = JSON.parse(await fs.readFile(file, "utf8")) as SkeletonPayload;
    if (payload.version === SIDECAR_VERSION && Array.isArray(payload.nodes)) {
      devLog(`[structure-cache] skeleton hit ${path.basename(file)}`);
      return rehydrate(text, payload);
    }
  } catch {
    // Miss, unreadable, or a version bump: compile for real.
  }
  return compileAgreementSkeleton(text, id, options);
}

/** Cross-reference graph for `text`, served from a bake when one exists. */
export async function bakedCrossReferenceGraph(
  text: string,
  id = "",
  options: CompileSkeletonOptions = {},
): Promise<CrossReferenceGraph> {
  const digest = textDigest(text);
  const variant = variantOf(id, options);
  const file = sidecarPath(digest, variant, "graph");
  const skeleton = await bakedSkeleton(text, id, options);
  try {
    const payload = JSON.parse(await fs.readFile(file, "utf8")) as {
      version: number;
      graph: CrossReferenceGraph;
    };
    if (payload.version === SIDECAR_VERSION && payload.graph?.counts) {
      devLog(`[structure-cache] graph hit ${path.basename(file)}`);
      // The graph's own `nodes` are the skeleton's; serve the rehydrated ones
      // so identity holds for anything keying off them.
      return { ...payload.graph, nodes: skeleton.nodes };
    }
  } catch {
    // Fall through.
  }
  return crossReferenceGraph(text, id, { skeleton });
}

export type BakeReport = {
  id: string;
  chars: number;
  nodes: number;
  edges: number;
  skeletonMs: number;
  graphMs: number;
  digest: string;
};

/** Compute and persist both sidecars for one document. */
export async function bakeStructure(
  text: string,
  id = "",
  options: CompileSkeletonOptions = {},
): Promise<BakeReport> {
  const digest = textDigest(text);
  const variant = variantOf(id, options);

  const skeletonStarted = performance.now();
  const skeleton = compileAgreementSkeleton(text, id, options);
  const skeletonMs = performance.now() - skeletonStarted;

  const graphStarted = performance.now();
  const graph = crossReferenceGraph(text, id, { skeleton });
  const graphMs = performance.now() - graphStarted;

  const payload: SkeletonPayload = {
    version: SIDECAR_VERSION,
    id,
    nodes: skeleton.nodes,
    blocks: skeleton.doc.blocks,
    definedTerms: skeleton.definedTerms,
    schedules: skeleton.schedules,
    crossReferences: skeleton.crossReferences,
    ladder: skeleton.ladder,
    outline: skeleton.outline,
    outlineRefusal: skeleton.outlineRefusal,
  };
  await fs.mkdir(sidecarRoot(), { recursive: true });
  await writeAtomic(sidecarPath(digest, variant, "skeleton"), payload);
  // `nodes` is the skeleton's array; drop it rather than store it twice.
  await writeAtomic(sidecarPath(digest, variant, "graph"), {
    version: SIDECAR_VERSION,
    graph: { ...graph, nodes: [] },
  });

  return {
    id,
    chars: text.length,
    nodes: skeleton.nodes.length,
    edges: graph.edges.length,
    skeletonMs,
    graphMs,
    digest,
  };
}

/** Write-then-rename so a concurrent reader never sees a torn sidecar. */
async function writeAtomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value));
  await fs.rename(temporary, file);
}
