import { ThinkingSpinner } from "@/app/components/chat/thinking-spinner";

export type StatusState = "active" | "error" | null;

export function ResponseStatus({ status }: { status: StatusState }) {
    return (
        <div className="w-full h-9 flex items-center mb-2">
            {status === "active" && <ThinkingSpinner size={18} />}
        </div>
    );
}
