import { useCallback, useRef } from "react";
import { actOnResearchFile, getResearchFile, runResearchFileQuery } from "@/app/lib/beaverApi";
import { BeaverApiError } from "@/app/lib/apiTransport";
import type { ResearchAction, ResearchActionResult, ResearchFile, ResearchQueryInput,
  ResearchQueryResult } from "@/app/lib/researchFiles";

type Outcome<T> = { file: ResearchFile; value: T };
export type ResearchFileMutations = {
  act: (action: ResearchAction) => Promise<ResearchActionResult>;
  query: (input: ResearchQueryInput) => Promise<ResearchQueryResult>;
};

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

  const enqueue = useCallback(<T,>(operation: (file: ResearchFile) => Promise<Outcome<T>>) => {
    const id = documentId.current, run = generation.current;
    if (!id) return Promise.reject(new Error("Open a workspace first."));
    const task = tail.current.then(async () => {
      let base = current.current;
      if (!base || base.document.id !== id || generation.current !== run)
        throw new Error("The workspace is no longer open.");
      let result: Outcome<T>;
      try { result = await operation(base); }
      catch (reason) {
        if (!(reason instanceof BeaverApiError) || reason.code !== "revision_conflict" || generation.current !== run)
          throw reason;
        base = await getResearchFile(id); current.current = base;
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
      const next = await actOnResearchFile(base.document.id, base.versionId,
        base.workingRevision, action); return { file: next, value: next };
    }), [enqueue]),
    query: useCallback((input) => enqueue(async (base) => {
      const value = await runResearchFileQuery(base.document.id, {
        ...input, versionId: base.versionId, workingRevision: base.workingRevision,
      }); return { file: value.file, value };
    }), [enqueue]),
  };
}
