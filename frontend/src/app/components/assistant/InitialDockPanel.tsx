import { ContextualWorkflowPicker } from "../workflows/ContextualWorkflowPicker";
import { LegalLibraryPage } from "../legal/LegalLibrary";
import {
    LibraryCollectionPage,
    LibraryWorkspaceProvider,
} from "../library/LibraryWorkspace";
import type { LibraryKind } from "@/app/lib/beaverApi";
import type { Document } from "../shared/types";
import type { WorkflowSelection } from "../workflows/workflowRoutes";

export function InitialDockPanel({ tab, libraryKind, workflowDocuments,
    onLibraryKindChange, onOpenInChat, onOpenWorkflows, onWorkflowSelect }: {
    tab: "library" | "workflows" | "sources";
    libraryKind: LibraryKind;
    workflowDocuments: Document[];
    onLibraryKindChange: (kind: LibraryKind) => void;
    onOpenInChat: (documents: Document[]) => void;
    onOpenWorkflows: (documents: Document[]) => void;
    onWorkflowSelect: (selection: WorkflowSelection) => void;
}) {
    if (tab === "library") return (
        <LibraryWorkspaceProvider>
            <LibraryCollectionPage kind={libraryKind}
                onKindChange={onLibraryKindChange}
                onOpenInChat={onOpenInChat}
                onOpenWorkflows={onOpenWorkflows} embedded />
        </LibraryWorkspaceProvider>
    );
    if (tab === "sources") return <LegalLibraryPage embedded />;
    return <ContextualWorkflowPicker documents={workflowDocuments}
        onAssistantSelect={onWorkflowSelect} className="p-3" />;
}
