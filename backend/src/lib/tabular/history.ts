import { assertResearchChangeBase, sameResearchValue, type ResearchChangeField } from "../researchHistory";
import type { TabularCell, TabularColumn, TabularReview } from "../tabularStore";

export type TableState = { review: TabularReview; cells: TabularCell[] };
const reviewFields = ["title", "project_id", "document_ids", "scope_config", "workflow_id", "shared_with"];
const questionFields = ["name", "prompt", "format", "tags"];
const questionField = (field: string) => /^columns_config\.(\d+)\.(\$|name|prompt|format|tags)$/u.exec(field);
export const resultState = ({ id, document_id, column_index, content, status }: TabularCell) =>
  ({ id, document_id, column_index, content, status });

export function tableChanges(before: TableState, after: TableState) {
  const result: ResearchChangeField[] = [];
  const add = (target: "table" | "result", id: string, field: string, left: unknown, right: unknown) => {
    if (!sameResearchValue(left, right)) result.push({ target, id, field, before: left ?? null, after: right ?? null });
  };
  for (const field of reviewFields) add("table", before.review.id, field, before.review[field], after.review[field]);
  const priorQuestions = new Map(before.review.columns_config.map((column) => [column.index, column])),
    nextQuestions = new Map(after.review.columns_config.map((column) => [column.index, column]));
  for (const index of new Set([...priorQuestions.keys(), ...nextQuestions.keys()])) {
    const prior = priorQuestions.get(index), next = nextQuestions.get(index);
    if (!prior || !next) add("table", before.review.id, `columns_config.${index}.$`, prior, next);
    else for (const field of questionFields) add("table", before.review.id, `columns_config.${index}.${field}`,
      prior[field as keyof TabularColumn], next[field as keyof TabularColumn]);
  }
  add("table", before.review.id, "columns_order", before.review.columns_config.map(({ index }) => index),
    after.review.columns_config.map(({ index }) => index));
  const prior = new Map(before.cells.map((cell) => [cell.id, resultState(cell)])),
    next = new Map(after.cells.map((cell) => [cell.id, resultState(cell)]));
  for (const id of new Set([...prior.keys(), ...next.keys()])) add("result", id, "$", prior.get(id), next.get(id));
  return result;
}

export function applyTableChanges(current: TableState, changes: ResearchChangeField[], inverse = false): TableState {
  const review = structuredClone(current.review), cells = new Map(current.cells.map((cell) => [cell.id, { ...cell }]));
  assertResearchChangeBase(changes, (change) => {
    if (change.target !== "table") return cells.has(change.id) ? resultState(cells.get(change.id)!) : null;
    if (change.field === "columns_order") return review.columns_config.map(({ index }) => index);
    const question = questionField(change.field);
    if (!question) return review[change.field];
    const column = review.columns_config.find(({ index }) => index === Number(question[1]));
    return question[2] === "$" ? column : column?.[question[2] as keyof TabularColumn];
  }, inverse);
  for (const change of changes) {
    const next = inverse ? change.before : change.after;
    if (change.target === "table") {
      if (change.id !== review.id) throw new Error("Invalid table history identity");
      const question = questionField(change.field);
      if (question) {
        const index = Number(question[1]), column = review.columns_config.find((column) => column.index === index);
        if (question[2] === "$") {
          review.columns_config = review.columns_config.filter((column) => column.index !== index);
          if (next !== null) review.columns_config.push(structuredClone(next as TabularColumn));
        } else if (column) {
          if (next === null) delete (column as Record<string, unknown>)[question[2]];
          else (column as Record<string, unknown>)[question[2]] = structuredClone(next);
        }
      } else if (change.field !== "columns_order") {
        if (!reviewFields.includes(change.field)) throw new Error("Invalid table history field");
        review[change.field] = structuredClone(next);
      }
    } else if (change.target === "result" && change.field === "$") {
      if (next === null) cells.delete(change.id);
      else cells.set(change.id, { ...cells.get(change.id), ...structuredClone(next as TabularCell), review_id: review.id });
    } else throw new Error("Invalid table history target");
  }
  const orderChange = changes.find(({ target, field }) => target === "table" && field === "columns_order");
  if (orderChange) {
    const order = (inverse ? orderChange.before : orderChange.after) as number[];
    review.columns_config.sort((left, right) => order.indexOf(left.index) - order.indexOf(right.index));
  }
  return { review, cells: [...cells.values()] };
}
