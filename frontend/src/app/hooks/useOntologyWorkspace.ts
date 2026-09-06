import { useCallback, useEffect, useState } from "react";
import { ensureOntologyWorkspace, getOntologyWorkspace } from "@/app/lib/api/ontology";

/** Resolves the labels ontology workspace id, creating it on demand. */
export function useOntologyWorkspace(projectId?: string | null) {
  const [ontologyId, setOntologyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getOntologyWorkspace(projectId ?? null).then((file) => {
      if (!cancelled) { setOntologyId(file?.document.id ?? null); setLoading(false); }
    }, () => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId]);
  const ensure = useCallback(async () => {
    const file = await ensureOntologyWorkspace(projectId ?? null);
    setOntologyId(file.document.id);
    return file.document.id;
  }, [projectId]);
  return { ontologyId, loading, ensure };
}
