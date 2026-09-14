import type { ReactNode } from "react";
import { BookOpenText, FileSpreadsheet } from "lucide-react";
import { FolderSvgIcon } from "@/app/components/shared/FolderSvgIcon";
import { Modal } from "../modals/Modal";

type OrganizeOption = { label: string; description: string; icon: ReactNode; onSelect: () => void };

function OptionCard({ option }: { option: OrganizeOption }) {
    return <button type="button" onClick={option.onSelect}
        className="group flex w-full items-start gap-3 rounded-xl border border-gray-200 bg-white p-3 text-left transition-colors hover:border-gray-300 hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-gray-100 text-gray-600 group-hover:bg-white group-hover:text-gray-900">
            {option.icon}
        </span>
        <span className="min-w-0">
            <span className="block text-sm font-medium text-gray-900">{option.label}</span>
            <span className="mt-0.5 block text-xs leading-5 text-gray-500">{option.description}</span>
        </span>
    </button>;
}

/** Intermediate chooser between the chat and its destinations. */
export function OrganizeChatModal({ open, onClose, projectName, onAddToProject, openAs }: {
    open: boolean;
    onClose: () => void;
    projectName?: string | null;
    onAddToProject?: () => void;
    openAs: OrganizeOption[];
}) {
    return <Modal open={open} onClose={onClose} size="lg" fit breadcrumbs={["Organize"]}>
        <div className="my-auto grid gap-6">
            <p className="max-w-prose text-sm leading-6 text-gray-600">
                Choose where this chat's work lives and what you want to make of it.
                Nothing is created until you pick one of the options below.
            </p>
            <div className="grid gap-6 sm:grid-cols-2">
                <section>
                    <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
                        Project
                    </h3>
                    <p className="mb-2 text-xs leading-5 text-gray-500">
                        Projects group the chats, documents, and research for one matter.
                    </p>
                    <button type="button" onClick={onAddToProject} disabled={!onAddToProject}
                        className="group flex w-full items-start gap-3 rounded-xl border border-gray-200 bg-white p-3 text-left transition-colors hover:border-gray-300 hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900 disabled:opacity-60">
                        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-amber-50 text-amber-700 group-hover:bg-amber-100">
                            <FolderSvgIcon className="size-4" />
                        </span>
                        <span className="min-w-0">
                            <span className="block truncate text-sm font-medium text-gray-900">
                                {projectName ?? "Add to project"}
                            </span>
                            <span className="mt-0.5 block text-xs leading-5 text-gray-500">
                                {projectName
                                    ? "Move this chat to another project."
                                    : "File this chat under a project so it sits with the matter."}
                            </span>
                        </span>
                    </button>
                </section>
                {openAs.length > 0 && <section>
                    <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
                        Open as
                    </h3>
                    <p className="mb-2 text-xs leading-5 text-gray-500">
                        Reuse this chat's research in another working format.
                    </p>
                    <div className="grid gap-2">
                        {openAs.map((option) => <OptionCard key={option.label} option={option} />)}
                    </div>
                </section>}
            </div>
        </div>
    </Modal>;
}

export const organizeOpenAsIcons = {
    workspace: <BookOpenText className="size-4" aria-hidden="true" />,
    table: <FileSpreadsheet className="size-4" aria-hidden="true" />,
};
