import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import {
  modelSupportsImageInput,
  streamChatWithTools,
  type NormalizedToolCall,
  type Tool,
  type UserApiKeys,
} from "./llm";
import { sha256 } from "./hash";

const LAYOUT_TYPES = [
  "abstract",
  "content",
  "display_formula",
  "doc_title",
  "figure_title",
  "footer",
  "footnote",
  "header",
  "image",
  "paragraph_title",
  "reference",
  "table",
  "text",
] as const;

const SYSTEM_PROMPT = `You classify the visible regions of one legal-document page.
Use only the supplied line IDs and the allowed region types. Group adjacent lines that form one region. Put every supplied line ID in exactly one region and preserve natural reading order. A table region includes all of its visible cell lines. A footnote is note text, not an ordinary footer. Page numbers and repeating running text are headers or footers. Section headings are paragraph_title; the work's main title is doc_title. Use text when no more specific class is justified. Call submit_page_layout once and return no prose.`;

const SUBMIT_TOOL: Tool = {
  name: "submit_page_layout",
  description: "Submit the complete line-to-region layout for one page.",
  inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        page_index: { type: "integer", minimum: 0 },
        regions: {
          type: "array",
          maxItems: 256,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              type: { type: "string", enum: [...LAYOUT_TYPES] },
              reading_order: { type: "integer", minimum: 1, maximum: 100000 },
              line_ids: {
                type: "array",
                minItems: 1,
                items: { type: "string" },
              },
            },
            required: ["type", "reading_order", "line_ids"],
          },
        },
      },
      required: ["page_index", "regions"],
  },
};

type LayoutLine = {
  id: string;
  text: string;
  bbox: [number, number, number, number];
  exclude_from_body?: boolean;
};

type LayoutPage = {
  index: number;
  number: number;
  width: number;
  height: number;
  lines: LayoutLine[];
};

type LayoutInput = {
  schema_version: string;
  source_sha256: string;
  pages: LayoutPage[];
};

export type PageLayoutRegion = {
  type: (typeof LAYOUT_TYPES)[number];
  reading_order: number;
  line_ids: string[];
};

export type PageLayout = {
  page_index: number;
  regions: PageLayoutRegion[];
};

export const PDF_VISION_LAYOUT_IDENTITY = (model: string) =>
  `mllm-line-layout-v1:model=${model}:contract=${sha256(
    JSON.stringify({ prompt: SYSTEM_PROMPT, tool: SUBMIT_TOOL }),
  )}`;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function normalizePageLayout(
  call: NormalizedToolCall,
  page: LayoutPage,
): PageLayout {
  if (call.name !== "submit_page_layout") {
    throw new Error(`Unexpected PDF layout tool: ${call.name}`);
  }
  const input = asRecord(call.input);
  if (input?.page_index !== page.index || !Array.isArray(input.regions)) {
    throw new Error("PDF layout submission names the wrong page");
  }
  const expected = new Set(
    page.lines
      .filter((line) => !line.exclude_from_body && line.text.trim())
      .map((line) => line.id),
  );
  const seen = new Set<string>();
  const regions: PageLayoutRegion[] = [];
  for (const raw of input.regions) {
    const region = asRecord(raw);
    const kind = region?.type;
    const order = region?.reading_order;
    const lineIds = region?.line_ids;
    if (
      typeof kind !== "string" ||
      !LAYOUT_TYPES.includes(kind as PageLayoutRegion["type"]) ||
      !Number.isInteger(order) ||
      Number(order) < 1 ||
      Number(order) > 100_000 ||
      !Array.isArray(lineIds) ||
      lineIds.length === 0
    ) {
      throw new Error("PDF layout submission contains an invalid region");
    }
    const checked = lineIds.map((lineId) => {
      if (
        typeof lineId !== "string" ||
        !expected.has(lineId) ||
        seen.has(lineId)
      ) {
        throw new Error(`PDF layout submission contains an invalid line ID: ${String(lineId)}`);
      }
      seen.add(lineId);
      return lineId;
    });
    regions.push({
      type: kind as PageLayoutRegion["type"],
      reading_order: Number(order),
      line_ids: checked,
    });
  }
  let fallbackOrder = Math.max(0, ...regions.map((region) => region.reading_order));
  for (const line of page.lines) {
    if (expected.has(line.id) && !seen.has(line.id)) {
      fallbackOrder += 1;
      regions.push({
        type: "text",
        reading_order: fallbackOrder,
        line_ids: [line.id],
      });
    }
  }
  regions.sort((left, right) => left.reading_order - right.reading_order);
  return { page_index: page.index, regions };
}

