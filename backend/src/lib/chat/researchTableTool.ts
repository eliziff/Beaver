import { z } from "zod";
import { ApplicationError, type ApplicationScope } from "../applicationError";
import type { ResearchFile } from "../researchFile";
import type { SourceWorkspaceApplication } from "../sourceWorkspaceApplication";
import { researchFindingReferenceSchema } from "../researchChat";
import type { ResearchSubject } from "../researchSelection";
import { researchResultFilter } from "../researchReader";
import { safeErrorMessage } from "../safeError";
import { tabularDtos, type TabularApplication } from "../tabular/application";
import { researchArrangementToolSchema } from "../tabular/researchArrangement";
import { modelEvidencePassage, type LegalEvidenceReceipt } from "./legalEvidence";
import { toolText, type BeaverOutcome, type BeaverTool } from "./toolRegistry";

const string = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
const ids = { type: "array", maxItems: 500, uniqueItems: true, items: string(200) };
const object = (properties: Record<string, object>, required: string[] = []) => ({
  type: "object" as const, properties, required, additionalProperties: false,
});
const paging = { offset: z.number().int().min(0).max(1_000_000).default(0),
  limit: z.number().int().min(1).max(50).default(20) };
const readInput = z.object({ column_index: z.number().int().nonnegative().optional(), ...paging }).strict();
const findingsInput = z.object({ sourceIds: z.array(z.string()).optional(),
  reference: researchFindingReferenceSchema.optional(), chatId: tabularDtos.id.optional(), ...paging,
  evidence_id: z.string().min(1).max(200).optional(),
  claim_offset: z.number().int().min(0).max(1_000_000).default(0),
  claim_limit: z.number().int().min(1).max(10).default(1),
  text_offset: z.number().int().min(0).max(10_000_000).default(0),
  text_limit: z.number().int().min(1).max(12_000).default(8_000),
}).strict();
const emptyInput = z.object({}).strict();
const createInput = tabularDtos.create.omit({ document_ids: true, project_id: true, research_file_id: true });
const updateInput = tabularDtos.update.pick({ title: true, columns_config: true,
  research_selection: true, arrangement: true, workflow_id: true, expected_version: true })
  .required({ expected_version: true }).extend({ propose: z.boolean().optional() });

