import { forwardRef, useImperativeHandle, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSourcesWorkspace } from "../legal/SourcesWorkspace";
import { ImportResearchSet } from "../tabular/ImportResearchSet";
import type { ChatInputHandle } from "./ChatInput";

export type ChatResearchFlowHandle = {
    openWorkspace: () => Promise<void>;
    openTable: () => Promise<void>;
};

/** Owns the "Open as" sub-flows for a chat: workspace or review table.
 *  Rendered always-mounted by ChatView so a chosen flow outlives the Organize modal. */
export const ChatResearchFlow = forwardRef<ChatResearchFlowHandle, {
    chatId: string; projectId?: string; question?: string; workspaceScope?: boolean;
    getModelPreferences?: ChatInputHandle["getModelPreferences"];
}>(function ChatResearchFlow({ chatId, projectId, question, getModelPreferences, workspaceScope = false }, ref) {
    const workspace = useSourcesWorkspace(), navigate = useNavigate();
    const [importing, setImporting] = useState<{ id: string; mode: "table" | "labels"; title: string;
        model?: string | null; reasoningEffort?: string | null } | null>(null);
    async function open(mode: "table" | "labels") {
        const file = workspaceScope && workspace.file ? workspace.file : await workspace.ensure({ chatId, projectId });
        setImporting({ id: file.document.id, mode, ...getModelPreferences?.(),
            title: (file.document.filename ?? "").replace(/\.research\.md$/iu, "") });
    }
    useImperativeHandle(ref, () => ({
        openWorkspace: () => open("labels"),
        openTable: () => open("table"),
    }), [chatId, getModelPreferences, projectId, workspace, workspaceScope]);
    return <ImportResearchSet open={!!importing} onClose={() => { setImporting(null); void workspace.refresh(); }} fileId={importing?.id}
        mode={importing?.mode} defaultRequest={question?.trim() || importing?.title}
        chatId={workspaceScope && importing?.mode === "labels" ? undefined : chatId}
        conversationId={workspaceScope ? chatId : undefined}
        projectId={projectId} onOpen={navigate} model={importing?.model}
        reasoningEffort={importing?.reasoningEffort} />;
});
