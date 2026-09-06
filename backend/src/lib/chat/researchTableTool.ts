import { z } from "zod";
import { ApplicationError, type ApplicationScope } from "../applicationError";
import type { ResearchFile } from "../researchFile";
import { safeErrorMessage } from "../safeError";
import { tabularDtos, type TabularApplication } from "../tabular/application";
import { researchArrangementToolSchema } from "../tabular/researchArrangement";
import { modelEvidencePassage, type LegalEvidenceReceipt } from "./legalEvidence";
import { toolText, type BeaverTool } from "./toolRegistry";

const string = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
const ids = { type: "array", maxItems: 500, uniqueItems: true, items: string(200) };
const object = (properties: Record<string, object>, required: string[] = []) => ({
  type: "object" as const, properties, required, additionalProperties: false,
});
const paging = { offset: z.number().int().min(0).max(1_000_000).default(0),
  limit: z.number().int().min(1).max(50).default(20) };
const readInput = z.object({ column_index: z.number().int().nonnegative().optional(), ...paging }).strict();
const answersInput = z.object({ chat_id: tabularDtos.id, ...paging,
  answer_id: tabularDtos.id.optional(), resource: z.string().min(1).max(4_000).optional(),
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

export function createResearchTableTool<Context>(dependencies: {
  application: Pick<TabularApplication, "detail" | "create" | "update" | "generate" | "stop" | "history" | "change" | "answers">;
  scope: ApplicationScope;
  model?: string;
  getWorkspace(): Promise<ResearchFile | null>;
  onMutationCommitted(): void | Promise<void>;
}): BeaverTool<Context> {
  const { application, scope } = dependencies;
  return {
    name: "update_research_table", research: true, sequential: true,
    description: "Arrange current workspace research into chosen rows, named columns and grouping. Link existing labels, passages and saved chat answers with arrangement references. answers lists canonical answer IDs; add answer_id and resource to page original reasoning and supporting passages with claim_offset/claim_limit, then text_offset/text_limit within long claims. Unmapped cells can generate new grounded answers. Read a column_index to inspect its prompt before editing; updates and change actions require expected_version. Updates apply reversibly; use propose only when the user requests a suggestion. History supports accept, reject and undo. Use read_table_cells to inspect cell answers.",
    inputSchema: object({
      action: { type: "string", enum: ["read", "answers", "create", "update", "generate", "stop", "history", "accept", "reject", "undo"] },
      review_id: string(200), title: { type: ["string", "null"], maxLength: 300 },
      expected_version: string(100), workflow_id: { type: ["string", "null"], maxLength: 200 },
      column_index: { type: "integer", minimum: 0 },
      chat_id: string(200), change_id: string(200), propose: { type: "boolean" },
      answer_id: string(200), resource: string(4_000),
      claim_offset: { type: "integer", minimum: 0, maximum: 1_000_000 },
      claim_limit: { type: "integer", minimum: 1, maximum: 10 },
      text_offset: { type: "integer", minimum: 0, maximum: 10_000_000 },
      text_limit: { type: "integer", minimum: 1, maximum: 12_000 },
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
        target: { type: "string", enum: ["sources", "passages"] }, unlabelled: { type: "boolean" } }, ["target"]),
      model: string(200), reasoning_effort: string(32),
    }, ["action"]),
    async execute(input) {
      let mutated = false;
      try {
        const workspace = await dependencies.getWorkspace();
        if (!workspace) throw new ApplicationError(400, "Open or create a research workspace first");
        const { action, review_id, ...values } = input;
        const operation = { executor: "assistant" as const, model: dependencies.model };
        if (action === "answers") {
          const options = answersInput.parse(values),
            page = await application.answers(scope, workspace.document.id, options),
            metadata = (finding: typeof page.items[number]) => ({ kind: finding.kind,
              answerId: finding.question.id, sourceId: finding.sourceId, resource: finding.resource,
              question: finding.question.prompt.slice(0, 1_000), claim_count: finding.answer.claims.length,
              origin: finding.origin });
          if (!options.answer_id) {
            const items: Record<string, unknown>[] = [];
            let size = 500;
            for (const finding of page.items) {
              const item = { ...metadata(finding), preview: finding.answer.claims[0]?.text.slice(0, 300) ?? "" },
                length = JSON.stringify(item).length;
              if (items.length && size + length > 52_000) break;
              items.push(item); size += length;
            }
            return { result: toolText({ ok: true, research_file_id: workspace.document.id,
              items, total: page.total, next_offset: options.offset + items.length < page.total
                ? options.offset + items.length : null }) };
          }
          if (page.total > 1 && !options.resource) throw new ApplicationError(400, "Select the answer's resource too");
          const finding = page.items[0];
          if (!finding) throw new ApplicationError(404, "Saved answer not found");
          const claims: Record<string, unknown>[] = [], evidence = new Map<string, LegalEvidenceReceipt>(),
            unreturned = new Set<string>();
          let size = JSON.stringify(metadata(finding)).length + 2_000, cursor = options.claim_offset;
          for (const claim of finding.answer.claims.slice(cursor, cursor + options.claim_limit)) {
            let text = claim.text.slice(options.text_offset, options.text_offset + options.text_limit);
            while (JSON.stringify(text).length > 24_000) text = text.slice(0, Math.ceil(text.length / 2));
            const length = JSON.stringify(text).length + JSON.stringify(claim.evidence_ids).length + 250;
            if (claims.length && size + length > 48_000) break;
            const supporting = finding.evidence.filter(({ evidence_id }) => claim.evidence_ids.includes(evidence_id));
            for (const receipt of supporting) if (!evidence.has(receipt.evidence_id)) {
              const length = JSON.stringify(modelEvidencePassage(receipt)).length;
              if (size + JSON.stringify(text).length + length > 50_000) unreturned.add(receipt.evidence_id);
              else { evidence.set(receipt.evidence_id, receipt); size += length; }
            }
            claims.push({ claim_index: cursor++, text, evidence_ids: claim.evidence_ids,
              text_offset: options.text_offset, text_length: claim.text.length,
              next_text_offset: options.text_offset + text.length < claim.text.length ? options.text_offset + text.length : null });
            size += length;
          }
          return { result: toolText({ ok: true, research_file_id: workspace.document.id,
            ...metadata(finding), claims, next_claim_offset: cursor < finding.answer.claims.length ? cursor : null,
            evidence: [...evidence.values()].map(modelEvidencePassage),
            ...(unreturned.size ? { support_not_returned: [...unreturned],
              next_read: { resource: finding.resource }, message: "Read this source to inspect the remaining supporting passages." } : {}) }),
          evidence: [...evidence.values()] };
        }
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
            const { propose, ...changes } = updateInput.parse(values);
            await application.update(scope, reviewId, { ...changes,
              ...(changes.research_selection ? { research_file_id: workspace.document.id } : {}) }, { ...operation, propose });
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
