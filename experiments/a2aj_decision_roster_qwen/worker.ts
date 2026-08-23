#!/usr/bin/env node

/**
 * Worker for the seeded capture/verify pipeline. Compiled into a single
 * self-contained bundle (scratch/worker.bundle.mjs) by seedcheck before the
 * pool spawns, because worker threads cannot resolve this repo's
 * extensionless/parent-relative TypeScript imports at runtime.
 */

import { parentPort } from "node:worker_threads";
import { createHash } from "node:crypto";
import { analyzeDocumentNative } from "../../backend/src/lib/structureNative";
import type { SourceDoc } from "../../backend/src/lib/sourceDoc";
import {
  analyzeOpinionStructure,
  partitionOpinionStructure,
} from "../../backend/experiments/a2aj-decision-roster/legalOpinionBoundaries";
import type {
  Claims,
  OpinionDelimiter,
  WorkerJob,
  WorkerResult,
} from "./seedtypes";

type Geometry = {
  paragraph: Map<number, { start: number; end: number }>;
  /** Sorted by start offset; page number per reporter page block. */
  pages: Array<{ number: number; start: number; end: number }>;
};

/** Paragraph label "parN" -> number, else null. */
function labelNumber(label: string, prefix: string): number | null {
  const match = new RegExp(`^${prefix}(\\d+)$`, "u").exec(label);
  return match ? Number(match[1]) : null;
}

function buildGeometry(blocks: readonly { kind: string; label: string; start: number; end: number }[]): Geometry {
  const paragraph = new Map<number, { start: number; end: number }>();
  const pages: Geometry["pages"] = [];
  for (const block of blocks) {
    const number = labelNumber(block.label, "par");
    if (block.kind === "paragraph" && number !== null) {
      paragraph.set(number, { start: block.start, end: block.end });
      continue;
    }
    const pageNumber = labelNumber(block.label, "page");
    if (block.kind === "page" && pageNumber !== null) {
      pages.push({ number: pageNumber, start: block.start, end: block.end });
    }
  }
  pages.sort((a, b) => a.start - b.start);
  return { paragraph, pages };
}

/** Reporter page whose block contains `offset`; null when no page found. */
function pageAtOffset(geometry: Geometry, offset: number): number | null {
  // Pages are sorted by start offset; the last page starting at or before the
  // offset is the page the offset falls on (page blocks run to the next start
  // or text end).
  let found: number | null = null;
  for (const page of geometry.pages) {
    if (page.start <= offset) found = page.number;
    else break;
  }
  return found;
}

function buildOpinions(
  structure: ReturnType<typeof analyzeOpinionStructure>,
  partition: ReturnType<typeof partitionOpinionStructure>,
  geometry: Geometry,
): OpinionDelimiter[] {
  const namesByRole = new Map<string, string[]>();
  for (const binding of structure.bindings) {
    const existing = namesByRole.get(binding.role) ?? [];
    for (const name of [...binding.names, ...binding.concurred]) {
      if (!existing.includes(name)) existing.push(name);
    }
    namesByRole.set(binding.role, existing);
  }
  const opinions: OpinionDelimiter[] = [];
  const push = (role: string, from: number, to: number) => {
    const fromBlock = geometry.paragraph.get(from);
    const toBlock = geometry.paragraph.get(to);
    let offset: { start: number; end: number } | null = null;
    if (fromBlock && toBlock) {
      offset = { start: fromBlock.start, end: toBlock.end };
    }
    const pageStart = offset ? pageAtOffset(geometry, offset.start) : null;
    const pageEnd = offset ? pageAtOffset(geometry, offset.end) : null;
    opinions.push({
      role,
      names: [...(namesByRole.get(role) ?? [])],
      paragraphs: fromBlock && toBlock ? { from, to } : null,
      offset,
      page:
        pageStart !== null && pageEnd !== null
          ? { start: pageStart, end: pageEnd }
          : null,
    });
  };
  for (const [role, spans] of Object.entries(partition.spans)) {
    for (const span of spans) push(role, span.from, span.to);
  }
  // Partial coverage still delimits the ranges the header explicitly named.
  for (const binding of structure.bindings) {
    if (binding.from === null || binding.to === null) continue;
    if (partition.spans[binding.role]?.some((span) => span.from === binding.from && span.to === binding.to)) continue;
    push(binding.role, binding.from, binding.to);
  }
  return opinions;
}

async function processJob(job: WorkerJob): Promise<WorkerResult> {
  const analyzed = await analyzeDocumentNative<{
    structure: unknown; source_doc?: SourceDoc;
  }>({
    kind: "a2aj", source_doc: true, input: {
      citation: job.citation, source_kind: "cases", text: job.text,
      url: job.url, alternate_citation: job.alternateCitation,
      dataset: job.dataset, name: job.name,
    },
  });
  if (!analyzed.source_doc) throw new Error("Rust omitted SourceDoc");
  const source = analyzed.source_doc;
  const paragraphs = source.blocks.filter((block) => block.kind === "paragraph");
  const pages = source.blocks
    .filter((block) => block.kind === "page")
    .map((block) => {
      const match = /^page(\d+)$/u.exec(block.label);
      return match ? Number(match[1]) : Number(block.label) || 0;
    });
  const structure = analyzeOpinionStructure({
    text: source.text,
    firstParagraphStart: paragraphs[0]?.start ?? 0,
  });
  const partition = partitionOpinionStructure(
    structure,
    paragraphs.map((block) => {
      const match = /^par(\d+)$/u.exec(block.label);
      return match ? Number(match[1]) : Number(block.label) || 0;
    }),
  );
  // The mature A2AJ compiler already ran the page lane (PAGE_MARK_RE /
  // pageBlocks). When the paragraph spine is empty, surface the page spine
  // the compiler found instead of concluding "no paragraph spine" without
  // ever consulting the page structure.
  const pageSpine = pages.length ? pages : null;
  const partitionNote =
    partition.note === "no paragraph spine" && pageSpine
      ? `no paragraph spine; page spine: ${pageSpine.length} pages`
      : partition.note;
  const geometry = buildGeometry(source.blocks);
  const claims: Claims = {
    status: structure.status,
    panel: [...structure.panel],
    bindings: structure.bindings.map((binding) => ({
      role: binding.role,
      names: [...binding.names],
      from: binding.from,
      to: binding.to,
      page: binding.page,
      line: binding.line ?? "",
    })),
    markers: structure.bodyMarkers.map((marker) => ({
      paragraph: marker.paragraph,
      kind: marker.kind,
      name: marker.name ?? null,
      role: marker.role ?? null,
      line: marker.line ?? "",
    })),
    refusals: [...structure.refusals],
    partition: {
      status: partition.status,
      note: partitionNote ?? null,
      spans: Object.fromEntries(
        Object.entries(partition.spans).map(([role, spans]) => [
          role,
          spans.map((span) => ({ from: span.from, to: span.to })),
        ]),
      ),
      judges: partition.judges.map((judge) => ({
        name: judge.name,
        role: judge.role,
      })),
    },
    pages: pageSpine,
    opinions: buildOpinions(structure, partition, geometry),
  };
  return {
    documentId: job.documentId,
    sourceSha256: createHash("sha256").update(job.text, "utf8").digest("hex"),
    claims,
  };
}

parentPort!.on("message", async (batch: WorkerJob[] | null) => {
  if (!batch) {
    process.exit(0);
  }
  parentPort!.postMessage(await Promise.all(batch.map(processJob)));
});
