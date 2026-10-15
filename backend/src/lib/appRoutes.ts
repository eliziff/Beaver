export type BeaverAppTarget = { kind: "tabular-review"; id: string; projectId?: string | null };

const segment = (value: string) => {
  const id = value.trim();
  if (!id) throw new Error("A Beaver app route requires an id");
  return encodeURIComponent(id);
};

/** The Beaver page that shows a table, inside its project when it has one. */
export function appUrl(target: BeaverAppTarget): string {
  const review = `tabular-reviews/${segment(target.id)}`;
  return target.projectId ? `/projects/${segment(target.projectId)}/${review}` : `/${review}`;
}