export async function readResearchFindings(dependencies: { sources: SourceWorkspaceApplication;
  scope: ApplicationScope; workspaceId: string; subjects?: ResearchSubject[] }, input: z.input<typeof findingsInput>): Promise<BeaverOutcome> {
  const options = findingsInput.parse(input), { sources, scope, workspaceId } = dependencies,
    page = await sources.findings(scope, workspaceId, { ...options,
      ...(!options.reference ? { subjects: dependencies.subjects } : {}) }),
    permitted = researchResultFilter({ subjects: dependencies.subjects ?? [], restricted: !!dependencies.subjects }),
    metadata = (finding: typeof page.items[number]) => ({ reference: finding.reference, kind: finding.kind,
      read: { file_path: "findings", section: JSON.stringify(finding.reference), offset: 1 },
      sourceId: finding.sourceId, resource: finding.resource, question: { ...finding.question,
        prompt: finding.question.prompt.slice(0, 1_000) }, claim_count: finding.answer.claims.length, origin: finding.origin });
  if (!options.reference) {
    const items: Record<string, unknown>[] = []; let size = 500;
    for (const finding of page.items) {
      const item = { ...metadata(finding), preview: (finding.answer.summary ?? finding.answer.claims[0]?.text ?? "").slice(0, 300) },
        length = JSON.stringify(item).length;
      if (items.length && size + length > 50_000) break;
      items.push(item); size += length;
    }
    const next_offset = options.offset + items.length < page.total ? options.offset + items.length + 1 : null;
    return { result: toolText({ ok: true, research_file_id: workspaceId, items, total: page.total,
      is_running: page.is_running, next_offset,
      ...(next_offset ? { next_read: { file_path: "findings", offset: next_offset, limit: options.limit } } : {}) }) };
  }
  const finding = page.items[0];
  if (!finding) throw new ApplicationError(404, "Finding not found");
  if (!permitted(finding)) throw new ApplicationError(400, "This finding is outside the current selection. Select a supporting source or passage to read it.");
  if (options.evidence_id) {
    const receipt = finding.evidence.find(({ evidence_id }) => evidence_id === options.evidence_id);
    if (!receipt) throw new ApplicationError(404, "Original supporting passage not found");
    const passage = modelEvidencePassage(receipt);
    if (JSON.stringify(passage).length > 60_000)
      throw new ApplicationError(413, "This original supporting passage exceeds the model read limit");
    return { result: toolText(passage), evidence: [receipt] };
  }
  const claims: Record<string, unknown>[] = [], evidence = new Map<string, LegalEvidenceReceipt>(),
    unreturned = new Set<string>(), fields: Record<string, unknown> = {},
    text = (value: string) => {
      let shown = value.slice(options.text_offset, options.text_offset + options.text_limit);
      while (JSON.stringify(shown).length > 8_000) shown = shown.slice(0, Math.ceil(shown.length / 2));
      return { text: shown, text_offset: options.text_offset, text_length: value.length,
        next_text_offset: options.text_offset + shown.length < value.length ? options.text_offset + shown.length : null,
        ...(options.text_offset + shown.length < value.length ? { next_read: { file_path: "findings",
          section: JSON.stringify(finding.reference), offset: options.claim_offset + 1,
          limit: options.claim_limit, start_char: options.text_offset + shown.length } } : {}) };
    };
  for (const field of ["summary", "reasoning"] as const) if (finding.answer[field] !== undefined)
    fields[field] = text(finding.answer[field]!);
  const serialized = JSON.stringify(finding.answer.value);
  if (serialized !== undefined) {
    if (serialized.length <= 8_000) fields.value = finding.answer.value;
    else fields.value_json = text(serialized);
  }
  const question = { ...finding.question, prompt: text(finding.question.prompt) };
  let size = JSON.stringify({ ...metadata(finding), fields, question }).length + 2_000, cursor = options.claim_offset;
  for (const claim of finding.answer.claims.slice(cursor, cursor + options.claim_limit)) {
    const shown = text(claim.text), length = JSON.stringify(shown).length + JSON.stringify(claim.evidence_ids).length + 250;
    if (claims.length && size + length > 48_000) break;
    for (const receipt of finding.evidence.filter(({ evidence_id }) => claim.evidence_ids.includes(evidence_id)))
      if (!evidence.has(receipt.evidence_id)) {
        const bytes = JSON.stringify(modelEvidencePassage(receipt)).length;
        if (size + length + bytes > 50_000) unreturned.add(receipt.evidence_id);
        else { evidence.set(receipt.evidence_id, receipt); size += bytes; }
      }
    claims.push({ claim_index: cursor++, ...shown, evidence_ids: claim.evidence_ids }); size += length;
  }
  return { result: toolText({ ok: true, research_file_id: workspaceId, ...metadata(finding), question,
    result: { ...fields, flag: finding.answer.flag, outcome: finding.answer.outcome, coverage: finding.answer.coverage },
    claims, next_claim_offset: cursor < finding.answer.claims.length ? cursor : null,
    ...(cursor < finding.answer.claims.length ? { next_read: { file_path: "findings",
      section: JSON.stringify(finding.reference), offset: cursor + 1, limit: options.claim_limit } } : {}),
    evidence: [...evidence.values()].map(modelEvidencePassage), ...(unreturned.size ? { support_not_returned: [...unreturned],
      next_reads: finding.evidence.filter(({ evidence_id }) => unreturned.has(evidence_id)).map((receipt) =>
        ({ file_path: "findings", section: JSON.stringify(finding.reference), pattern: receipt.evidence_id })) } : {}) }), evidence: [...evidence.values()] };
}

