import { useId, useState } from "react";
import type { KeyboardEvent } from "react";
import { Loader2, UserPlus } from "lucide-react";
import { lookupUserByEmail, type UserLookupResult } from "@/app/lib/api/account";
import { Button } from "@/app/components/ui/button";
import { cn } from "@/app/lib/utils";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
interface AddUserInputProps {
    onAdd: (user: UserLookupResult) => Promise<void> | void;
    validateEmail?: (email: string) => Promise<string | null> | string | null;
    busy?: boolean;
    placeholder?: string;
    autoFocus?: boolean;
    submitLabel?: string;
    className?: string;
}
export function AddUserInput({
    onAdd,
    validateEmail,
    busy = false,
    placeholder = "Add by email...",
    autoFocus = false,
    submitLabel = "Add user",
    className,
}: AddUserInputProps) {
    const [input, setInput] = useState("");
    const [checking, setChecking] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const errorId = useId();
    const trimmedEmail = input.trim().toLowerCase();
    async function commitUser() {
        const email = trimmedEmail;
        if (!email || busy || checking) return;
        if (!EMAIL_RE.test(email)) {
            setError("Enter a valid email.");
            return;
        }
        setError(null);
        setChecking(true);
        try {
            const validationError = await validateEmail?.(email);
            if (validationError) {
                setError(validationError);
                return;
            }
            const user = await lookupUserByEmail(email);
            if (!user.exists) {
                setError(`${email} does not belong to a Beaver user.`);
                return;
            }
            await onAdd(user);
            setInput("");
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "Could not add this user. Try again.",
            );
        } finally {
            setChecking(false);
        }
    }
    function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
        if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            void commitUser();
        }
    }
    return (
        <div>
            <div
                className={cn(
                    "flex min-h-10 items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-1.5 shadow-sm focus-within:ring-2 focus-within:ring-red-600 focus-within:ring-offset-1",
                    className,
                )}
            >
                <UserPlus aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                <input
                    type="email"
                    aria-label={placeholder}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? errorId : undefined}
                    value={input}
                    onChange={(event) => {
                        setInput(event.target.value);
                        setError(null);
                    }}
                    onKeyDown={handleKeyDown}
                    placeholder={placeholder}
                    className="min-w-0 flex-1 self-stretch bg-transparent text-sm text-gray-700 outline-none placeholder:text-gray-400"
                    autoFocus={autoFocus}
                />
                {!!trimmedEmail && (
                    <Button
                        size="compact"
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => void commitUser()}
                        disabled={busy || checking}
                        title={submitLabel}
                        aria-label={submitLabel}
                        className="h-6 shrink-0 px-2.5 text-[11px] leading-none"
                    >
                        {(busy || checking) && (
                            <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
                        )}
                        Add
                    </Button>
                )}
            </div>
            {error && <p id={errorId} role="alert" className="mt-1.5 text-xs text-red-700">{error}</p>}
        </div>
    );
}