function pagePrompt(page: LayoutPage, lines: LayoutLine[]) {
  const normalized = lines.map((line) => ({
    id: line.id,
    bbox_1000: line.bbox.map((value, index) =>
      Math.round((value / (index % 2 === 0 ? page.width : page.height)) * 1000),
    ),
    text: line.text,
  }));
  return JSON.stringify({
    page_index: page.index,
    printed_page_number: page.number,
    coordinate_system: "top-left origin; bbox_1000 is [x1,y1,x2,y2]",
    lines: normalized,
  });
}

async function classifyPage(args: {
  page: LayoutPage;
  imagesDir: string;
  model: string;
  abortSignal?: AbortSignal;
  apiKeys?: UserApiKeys;
}) {
  const lines = args.page.lines.filter(
    (line) => !line.exclude_from_body && line.text.trim(),
  );
  if (lines.length === 0) {
    return { page_index: args.page.index, regions: [] } satisfies PageLayout;
  }
  const imagePath = path.join(
    args.imagesDir,
    `page-${String(args.page.index).padStart(6, "0")}.png`,
  );
  const image = await readFile(imagePath);
  let submitted: PageLayout | null = null;
  await streamChatWithTools({
    model: args.model,
    systemPrompt: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: pagePrompt(args.page, lines),
        images: [
          {
            filename: path.basename(imagePath),
            mimeType: "image/png",
            data: image.toString("base64"),
          },
        ],
      },
    ],
    tools: [SUBMIT_TOOL],
    maxIterations: 2,
    enableThinking: false,
    abortSignal: args.abortSignal,
    apiKeys: args.apiKeys,
    runTools: async (calls) =>
      calls.map((call) => {
        try {
          submitted = normalizePageLayout(call, args.page);
          return {
            tool_use_id: call.id,
            content: JSON.stringify({ ok: true }),
            terminal: true,
          };
        } catch (error) {
          return {
            tool_use_id: call.id,
            content: JSON.stringify({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          };
        }
      }),
  });
  if (!submitted) {
    throw new Error(`Vision model did not submit layout for page ${args.page.number}`);
  }
  return submitted;
}

export async function runPdfVisionLayout(args: {
  inputPath: string;
  imagesDir: string;
  outputPath: string;
  model: string;
  abortSignal?: AbortSignal;
  apiKeys?: UserApiKeys;
}) {
  if (!modelSupportsImageInput(args.model)) {
    throw new Error(`PDF layout model does not accept images: ${args.model}`);
  }
  const input = JSON.parse(await readFile(args.inputPath, "utf8")) as LayoutInput;
  if (
    input.schema_version !== "legalpdf.common-input.v1" ||
    !/^[a-f0-9]{64}$/u.test(input.source_sha256) ||
    !Array.isArray(input.pages)
  ) {
    throw new Error("Rust returned an invalid PDF layout input");
  }
  const pages = new Array<PageLayout>(input.pages.length);
  let next = 0;
  let completed = 0;
  const requestedConcurrency = Number(process.env.MIKE_PDF_LAYOUT_CONCURRENCY);
  const concurrency = Math.min(
    input.pages.length || 1,
    Number.isInteger(requestedConcurrency) && requestedConcurrency > 0
      ? requestedConcurrency
      : 4,
  );
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        const slot = next;
        next += 1;
        if (slot >= input.pages.length) return;
        pages[slot] = await classifyPage({
          page: input.pages[slot],
          imagesDir: args.imagesDir,
          model: args.model,
          abortSignal: args.abortSignal,
          apiKeys: args.apiKeys,
        });
        completed += 1;
        console.info(`[pdf-layout] ${completed}/${input.pages.length} pages classified`);
      }
    }),
  );
  const assignments = {
    schema_version: "legalpdf.layout-assignments.v1",
    source_sha256: input.source_sha256,
    provider: "mllm",
    model: args.model,
    identity: PDF_VISION_LAYOUT_IDENTITY(args.model),
    pages,
  };
  await writeFile(args.outputPath, `${JSON.stringify(assignments, null, 2)}\n`, "utf8");
  return assignments;
}