export function createResearchTableTool<Context>(dependencies: {
  application: Pick<TabularApplication, "detail" | "create" | "update" | "generate" | "stop" | "history" | "change">;
  scope: ApplicationScope;
  model?: string;
  getWorkspace(): Promise<ResearchFile | null>;
  onMutationCommitted(): void | Promise<void>;
}): BeaverTool<Context> {
  const { application, scope } = dependencies;
  return {
    name: "update_research_table", research: true, sequential: true,
    description: "Arrange current workspace research into chosen rows, named columns and grouping. Link existing labels, passages and findings with arrangement references. Read findings to inspect canonical answer and cell references. Unmapped cells can generate new grounded answers. Read a column_index to inspect its prompt before editing; updates and change actions require expected_version. Updates apply reversibly; set propose to offer a change for review instead of applying it. History supports accept, reject and undo. Use read_table_cells to inspect cell answers.",
    inputSchema: object({
      action: { type: "string", enum: ["read", "create", "update", "generate", "stop", "history", "accept", "reject", "undo"] },
      review_id: string(200), title: { type: ["string", "null"], maxLength: 300 },
      expected_version: string(100), workflow_id: { type: ["string", "null"], maxLength: 200 },
      column_index: { type: "integer", minimum: 0 },
      change_id: string(200), propose: { type: "boolean" },
      offset: { type: "integer", minimum: 0, maximum: 1_000_000 },
      limit: { type: "integer", minimum: 1, maximum: 50 },
      arrangement: { anyOf: [researchArrangementToolSchema, { type: "null" }] },
      columns_config: { type: "array", maxItems: 100, items: object({
        index: { type: "integer", minimum: 0, maximum: 10_000 }, name: string(200), prompt: string(20_000),
        format: { type: "string", enum: ["text", "bulleted_list", "number", "percentage",
          "monetary_amount", "currency", "yes_no", "date", "tag"] },
        tags: { type: "array", maxItems: 100, items: string(200) },
      }, ["index", "name", "prompt"]) },
      research_selection: object({ sourceIds: ids, evidenceIds: ids, labelIds: ids,
        target: { type: "string", enum: ["sources", "passages"] }, unlabelled: { type: "boolean" },
        members: { type: "array", items: object({ sourceId: string(200), evidenceIds: ids }, ["sourceId"]) } }, ["target"]),
      model: string(200), reasoning_effort: string(32),
    }, ["action"]),
    async execute(input) {
      let mutated = false;
      try {
        const workspace = await dependencies.getWorkspace();
        if (!workspace) throw new ApplicationError(400, "Open or create a research workspace first");
        const { action, review_id, ...values } = input;
        const operation = { executor: "assistant" as const, model: dependencies.model };
        let reviewId: string, extra: Record<string, unknown> = {};
        if (action === "create") {
          const review = await application.create(scope, { ...createInput.parse(values),
            research_file_id: workspace.document.id, project_id: workspace.document.project_id ?? undefined }, operation);
          reviewId = review.id; mutated = true;
        } else {
          reviewId = tabularDtos.id.parse(review_id);
          if (!workspace.state.tables?.includes(reviewId))
            throw new ApplicationError(404, "Table is outside the current workspace");
          const current = await application.detail(scope, reviewId);
          if (current.review.scope_config?.research_file_id !== workspace.document.id)
            throw new ApplicationError(404, "Table is outside the current workspace");
          if (action === "update") {
            const { propose, ...changes } = updateInput.parse(values), next = changes.columns_config;
            // Renames, reorders and additions apply; rewriting, reformatting or dropping an
            // existing column is the user's call, so it is always offered as a proposal.
            const revises = !!next && current.review.columns_config.some((column) => {
              const updated = next.find(({ index }) => index === column.index);
              return !updated || updated.prompt !== column.prompt ||
                (updated.format ?? "text") !== (column.format ?? "text") ||
                JSON.stringify(updated.tags ?? []) !== JSON.stringify(column.tags ?? []);
            });
            await application.update(scope, reviewId, { ...changes,
              ...(changes.research_selection ? { research_file_id: workspace.document.id } : {}) },
            { ...operation, propose: revises || propose });
            mutated = true;
          } else if (action === "history") {
            const page = await application.history(scope, reviewId, tabularDtos.history.parse(values));
            return { result: toolText({ ok: true, review_id: reviewId, ...page }) };
          } else if (action === "accept" || action === "reject" || action === "undo") {
            const { change_id, ...rest } = values;
            await application.change(scope, reviewId, tabularDtos.change.parse({ ...rest, id: change_id, action }), operation);
            mutated = true;
          } else if (action === "generate") {
            const generated = await application.generate(scope, reviewId, tabularDtos.generate.parse(values));
            extra = generated; mutated = generated.queued > 0;
          } else if (action === "stop") {
            emptyInput.parse(values);
            const stopped = await application.stop(scope, reviewId);
            extra = stopped; mutated = stopped.stopped;
          } else if (action === "read") readInput.parse(values);
          else throw new ApplicationError(400, "Unknown table action");
        }
        if (mutated) await dependencies.onMutationCommitted();
        const { review, cells } = await application.detail(scope, reviewId), counts = {
          pending: 0, generating: 0, done: 0, error: 0,
        };
        for (const cell of cells) counts[cell.status]++;
        const selected = action === "read" && typeof values.column_index === "number"
          ? review.columns_config.find(({ index }) => index === values.column_index) : undefined;
        if (action === "read" && values.column_index !== undefined && !selected)
          throw new ApplicationError(404, "Column not found");
        const { offset, limit } = action === "read" ? readInput.parse(values) : { offset: 0, limit: 20 },
          arrangement = review.scope_config?.arrangement,
          rows = arrangement?.rows.slice(offset, offset + limit), rowIds = new Set(rows?.map(({ id }) => id));
        return { result: toolText({ ok: true, research_file_id: workspace.document.id,
          review_id: reviewId, title: review.title,
          expected_version: review.updated_at, is_running: review.is_running,
          source_count: review.document_ids.length, cells: counts,
          findings: review.scope_config?.findings,
          proposals: review.proposals, history_count: review.history_count,
          ...(arrangement ? { arrangement: { rows, cells: arrangement.cells.filter((cell) => rowIds.has(cell.rowId) &&
            (!selected || cell.columnIndex === selected.index)), total_rows: arrangement.rows.length,
          next_offset: offset + limit < arrangement.rows.length ? offset + limit : null } } : {}),
          columns: selected ? [selected] : review.columns_config.map(({ index, name, format }) =>
            ({ index, name, format: format ?? "text" })), ...extra }), mutated };
      } catch (error) {
        return { result: toolText({ ok: false, error: safeErrorMessage(error, "The table could not be updated"),
          ...(error instanceof ApplicationError ? { status: error.status } : {}) }, true), mutated };
      }
    },
  };
}
