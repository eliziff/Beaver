"use client";

import { useEffect, useState } from "react";
import { Loader2, Trash2, User } from "lucide-react";
import type { ProjectPeople } from "@/app/lib/beaverApi";
import { AddUserInput } from "../shared/AddUserInput";
import { NativeActionSelect } from "../ui/native-action-select";
import { Modal } from "./Modal";

interface SharedResource {
    id: string;
    shared_with?: string[] | null;
    owner_display_name?: string | null;
    owner_email?: string | null;
}

interface Props {
    open: boolean;
    onClose: () => void;
    resource: SharedResource | null;
    fetchPeople: (id: string) => Promise<ProjectPeople>;
    currentUserEmail?: string | null;
    breadcrumb: string[];
    onSharedWithChange?: (sharedWith: string[]) => Promise<void> | void;
}

type RosterRow = {
    email: string | null;
    user_id?: string | null;
    display_name: string | null;
    role: "owner" | "member";
};

export function PeopleModal({
    open,
    onClose,
    resource,
    fetchPeople,
    currentUserEmail,
    breadcrumb,
    onSharedWithChange,
}: Props) {
    const [busy, setBusy] = useState<"add" | "remove" | null>(null);
    const [removingEmail, setRemovingEmail] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const [people, setPeople] = useState<ProjectPeople | null>(null);
    const [lookupDisplayByEmail, setLookupDisplayByEmail] = useState<
        Map<string, string | null>
    >(new Map());
    const [peopleLoading, setPeopleLoading] = useState(false);
    const [loadedRosterKey, setLoadedRosterKey] = useState<string | null>(null);

    const resourceId = resource?.id ?? null;
    const sharedWith: string[] = Array.isArray(resource?.shared_with)
        ? resource.shared_with
        : [];

    useEffect(() => {
        if (!open) return;
        setError(null);
        setBusy(null);
        setRemovingEmail(null);
    }, [open]);

    const sharedKey = sharedWith
        .map((e) => e.toLowerCase())
        .sort()
        .join(",");
    const rosterKey = `${resourceId ?? ""}:${sharedKey}`;

    useEffect(() => {
        if (!open || !resourceId) return;
        let cancelled = false;
        setPeopleLoading(true);
        setPeople(null);
        setLoadedRosterKey(null);
        fetchPeople(resourceId)
            .then((data) => {
                if (cancelled) return;
                setPeople(data);
                setLoadedRosterKey(rosterKey);
            })
            .catch(() => {
                if (!cancelled) setLoadedRosterKey(rosterKey);
            })
            .finally(() => {
                if (!cancelled) setPeopleLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [open, resourceId, rosterKey, fetchPeople]);

    if (!open || !resource) return null;

    const memberDisplayByEmail = new Map<string, string | null>();
    for (const m of people?.members ?? []) {
        memberDisplayByEmail.set(m.email.toLowerCase(), m.display_name);
    }
    const ownerEmail =
        people?.owner.email?.trim().toLowerCase() ??
        resource.owner_email?.trim().toLowerCase() ??
        null;
    const ownerDisplayName =
        people?.owner.display_name ?? resource.owner_display_name ?? null;

    const roster: RosterRow[] = [];
    if (people?.owner || ownerEmail || ownerDisplayName) {
        roster.push({
            email: ownerEmail,
            user_id: people?.owner.user_id ?? null,
            display_name: ownerDisplayName,
            role: "owner",
        });
    }
    for (const email of sharedWith) {
        const lower = email.toLowerCase();
        if (ownerEmail && lower === ownerEmail.toLowerCase()) continue;
        roster.push({
            email,
            display_name:
                memberDisplayByEmail.get(lower) ??
                lookupDisplayByEmail.get(lower) ??
                null,
            role: "member",
        });
    }

    const normalizedCurrentUserEmail =
        currentUserEmail?.trim().toLowerCase() ?? null;
    const sharedLower = sharedWith.map((e) => e.toLowerCase());
    const rosterPending = peopleLoading || loadedRosterKey !== rosterKey;

    function validateNewEmail(email: string) {
        if (sharedLower.includes(email)) return `${email} already has access.`;
        if (ownerEmail && email === ownerEmail.toLowerCase()) {
            return `${email} is the owner.`;
        }
        if (
            normalizedCurrentUserEmail &&
            email === normalizedCurrentUserEmail
        ) {
            return "You cannot share this with yourself.";
        }
        return null;
    }

    async function handleAddUser(user: {
        email: string;
        display_name: string | null;
    }) {
        setLookupDisplayByEmail((prev) => {
            const next = new Map(prev);
            next.set(user.email.trim().toLowerCase(), user.display_name);
            return next;
        });
        await handleAdd(user.email);
    }

    async function handleAdd(email: string) {
        if (!onSharedWithChange || busy !== null) return;
        setBusy("add");
        setError(null);
        try {
            const next = [...sharedWith, email];
            await onSharedWithChange(next);
        } catch (e) {
            throw new Error(
                e instanceof Error
                    ? e.message
                    : "Couldn't add the member. Try again.",
            );
        } finally {
            setBusy(null);
        }
    }

    async function handleRemove(email: string) {
        if (!onSharedWithChange || busy !== null) return;
        setBusy("remove");
        setRemovingEmail(email);
        setError(null);
        try {
            const next = sharedWith.filter(
                (e) => e.toLowerCase() !== email.toLowerCase(),
            );
            await onSharedWithChange(next);
        } catch (e) {
            setError(
                e instanceof Error
                    ? e.message
                    : "Couldn't remove the member. Try again.",
            );
        } finally {
            setBusy(null);
            setRemovingEmail(null);
        }
    }

    return (
        <Modal open={open} onClose={onClose} breadcrumbs={breadcrumb}>
            <div className="flex min-h-0 flex-1 flex-col gap-5 pb-5">
                {onSharedWithChange && (
                    <section className="space-y-2">
                        <AddUserInput
                            onAdd={handleAddUser}
                            validateEmail={validateNewEmail}
                            busy={busy === "add"}
                            placeholder="Add by email..."
                            autoFocus
                            submitLabel="Add member"
                            className="bg-white focus-within:bg-white"
                        />
                        {error && (
                            <p className="mt-1.5 text-xs text-red-500">
                                {error}
                            </p>
                        )}
                    </section>
                )}

                <section className="flex min-h-0 flex-1 flex-col">
                    <div className="mb-2 flex items-center gap-2">
                        <h3 className="text-xs font-medium text-gray-500">
                            People with Access
                        </h3>
                        {peopleLoading && (
                            <Loader2 className="h-3 w-3 animate-spin text-gray-400" />
                        )}
                    </div>

                    {rosterPending ? (
                        <div className="min-h-0 flex-1 space-y-1">
                            {[1, 2].map((item) => (
                                <div
                                    key={item}
                                    className="flex items-center gap-2.5 rounded-lg px-2 py-1.5"
                                >
                                    <div className="h-6 w-6 shrink-0 rounded-full bg-gray-100" />
                                    <div className="min-w-0 flex-1">
                                        <div className="h-3 w-40 rounded bg-gray-100" />
                                    </div>
                                    <div className="h-4 w-12 shrink-0 rounded-full bg-gray-100" />
                                </div>
                            ))}
                        </div>
                    ) : roster.length === 0 ? (
                        <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-gray-400">
                            No one has access yet.
                        </div>
                    ) : (
                        <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto">
                            {roster.map((entry) => {
                                const entryEmail = entry.email ?? "";
                                const rowKey =
                                    entry.email ??
                                    entry.user_id ??
                                    `${entry.role}-unknown`;
                                const isYou =
                                    !!currentUserEmail &&
                                    !!entryEmail &&
                                    entryEmail.toLowerCase() ===
                                        currentUserEmail.toLowerCase();
                                const isRemoving =
                                    busy === "remove" &&
                                    removingEmail === entryEmail;
                                const displayName = entry.display_name?.trim();
                                const primary = isYou
                                    ? "You"
                                    : displayName || entryEmail || "User";
                                const showEmail =
                                    !isYou && !!displayName && !!entryEmail;
                                const initial = displayName
                                    ?.charAt(0)
                                    .toUpperCase();
                                return (
                                    <li
                                        key={`${entry.role}-${rowKey}`}
                                        className="group relative flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-gray-100/70"
                                    >
                                        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-700 shadow-sm">
                                            {initial ? (
                                                <span className="font-serif text-[11px] leading-none">
                                                    {initial}
                                                </span>
                                            ) : (
                                                <User className="h-2.5 w-2.5" />
                                            )}
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <p className="truncate text-xs text-gray-800">
                                                {primary}
                                                {showEmail && (
                                                    <span className="text-gray-400">
                                                        {" "}
                                                        · {entry.email}
                                                    </span>
                                                )}
                                            </p>
                                        </div>
                                        {entry.role === "owner" && (
                                            <span className="shrink-0 rounded-full px-2 py-1 text-xs text-gray-400">
                                                Owner
                                            </span>
                                        )}
                                        {entry.role === "member" && (
                                            <div className="flex shrink-0 items-center">
                                                <span className="rounded-full px-2 py-1 text-xs text-gray-400">
                                                    Member
                                                </span>
                                                <span
                                                    className="inline-flex h-6 w-6"
                                                    dir="rtl"
                                                >
                                                    {onSharedWithChange && (
                                                        <NativeActionSelect
                                                            label={`Remove access for ${entryEmail}`}
                                                            placeholder="Choose"
                                                            items={[
                                                                {
                                                                    label: "Remove access",
                                                                    onSelect: () =>
                                                                        void handleRemove(
                                                                            entryEmail,
                                                                        ),
                                                                    disabled:
                                                                        busy !==
                                                                        null,
                                                                },
                                                            ]}
                                                            className="h-full w-full"
                                                            triggerClassName="h-6 w-6 items-center justify-center rounded-full text-xs leading-none text-gray-500 hover:bg-gray-200 hover:text-gray-800 peer-disabled:opacity-50"
                                                        >
                                                            {isRemoving ? (
                                                                <Loader2 className="h-3 w-3 animate-spin" />
                                                            ) : (
                                                                <Trash2 className="h-3.5 w-3.5" />
                                                            )}
                                                        </NativeActionSelect>
                                                    )}
                                                </span>
                                            </div>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </section>
            </div>
        </Modal>
    );
}
