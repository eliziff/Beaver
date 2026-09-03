import { ContextualWorkflowPicker } from "../workflows/ContextualWorkflowPicker";
import { LegalLibraryPage } from "../legal/LegalLibrary";
import {
    LibraryCollectionPage,
    LibraryWorkspaceProvider,
} from "../library/LibraryWorkspace";
import type { LibraryKind } from "@/app/lib/beaverApi";
import type { Document } from "../shared/types";
import type { WorkflowSelection } from "../workflows/workflowRoutes";
import type { WorkflowDocument } from "../workflows/ContextualWorkflowPicker";
import type { ResearchFile } from "@/app/lib/researchFiles";
import type { LegalSourceTab } from "../legal/LegalSourceViewer";

export function InitialDockPanel({ tab, libraryKind, workflowDocuments,
    onLibraryKindChange, onOpenInChat, onOpenWorkflows, onWorkflowSelect,
    initialWorkflowId, projectId, onResearchFileChange, onOpenSource }: {
    tab: "library" | "workflows" | "sources";
    libraryKind: LibraryKind;
    workflowDocuments: WorkflowDocument[];
    onLibraryKindChange: (kind: LibraryKind) => void;
    onOpenInChat: (documents: Document[]) => void;
    onOpenWorkflows: (documents: Document[]) => void;
    onWorkflowSelect: (selection: WorkflowSelection) => void;
    initialWorkflowId?: string;
    projectId?: string;
    onResearchFileChange?: (file: ResearchFile | null) => void;
    onOpenSource?: (tab: LegalSourceTab) => void;
}) {
    if (tab === "library") return (
        <LibraryWorkspaceProvider>
            <LibraryCollectionPage kind={libraryKind}
                onKindChange={onLibraryKindChange}
                onOpenInChat={onOpenInChat}
                onOpenWorkflows={onOpenWorkflows} embedded />
        </LibraryWorkspaceProvider>
    );
    if (tab === "sources") return <LegalLibraryPage embedded projectId={projectId}
        onResearchFileChange={onResearchFileChange} onOpenSource={onOpenSource} />;
    return <ContextualWorkflowPicker documents={workflowDocuments}
        initialWorkflowId={initialWorkflowId}
        onAssistantSelect={onWorkflowSelect} className="p-3" />;
}
