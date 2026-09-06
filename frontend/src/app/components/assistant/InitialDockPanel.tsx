import { ContextualWorkflowPicker } from "../workflows/ContextualWorkflowPicker";
import { LegalLibraryPage } from "../legal/LegalLibrary";
import {
    LibraryCollectionPage,
    LibraryWorkspaceProvider,
} from "../library/LibraryWorkspace";
import type { LibraryKind, Document } from "@/app/lib/api/documents";

import type { WorkflowSelection } from "../workflows/workflowRoutes";
import type { WorkflowDocument } from "../workflows/ContextualWorkflowPicker";
import type { ResearchFile } from "@/app/lib/researchFiles";
import type { LegalSourceTab } from "../legal/LegalSourceViewer";

export function InitialDockPanel({ tab, libraryKind, workflowDocuments,
    onLibraryKindChange, onOpenInChat, onOpenWorkflows, onWorkflowSelect,
    onRun, initialWorkflowId, projectId, onResearchFileChange, researchRefreshKey, researchFileId,
    onOpenSource, active = true }: {
    tab: "library" | "workflows" | "sources";
    libraryKind: LibraryKind;
    workflowDocuments: WorkflowDocument[];
    onLibraryKindChange: (kind: LibraryKind) => void;
    onOpenInChat: (documents: Document[]) => void;
    onOpenWorkflows: (documents: Document[]) => void;
    onWorkflowSelect: (selection: WorkflowSelection) => void;
    onRun?: React.ComponentProps<typeof ContextualWorkflowPicker>["onRun"];
    initialWorkflowId?: string;
    projectId?: string;
    onResearchFileChange?: (file: ResearchFile | null) => void;
    researchRefreshKey?: string | null;
    researchFileId?: string | null;
    onOpenSource?: (tab: LegalSourceTab) => void;
    active?: boolean;
}) {
    if (tab === "library") return (
        <LibraryWorkspaceProvider>
            <LibraryCollectionPage kind={libraryKind}
                active={active}
                onKindChange={onLibraryKindChange}
                onOpenInChat={onOpenInChat}
                onOpenWorkflows={onOpenWorkflows} embedded />
        </LibraryWorkspaceProvider>
    );
    if (tab === "sources") return <LegalLibraryPage embedded projectId={projectId}
        researchFileId={researchFileId}
        onResearchFileChange={onResearchFileChange} researchRefreshKey={researchRefreshKey}
        onOpenSource={onOpenSource} />;
    return <ContextualWorkflowPicker documents={workflowDocuments}
        initialWorkflowId={initialWorkflowId}
        onAssistantSelect={onWorkflowSelect} onRun={onRun} className="p-3" />;
}
