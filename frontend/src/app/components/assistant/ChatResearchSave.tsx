import { useNavigate } from "react-router-dom";
import { ResearchViews } from "../shared/ResearchViews";
import { useSourcesWorkspace } from "../legal/SourcesWorkspace";
import { tabularReviewPath } from "../tabular/tabularReviewRoute";

export function ChatResearchSave({ chatId, projectId }: { chatId: string; projectId?: string }) {
  const workspace = useSourcesWorkspace(), navigate = useNavigate();
  async function open(view: "workspace" | "table") {
    const file = await workspace.ensure({ chatId, projectId });
    if (view === "workspace") navigate(`/sources?research_file=${encodeURIComponent(file.document.id)}`);
    else navigate(tabularReviewPath(await workspace.table({ chatId })));
  }
  return <ResearchViews workspace={() => open("workspace")} table={() => open("table")} />;
}
