import { useCallback, useRef } from "react";
import { actOnResearchFile, getResearchFile, runResearchFileQuery } from "@/app/lib/api/researchFiles";
import { BeaverApiError } from "@/app/lib/api/client";
import type { ResearchAction, ResearchActionResult, ResearchFile, ResearchQueryInput,
  ResearchQueryResult } from "@/app/lib/researchFiles";

type Outcome<T> = { file: ResearchFile; value: T };
export type ResearchFileMutations = {
  act: (action: ResearchAction) => Promise<ResearchActionResult>;
  query: (input: ResearchQueryInput) => Promise<ResearchQueryResult>;
};
export const isResearchConnectionError = (error: unknown) => error instanceof TypeError ||
  error instanceof BeaverApiError && [502, 503, 504].includes(error.status);

export function useResearchFileMutations(file: ResearchFile | null,
  onChange: (file: ResearchFile) => void): ResearchFileMutations {
  const current = useRef(file), changed = useRef(onChange), tail = useRef(Promise.resolve()),
    documentId = useRef(file?.document.id), generation = useRef(0);
  changed.current = onChange;
  if (documentId.current !== file?.document.id) {
    documentId.current = file?.document.id; current.current = file;
    generation.current++; tail.current = Promise.resolve();
  } else if (file && (!current.current || file.versionId !== current.current.versionId ||
      file.workingRevision > current.current.workingRevision)) current.current = file;

  const enqueue = useCallback(<T,>(operation: (file: ResearchFile) => Promise<Outcome<T>>, retryConnection = false) => {
    const id = documentId.current, run = generation.current;
    if (!id) return Promise.reject(new Error("Open a workspace first."));
    const task = tail.current.then(async () => {
      let base = current.current;
      if (!base || base.document.id !== id || generation.current !== run)
        throw new Error("The workspace is no longer open.");
      let result: Outcome<T>;
      try { result = await operation(base); }
      catch (reason) {
        if (generation.current !== run || !(reason instanceof BeaverApiError && reason.code === "revision_conflict" ||
          retryConnection && isResearchConnectionError(reason)))
          throw reason;
        base = await getResearchFile(id);
        if (generation.current !== run) throw new Error("The workspace is no longer open.", { cause: reason });
        current.current = base;
        result = await operation(base);
      }
      if (generation.current === run && documentId.current === id) {
        current.current = result.file; changed.current(result.file);
      }
      return result.value;
    });
    tail.current = task.then(() => undefined, () => undefined); return task;
  }, []);

  return {
    act: useCallback((action) => enqueue(async (base) => {
      // A lost response may already have saved this memo. Reconcile before retrying.
      if (action.type === "note" && action.markdown === base.state.note) return { file: base, value: base };
      const next = await actOnResearchFile(base.document.id, base.versionId,
        base.workingRevision, action); return { file: next, value: next };
    }, action.type === "note" && action.expectedMarkdown !== undefined), [enqueue]),
    query: useCallback((input) => enqueue(async (base) => {
      const value = await runResearchFileQuery(base.document.id, {
        ...input, versionId: base.versionId, workingRevision: base.workingRevision,
      }); return { file: value.file, value };
    }), [enqueue]),
  };
}
