import type { AssistantChatLoad } from "@/app/hooks/useAssistantChat";
import { Button } from "../ui/button";

export function ChatLoadingState({ load, onRetry }: {
    load: AssistantChatLoad;
    onRetry: () => void;
}) {
    if (load.status === "loaded") return null;
    return <div className={`absolute inset-0 z-40 flex flex-col items-center justify-center gap-3 text-sm text-gray-500 ${load.status === "error" ? "bg-white" : ""}`}>
        {load.status === "error" ? <>
            <p role="alert">Could not load this conversation.</p>
            <Button variant="outline" size="compact" onClick={onRetry}>Try again</Button>
        </> : <p role="status">Loading conversation…</p>}
    </div>;
}
