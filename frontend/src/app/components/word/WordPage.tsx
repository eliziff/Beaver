import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { FileText } from "lucide-react";
import { ChatView } from "@/app/components/assistant/ChatView";
import { CollectionState } from "@/app/components/shared/CollectionState";
import { ChatHistoryProvider } from "@/app/contexts/ChatHistoryContext";
import { useAuth } from "@/app/contexts/AuthContext";
import { useAssistantChat } from "@/app/hooks/useAssistantChat";
import {
    executeWordClientTool,
    wordDocumentContext,
} from "@/app/lib/wordHost";

const wordClient = {
    context: wordDocumentContext,
    execute: executeWordClientTool,
};

function WordAssistant() {
    const [documentName, setDocumentName] = useState("Active document");
    const [hostError, setHostError] = useState<string | null>(null);
    const assistant = useAssistantChat({ stayInPlace: true, wordClient });

    useEffect(() => {
        let cancelled = false;
        void wordDocumentContext().then((context) => {
            if (!cancelled) setDocumentName(context.document_name);
        }).catch((error) => {
            if (!cancelled) setHostError(error instanceof Error
                ? error.message : "Word could not initialize.");
        });
        return () => { cancelled = true; };
    }, []);

    return (
        <main className="flex h-dvh min-w-0 flex-col bg-white">
            <header className="flex min-h-12 shrink-0 items-center gap-2 border-b border-gray-200 px-3">
                <FileText aria-hidden className="size-4 shrink-0 text-red-700" />
                <div className="min-w-0">
                    <h1 className="truncate text-sm font-semibold text-gray-900">Beaver for Word</h1>
                    <p className="truncate text-[11px] text-gray-500">{documentName}</p>
                </div>
            </header>
            {hostError ? (
                <section className="m-auto max-w-sm p-6 text-center">
                    <h2 className="font-serif text-xl text-gray-900">Word is not connected</h2>
                    <p className="mt-2 text-sm leading-6 text-gray-600" role="alert">
                        {hostError}
                    </p>
                </section>
            ) : (
                <div className="min-h-0 flex-1">
                    <ChatView
                        chatId={assistant.state.chatId}
                        session={assistant.state}
                        handleChat={assistant.actions.handleChat}
                        cancel={assistant.actions.cancel}
                        onRejectedTurnRestored={assistant.actions.clearRejectedTurn}
                        onRetryRejectedTurn={() => void assistant.actions.retryRejectedTurn()}
                        layout="panel"
                        features={{ contextTools: false, dock: false, researchSave: false }}
                        editModeLabels={{ manual: "Review", auto: "Direct" }}
                    />
                </div>
            )}
        </main>
    );
}

export function WordPage() {
    const { authLoading, isAuthenticated } = useAuth();
    if (authLoading) return <CollectionState loading className="min-h-dvh">Loading…</CollectionState>;
    if (!isAuthenticated) {
        return <Navigate to="/login?next=%2Fword.html&surface=word" replace />;
    }
    return <ChatHistoryProvider><WordAssistant /></ChatHistoryProvider>;
}
