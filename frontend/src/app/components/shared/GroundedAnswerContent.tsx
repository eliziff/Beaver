import type { Citation } from "@/app/lib/citations";
import type { ColumnConfig, TabularCell } from "@/app/lib/api/tabular";
import { groundedAnswerMarkdown } from "@/app/lib/groundedAnswers";
import { TabularMarkdown } from "../tabular/TabularMarkdown";

const FLAGS = { green: "bg-emerald-600", grey: "bg-slate-500", yellow: "bg-amber-600", red: "bg-red-600" };
export function GroundedAnswerContent({ answer, column, onCitation }: {
  answer: NonNullable<TabularCell["content"]>; column: ColumnConfig; onCitation: (citation: Citation) => void;
}) {
  const grounded = groundedAnswerMarkdown(answer);
  return <div className="space-y-3 text-xs leading-relaxed text-slate-600">
    {answer.flag && <span aria-label={`${answer.flag} flag`} className={`inline-flex rounded-full px-2 py-1 font-semibold text-white ${FLAGS[answer.flag]}`}>
      {answer.flag[0].toUpperCase() + answer.flag.slice(1)}</span>}
    {answer.summary && <TabularMarkdown text={answer.summary} value={answer.value} column={column} onCitationClick={onCitation} />}
    {answer.coverage === "partial" && <p role="status" className="text-amber-800">Source coverage is incomplete.</p>}
    <TabularMarkdown text={grounded.text} citations={grounded.citations} onCitationClick={onCitation} />
  </div>;
}
