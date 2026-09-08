import type { ColumnConfig, TabularCell } from "@/app/lib/api/tabular";
import type { Citation } from "@/app/lib/citations";
import { evidenceCitation } from "@/app/lib/groundedAnswers";
import { CitationPill } from "../assistant/message/MarkdownContent";
import { FLAGS, FlagDot } from "../shared/GroundedAnswerContent";
import { TabularMarkdown } from "./TabularMarkdown";

/** Support is shown as ordinary citation pills, one per cited passage, exactly as chat answers show it. */
export function TabularResultDetails({ answer, column, onCitation }: {
  answer: NonNullable<TabularCell["content"]>; column: ColumnConfig; onCitation: (citation: Citation, action?: "workspace") => void;
}) {
  const byId = new Map(answer.evidence.map((item) => [item.evidence_id, item]));
  const cited = new Map<string, Citation>();
  for (const id of new Set(answer.claims.flatMap(({ evidence_ids }) => evidence_ids))) {
    const receipt = byId.get(id), citation = receipt ? evidenceCitation(receipt, cited.size + 1) : null;
    if (citation) cited.set(id, citation);
  }
  const citations = [...cited.values()];
  const withRefs = ({ text, evidence_ids }: { text: string; evidence_ids: string[] }) =>
    `${text}${[...new Set(evidence_ids)].flatMap((id) => cited.has(id) ? [`[${cited.get(id)!.ref}]`] : []).join("")}`;
  const summary = answer.summary || (answer.value == null ? "" : Array.isArray(answer.value) ? answer.value.join(", ") : String(answer.value));
  const claims = answer.claims.filter((claim) => claim.text.trim() !== summary.trim());
  // Cells mapped from existing research are that research, not a model answer about it.
  const reused = !!answer.origin?.items?.length;
  return <div className="space-y-4 text-sm leading-6 text-gray-700 [overflow-wrap:anywhere]">
    <section aria-label={reused ? "Result" : "Answer"}>
      {!reused && <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <h3 className="font-medium text-gray-500">Answer</h3>
        {answer.flag && <span className="inline-flex items-center gap-1.5"><FlagDot flag={answer.flag} />{FLAGS[answer.flag].meaning}</span>}
      </div>}
      {summary ? <TabularMarkdown text={summary} value={answer.value} column={column} onCitationClick={onCitation} />
        : answer.outcome === "not_found" ? <p>No answer found in the reviewed material.</p> : null}
      {/* Claims carry their own pills; a separate row would repeat them. */}
      {!!citations.length && !claims.length && <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {citations.map((citation) => <CitationPill key={citation.ref} citation={citation} onClick={onCitation} />)}
      </div>}
    </section>
    {!!claims.length && <section aria-label={reused ? "Detail" : "Explanation"} className="space-y-2">
      {!reused && <h3 className="text-xs font-medium text-gray-500">Explanation</h3>}
      {claims.map((claim, index) => <TabularMarkdown key={index} text={withRefs(claim)} citations={citations} onCitationClick={onCitation} />)}
    </section>}
  </div>;
}
