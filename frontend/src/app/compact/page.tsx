import { CompactApp } from "@/app/components/compact/CompactApp";
import { ChatHistoryProvider } from "@/app/contexts/ChatHistoryContext";

export default function CompactPage() {
    return (
        <ChatHistoryProvider>
            <CompactApp />
        </ChatHistoryProvider>
    );
}
