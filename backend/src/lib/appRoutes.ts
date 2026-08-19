export type BeaverAppTarget =
  | { kind: "project"; id: string }
  | {
      kind: "library-document";
      libraryKind?: "file" | "template";
      projectId?: string | null;
    }
  | { kind: "legal-source"; id: string }
  | {
      kind: "authorities";
      jobId?: string | null;
      projectId?: string | null;
    }
  | { kind: "tabular-review"; id: string; projectId?: string | null }
  | {
      kind: "workflow";
      id: string;
      workflowType: "assistant" | "tabular";
    }
  | { kind: "chat"; id: string; projectId?: string | null };

function identifier(value: string) {
  const id = value.trim();
  if (!id) throw new Error("A Beaver app route requires an id");
  return id;
}

function segment(value: string) {
  const id = identifier(value);
  return encodeURIComponent(id);
}

/** Builds only routes backed by real Beaver pages. */
export function appUrl(target: BeaverAppTarget): string {
  if (target.kind === "project") return `/projects/${segment(target.id)}`;
  if (target.kind === "library-document") {
    return target.projectId
      ? appUrl({ kind: "project", id: target.projectId })
      : target.libraryKind === "template"
        ? "/library/templates"
        : "/library";
  }
  if (target.kind === "legal-source") {
    return `/sources/${segment(target.id)}`;
  }
  if (target.kind === "authorities") {
    const query = new URLSearchParams();
    if (target.jobId) query.set("job", identifier(target.jobId));
    if (target.projectId) query.set("project", identifier(target.projectId));
    const suffix = query.toString();
    return suffix ? `/table-of-authorities?${suffix}` : "/table-of-authorities";
  }
  if (target.kind === "tabular-review") {
    const review = `tabular-reviews/${segment(target.id)}`;
    return target.projectId
      ? `/projects/${segment(target.projectId)}/${review}`
      : `/${review}`;
  }
  if (target.kind === "workflow") {
    const type =
      target.workflowType === "assistant" ? "assistant" : "tabular-review";
    return `/workflows/${type}/${segment(target.id)}`;
  }
  return target.projectId
    ? `/projects/${segment(target.projectId)}/assistant/chat/${segment(target.id)}`
    : `/assistant/chat/${segment(target.id)}`;
}
