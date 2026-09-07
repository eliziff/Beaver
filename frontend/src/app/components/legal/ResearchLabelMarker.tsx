import { researchLabelPath, type ResearchLabel } from "@/app/lib/researchFiles";
import { FolderSvgIcon } from "../shared/FolderSvgIcon";

export const researchLabelColor = (label: ResearchLabel) => label.color ??
  (label.scope === "highlight" ? "#eab308" : "#3498db");

const BOX = { sm: "h-3.5 w-4", md: "h-4 w-5", lg: "h-6 w-7" };

/** One folder: the top label paints the body, its sublabels the tab and the inner band. */
export function ResearchLabelFolder({ labels, labelId, size = "md" }: {
  labels: Record<string, ResearchLabel>; labelId: string | null; size?: keyof typeof BOX }) {
  const path = labelId ? researchLabelPath(labels, labelId) : [];
  if (!path.length) return <span aria-hidden className={`${BOX[size]} grid shrink-0 place-items-center`}><FolderSvgIcon className="size-3.5 text-gray-400" /></span>;
  const body = researchLabelColor(path[0]);
  return <span aria-hidden data-label-folder={path.at(-1)!.id} className={`relative block ${BOX[size]} shrink-0`}>
    <span className="absolute inset-x-0 bottom-0 top-[30%] rounded-[3px] rounded-ss-none" style={{ background: body }} />
    <span className="absolute start-0 top-0 h-[38%] w-[55%] rounded-t-[2px]"
      style={{ background: path[1] ? researchLabelColor(path[1]) : body }} />
    {!!path[2] && <span className="absolute bottom-[20%] end-[10%] h-[24%] w-[45%] rounded-[1px]"
      style={{ background: researchLabelColor(path[2]) }} />}
  </span>;
}

/** A source's filing at a glance: its folders, in a slot that never changes width. */
export function ResearchLabelMarker({ labels, labelIds, size = "md" }: {
  labels: Record<string, ResearchLabel>; labelIds: string[]; size?: keyof typeof BOX }) {
  const applied = labelIds.filter((id) => labels[id]);
  const names = applied.map((id) => researchLabelPath(labels, id).map(({ name }) => name).join(" / "));
  return <span role="group" aria-label={names.length ? `Labels: ${names.join(", ")}` : "No labels"}
    data-empty={applied.length ? undefined : "true"}
    className={`inline-flex shrink-0 items-center gap-0.5 ${size === "sm" ? "w-9" : size === "md" ? "w-11" : ""}`}>
    {applied.length ? applied.slice(0, 2).map((id) => <ResearchLabelFolder key={id} labels={labels} labelId={id} size={size} />)
      : <ResearchLabelFolder labels={labels} labelId={null} size={size} />}
    {applied.length > 2 && <span className="text-[10px] leading-none text-gray-500">+{applied.length - 2}</span>}
  </span>;
}
