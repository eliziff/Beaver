"use client";
import { FormEvent, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAssistantChat } from "@/app/hooks/useAssistantChat";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import {
    getLibrary,
    uploadLibraryDocument,
} from "@/app/lib/beaverApi";
import type { Document, Message } from "@/app/components/shared/types";

type Tab = "assistant" | "library";

export function CompactApp() {
    const router = useRouter();
    const { user } = useAuth();
    const { profile } = useUserProfile();
    const [tab, setTab] = useState<Tab>("assistant");
    const [draft, setDraft] = useState("");
    const [library, setLibrary] = useState<Document[]>([]);
    const [libraryBusy, setLibraryBusy] = useState(false);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const {
        messages,
        chatId,
        isResponseLoading,
        handleChat,
        handleNewChat,
        cancel,
    } = useAssistantChat();
    const name =
        profile?.displayName?.trim() || user?.email?.split("@")[0] || "there";

    useEffect(() => {
        if (tab !== "library" || library.length) return;
        void getLibrary("files")
            .then(({ documents }) => setLibrary(documents))
            .catch(() => setLibrary([]));
    }, [library.length, tab]);

    async function submit(event: FormEvent) {
        event.preventDefault();
        const content = draft.trim();
        if (!content || isResponseLoading) return;
        setDraft("");
        const message: Message = { role: "user", content };
        if (chatId) await handleChat(message);
        else await handleNewChat(message);
    }

    async function upload(event: React.ChangeEvent<HTMLInputElement>) {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        setLibraryBusy(true);
        try {
            const uploaded = await uploadLibraryDocument("files", file);
            setLibrary((current) => [uploaded, ...current]);
        } finally {
            setLibraryBusy(false);
        }
    }

    return (
        <div className="flex h-full min-h-0 flex-col bg-white text-gray-950">
            <header className="flex h-14 shrink-0 items-center justify-between border-b border-gray-200 px-5">
                <Link href="/assistant" className="font-serif text-xl font-medium">
                    Beaver
                </Link>
                <nav className="flex items-center gap-1" aria-label="Primary">
                    <button
                        className={tab === "assistant" ? ACTIVE_TAB : TAB}
                        onClick={() => setTab("assistant")}
                    >
                        Assistant
                    </button>
                    <button
                        className={tab === "library" ? ACTIVE_TAB : TAB}
                        onClick={() => setTab("library")}
                    >
                        Library
                    </button>
                    <Link className={TAB} href="/table-of-authorities">
                        Authorities
                    </Link>
                    <Link className={TAB} href="/projects">
                        Projects
                    </Link>
                </nav>
            </header>
            <main className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col px-4 py-5">
                {tab === "library" ? (
                    <CompactLibrary
                        documents={library}
                        busy={libraryBusy}
                        onUpload={upload}
                    />
                ) : (
                    <section className="flex min-h-0 flex-1 flex-col">
                        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                            {messages.length === 0 ? (
                                <div className="flex h-full items-center justify-center">
                                    <h1 className="font-serif text-3xl font-medium">
                                        Hi, {name}
                                    </h1>
                                </div>
                            ) : (
                                <div className="space-y-5">
                                    {messages.map((message, index) =>
                                        message.role === "user" ? (
                                            <p
                                                key={message.id ?? index}
                                                className="ml-auto max-w-[75%] rounded-2xl bg-gray-950 px-4 py-3 text-sm text-white"
                                            >
                                                {message.content}
                                            </p>
                                        ) : (
                                            <div
                                                key={message.id ?? index}
                                                className="max-w-[90%] text-sm leading-6"
                                            >
                                                {message.events?.map((event, eventIndex) => (
                                                    <p key={eventIndex} className="text-xs text-gray-600">
                                                        {eventText(event)}
                                                    </p>
                                                ))}
                                                {message.content && <p>{message.content}</p>}
                                            </div>
                                        ),
                                    )}
                                </div>
                            )}
                        </div>
                        <form onSubmit={submit} className="mt-4 flex shrink-0 gap-2">
                            <textarea
                                ref={inputRef}
                                value={draft}
                                onChange={(event) => setDraft(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter" && !event.shiftKey) {
                                        event.preventDefault();
                                        event.currentTarget.form?.requestSubmit();
                                    }
                                }}
                                rows={2}
                                placeholder="Ask Beaver…"
                                aria-label="Message Beaver"
                                className="min-h-12 min-w-0 flex-1 resize-none rounded-lg border border-gray-400 px-3 py-2 text-sm outline-none focus:border-red-700 focus:ring-1 focus:ring-red-700"
                            />
                            {isResponseLoading ? (
                                <button type="button" onClick={cancel} className={STOP}>
                                    Stop
                                </button>
                            ) : (
                                <button type="submit" disabled={!draft.trim()} className={SEND}>
                                    Send
                                </button>
                            )}
                        </form>
                    </section>
                )}
            </main>
        </div>
    );
}

function CompactLibrary({
    documents,
    busy,
    onUpload,
}: {
    documents: Document[];
    busy: boolean;
    onUpload: (event: React.ChangeEvent<HTMLInputElement>) => void;
}) {
    return (
        <section className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center justify-between gap-3">
                <h1 className="font-serif text-2xl font-medium">Library</h1>
                <label className={SEND}>
                    {busy ? "Uploading…" : "Upload"}
                    <input className="sr-only" type="file" onChange={onUpload} disabled={busy} />
                </label>
            </div>
            <div className="mt-4 min-h-0 overflow-y-auto rounded-lg border border-gray-300">
                {documents.length ? (
                    documents.map((document) => (
                        <button
                            type="button"
                            key={document.id}
                            className="flex w-full items-center justify-between border-b border-gray-200 px-4 py-3 text-left text-sm last:border-0 hover:bg-red-50"
                        >
                            <span className="min-w-0 truncate">{document.filename}</span>
                            <span className="ml-4 shrink-0 text-xs text-gray-600">
                                {document.file_type ?? "file"}
                            </span>
                        </button>
                    ))
                ) : (
                    <p className="p-6 text-sm text-gray-600">No documents yet.</p>
                )}
            </div>
        </section>
    );
}

const TAB = "rounded-md px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-100";
const ACTIVE_TAB = `${TAB} bg-red-50 font-medium text-red-800`;
const SEND = "inline-flex h-10 items-center justify-center rounded-md border border-gray-950 bg-gray-950 px-4 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40";
const STOP = "inline-flex h-10 items-center justify-center rounded-md border border-red-700 px-4 text-sm font-medium text-red-800 hover:bg-red-50";

function eventText(event: NonNullable<Message["events"]>[number]) {
    if (event.type === "reasoning") return event.text;
    if (event.type === "error") return event.message;
    if (event.type === "tool_call_start") return `Using ${event.name}`;
    if (event.type === "thinking") return "Working…";
    if (event.type === "doc_read") return `Read ${event.filename}`;
    if (event.type === "doc_created") return `Created ${event.filename}`;
    if (event.type === "doc_edited") return `Edited ${event.filename}`;
    return event.type.replaceAll("_", " ");
}
