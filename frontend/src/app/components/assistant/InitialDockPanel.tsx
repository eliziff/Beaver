import { AssistantWorkflowDock } from "./AssistantWorkflowDock";
import { DocumentWorkflowMenu } from "../documents/DocumentWorkflowMenu";
import { LegalLibraryPage } from "../legal/LegalLibrary";
import {
    LibraryCollectionPage,
    LibraryWorkspaceProvider,
} from "../library/LibraryWorkspace";
import type { LibraryKind } from "@/app/lib/beaverApi";
import type { Document } from "../shared/types";
import type { WorkflowSelection } from "../workflows/workflowRoutes";

export function InitialDockPanel({ tab, libraryKind, workflowDocument,
    onLibraryKindChange, onOpenInChat, onWorkflowSelect }: {
    tab: "library" | "workflows" | "sources";
    libraryKind: LibraryKind;
    workflowDocument: Document | null;
    onLibraryKindChange: (kind: LibraryKind) => void;
    onOpenInChat: (documents: Document[]) => void;
    onWorkflowSelect: (selection: WorkflowSelection) => void;
}) {
    if (tab === "library") return (
        <LibraryWorkspaceProvider>
            <LibraryCollectionPage kind={libraryKind}
                onKindChange={onLibraryKindChange}
                onOpenInChat={onOpenInChat} embedded />
        </LibraryWorkspaceProvider>
    );
    if (tab === "sources") return <LegalLibraryPage embedded />;
    return workflowDocument
        ? <DocumentWorkflowMenu document={workflowDocument} embedded />
        : <AssistantWorkflowDock onSelect={onWorkflowSelect} />;
}
