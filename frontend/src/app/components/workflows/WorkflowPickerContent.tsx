import { useEffect, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { SearchBar } from "@/app/components/ui/search-bar";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ColumnConfig, Workflow } from "../shared/types";
import {
    formatIcon,
    formatIconClassName,
    formatLabel,
} from "../tabular/columnFormat";
import { TAG_COLORS } from "../tabular/pillUtils";
import {
    APP_SURFACE_ACTIVE_CLASS,
    APP_SURFACE_HOVER_CLASS,
} from "@/app/components/ui/liquid-surface";
type MobilePickerPane = "list" | "details";
interface WorkflowPickerContentProps {
    workflows: Workflow[];
    selected: Workflow | null;
    onSelect: (workflow: Workflow | null) => void;
    search: string;
    onSearchChange: (value: string) => void;
    loading?: boolean;
    disabledWorkflow?: (workflow: Workflow) => boolean;
}
export function WorkflowPickerContent({
    workflows,
    selected,
    onSelect,
    search,
    onSearchChange,
    loading = false,
    disabledWorkflow,
}: WorkflowPickerContentProps) {
    const selectedRowRef = useRef<HTMLButtonElement>(null);
    const selectedId = selected?.id ?? null;
    const [mobilePaneState, setMobilePaneState] = useState<{
        selectedId: string | null;
        pane: MobilePickerPane;
    }>({
        selectedId,
        pane: selected ? "details" : "list",
    });
    const mobilePane =
        mobilePaneState.selectedId === selectedId
            ? mobilePaneState.pane
            : selected
              ? "details"
              : "list";
    const setMobilePane = (pane: MobilePickerPane) => {
        setMobilePaneState({ selectedId, pane });
    };
    useEffect(() => {
        if (selectedRowRef.current) {
            selectedRowRef.current.scrollIntoView({ block: "nearest" });
        }
    }, [selected?.id]);
    const normalizedSearch = search.trim().toLowerCase();
    const filteredWorkflows = normalizedSearch
        ? workflows.filter((workflow) =>
              [
                  workflow.metadata.title,
                  workflow.metadata.practice ?? "",
                  workflow.is_system ? "System" : "Custom",
              ]
                  .join(" ")
                  .toLowerCase()
                  .includes(normalizedSearch),
          )
        : workflows;
    const handleSelectWorkflow = (workflow: Workflow | null) => {
        onSelect(workflow);
        setMobilePane(workflow ? "details" : "list");
    };
    const handleClearPreview = () => {
        onSelect(null);
        setMobilePane("list");
    };
    return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-visible md:flex-row">
            <div
                className={`min-h-0 min-w-0 flex-1 flex-col overflow-visible md:w-64 md:flex-none md:shrink-0 ${
                    mobilePane === "details" && selected
                        ? "hidden md:flex"
                        : "flex"
                }`}
            >
                <SearchBar
                    value={search}
                    onValueChange={onSearchChange}
                    placeholder="Search workflows..."
                />
                <div className="min-h-0 min-w-0 flex-1 overflow-y-auto rounded-sm pt-2">
                    {loading ? (
                        <div className="space-y-px">
                            {[60, 45, 75, 50, 65, 40, 55].map(
                                (width, index) => (
                                    <div
                                        key={index}
                                        className="flex items-center justify-between gap-3 rounded-md px-3 py-2.5"
                                    >
                                        <div
                                            className="h-3 rounded bg-gray-100"
                                            style={{ width: `${width}%` }}
                                        />
                                        <div className="h-3 w-10 shrink-0 rounded bg-gray-100" />
                                    </div>
                                ),
                            )}
                        </div>
                    ) : filteredWorkflows.length === 0 ? (
                        <p className="py-8 text-center text-sm text-gray-400">
                            {search ? "No matches found" : "No workflows found"}
                        </p>
                    ) : (
                        <div className="space-y-px">
                            {filteredWorkflows.map((workflow) => {
                                const disabled =
                                    disabledWorkflow?.(workflow) ?? false;
                                const isSelected = selected?.id === workflow.id;
                                return (
                                    <button
                                        key={workflow.id}
                                        ref={isSelected ? selectedRowRef : null}
                                        type="button"
                                        disabled={disabled}
                                        onClick={() =>
                                            handleSelectWorkflow(
                                                isSelected ? null : workflow,
                                            )
                                        }
                                        className={`flex min-w-0 w-full items-center gap-3 rounded-md px-3 py-2 text-left text-xs ${
                                            isSelected
                                                ? `${APP_SURFACE_ACTIVE_CLASS} text-gray-900`
                                                : APP_SURFACE_HOVER_CLASS
                                        } ${disabled ? "cursor-not-allowed opacity-45" : ""}`}
                                    >
                                        <span
                                            className={`min-w-0 flex-1 truncate ${
                                                isSelected
                                                    ? "font-medium text-gray-900"
                                                    : "text-gray-700"
                                            }`}
                                        >
                                            {workflow.metadata.title}
                                        </span>
                                        <span className="shrink-0 text-xs text-gray-400">
                                            {workflow.is_system
                                                ? "System"
                                                : "Custom"}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>
            {selected ? (
                <WorkflowPreview
                    workflow={selected}
                    onClear={handleClearPreview}
                    className={
                        mobilePane === "details" ? "flex" : "hidden md:flex"
                    }
                />
            ) : (
                <div className="hidden min-w-0 flex-1 md:block" />
            )}
        </div>
    );
}
function WorkflowPreview({
    workflow,
    onClear,
    className = "flex",
}: {
    workflow: Workflow;
    onClear: () => void;
    className?: string;
}) {
    const showColumns = workflow.metadata.type === "tabular";
    return (
        <div
            className={`${className} min-h-0 min-w-0 flex-1 flex-col overflow-visible`}
        >
            <div className="flex min-h-0 min-w-0 flex-1 flex-col rounded-2xl border border-gray-200 bg-white p-1 shadow-sm">
                <div className="flex h-9 shrink-0 items-center justify-between px-3">
                    <p className="min-w-0 flex-1 truncate text-xs font-medium text-gray-700">
                        {workflow.metadata.title}
                    </p>
                    <button
                        type="button"
                        onClick={onClear}
                        aria-label="Close preview"
                        className={`rounded-md p-1 text-gray-400 hover:text-gray-600 ${APP_SURFACE_HOVER_CLASS}`}
                    >
                        <X className="h-3.5 w-3.5" />
                    </button>
                </div>
                <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
                    {showColumns ? (
                        <WorkflowColumnPreview
                            columns={workflow.columns_config ?? []}
                        />
                    ) : (
                        <WorkflowPromptPreview
                            content={
                                workflow.skill_md ?? "_No prompt defined._"
                            }
                        />
                    )}
                </div>
            </div>
        </div>
    );
}
function WorkflowPromptPreview({ content }: { content: string }) {
    const previewContent = stripLeadingMarkdownHeading(content);
    return (
        <div className="min-w-0 flex-1 overflow-x-hidden break-words rounded-md px-3 py-3 font-serif text-sm leading-relaxed text-gray-600">
            <WorkflowPromptMarkdown content={previewContent} />
        </div>
    );
}
function stripLeadingMarkdownHeading(content: string) {
    const stripped = content.replace(/^\s{0,3}#{1,6}\s+[^\n]+(?:\n+|$)/, "");
    return stripped.trimStart() || content;
}
function WorkflowPromptMarkdown({ content }: { content: string }) {
    return (
        <div className="[&>:first-child]:mt-0 [&>:last-child]:mb-0 [&_h1]:mb-1 [&_h1]:mt-4 [&_h1]:text-base [&_h1]:font-semibold [&_h1]:text-gray-900 [&_h2]:mb-1 [&_h2]:mt-3 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-gray-900 [&_h3]:mb-0.5 [&_h3]:mt-2 [&_h3]:text-xs [&_h3]:font-semibold [&_h3]:text-gray-900 [&_p]:mb-2 [&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:mb-2 [&_ol]:list-decimal [&_ol]:pl-4 [&_pre]:whitespace-pre-wrap [&_table]:my-3 [&_table]:w-full [&_table]:table-fixed [&_table]:border-collapse [&_table]:border [&_table]:border-gray-200 [&_table]:text-xs [&_tr]:border-b [&_tr]:border-gray-100 [&_th]:break-words [&_th]:bg-gray-50 [&_th]:px-3 [&_th]:py-2 [&_td]:break-words [&_td]:px-3 [&_td]:py-2 [&_strong]:font-semibold [&_strong]:text-gray-800 [&_em]:italic">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {content}
            </ReactMarkdown>
        </div>
    );
}
function WorkflowColumnPreview({ columns }: { columns: ColumnConfig[] }) {
    const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
    const sortedColumns = [...columns].sort((a, b) => a.index - b.index);
    return (
        <div className="min-w-0 flex-1 space-y-px rounded-sm">
            {sortedColumns.length === 0 ? (
                <p className="px-4 py-6 text-center text-xs text-gray-400">
                    No columns defined
                </p>
            ) : (
                sortedColumns.map((column) => {
                    const isExpanded = expandedIndex === column.index;
                    const FormatIcon = formatIcon(column.format ?? "text");
                    return (
                        <div key={column.index} className="rounded-md">
                            <button
                                type="button"
                                onClick={() =>
                                    setExpandedIndex(
                                        isExpanded ? null : column.index,
                                    )
                                }
                                className={`flex min-w-0 w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-left text-xs ${
                                    isExpanded
                                        ? APP_SURFACE_ACTIVE_CLASS
                                        : APP_SURFACE_HOVER_CLASS
                                }`}
                            >
                                <FormatIcon
                                    className={`h-3.5 w-3.5 shrink-0 ${formatIconClassName(column.format ?? "text")}`}
                                />
                                <span className="min-w-0 flex-1 truncate text-gray-800">
                                    {column.name}
                                </span>
                                <span className="max-w-24 shrink-0 truncate text-gray-400">
                                    {formatLabel(column.format ?? "text")}
                                </span>
                                <ChevronDown
                                    className={`h-3 w-3 shrink-0 text-gray-300 ${isExpanded ? "rotate-180" : ""}`}
                                />
                            </button>
                            {isExpanded ? (
                                <div className="mt-1 min-w-0 space-y-3 overflow-x-hidden break-words rounded-md bg-white/60 px-4 py-3 font-serif text-sm leading-relaxed text-gray-600">
                                    {column.tags && column.tags.length > 0 ? (
                                        <div>
                                            <p className="mb-1.5 font-sans text-[11px] font-medium text-gray-600">
                                                Tags
                                            </p>
                                            <div className="flex flex-wrap gap-1.5">
                                                {column.tags.map(
                                                    (tag, tagIdx) => (
                                                        <span
                                                            key={tag}
                                                            className={`inline-block rounded-full px-1.5 py-0.5 font-sans text-[10px] ${TAG_COLORS[tagIdx % TAG_COLORS.length]}`}
                                                        >
                                                            {tag}
                                                        </span>
                                                    ),
                                                )}
                                            </div>
                                        </div>
                                    ) : null}
                                    <div>
                                        <p className="mb-1 font-sans text-[11px] font-medium text-gray-600">
                                            Prompt
                                        </p>
                                        <WorkflowPromptMarkdown
                                            content={
                                                column.prompt ||
                                                "_No prompt defined._"
                                            }
                                        />
                                    </div>
                                </div>
                            ) : null}
                        </div>
                    );
                })
            )}
        </div>
    );
}
