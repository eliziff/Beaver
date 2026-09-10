import { researchLabelPath, type ResearchLabel } from "@/app/lib/researchFiles";

export const researchLabelColor = (label: ResearchLabel) => label.color ??
  (label.scope === "highlight" ? "#eab308" : "#3498db");

/** A folder's width, kept just past its height — never the squat billboard it used to be (Eli, 2026-09-09). */
const BOX = { sm: "h-3.5 w-4", md: "h-4 w-5", lg: "h-6 w-7" };
/** Three tab slots: one per generation, filled left to right, so depth is countable at a glance. */
const TABS = 3;
/** One folder as a binder: the root label paints the body, every layer below it adds a tab sheet, in order. */
export function ResearchLabelFolder({ labels, labelId, size = "md" }: {
  labels: Record<string, ResearchLabel>; labelId: string | null; size?: keyof typeof BOX }) {
  const path = labelId ? researchLabelPath(labels, labelId) : [];
  // Filled in the label's own colour, not outlined; a blank folder keeps the full size in grey.
  const tabs = path.slice(0, TABS), width = 100 / TABS, blank = "#d1d5db";
  return <span aria-hidden data-label-folder={path.at(-1)?.id} data-label-depth={path.length}
    className={`relative block ${BOX[size]} shrink-0`}>
    {(path.length ? tabs : [null]).map((label, index) => <span key={label?.id ?? "blank"} className="absolute top-0 h-[42%] rounded-t-[2px]"
      style={{ backgroundColor: label ? researchLabelColor(label) : blank, width: `calc(${width}% - 1px)`, insetInlineStart: `${index * width}%` }} />)}
    <span className="absolute inset-x-0 bottom-0 top-[26%] rounded-[3px]" style={{ backgroundColor: path[0] ? researchLabelColor(path[0]) : blank }} />
  </span>;
}

/** A source's filing at a glance: ONE binder — never two folders beside each other — and a count
 *  of the other places it is filed. The tooltip names them all. */
export function ResearchLabelMarker({ labels, labelIds, size = "md" }: {
  labels: Record<string, ResearchLabel>; labelIds: string[]; size?: keyof typeof BOX }) {
  const applied = labelIds.filter((id) => labels[id]).sort((a, b) =>
    researchLabelPath(labels, b).length - researchLabelPath(labels, a).length);
  const names = applied.map((id) => researchLabelPath(labels, id).map(({ name }) => name).join(" / "));
  return <span role="group" aria-label={names.length ? `Labels: ${names.join(", ")}` : "No labels"}
    title={names.join(" · ") || undefined} data-empty={applied.length ? undefined : "true"}
    className={`inline-flex shrink-0 items-center justify-center gap-0.5 ${size === "sm" ? "w-7" : size === "md" ? "w-8" : "w-11"}`}>
    <ResearchLabelFolder labels={labels} labelId={applied[0] ?? null} size={size} />
    {applied.length > 1 && <span className="text-[10px] leading-none text-gray-500">+{applied.length - 1}</span>}
  </span>;
}
