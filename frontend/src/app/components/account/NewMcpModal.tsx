import { useState } from "react";
import { ChevronDown, Eye, EyeOff, Loader2 } from "lucide-react";
import { Input } from "@/app/components/ui/input";
import type { McpConnectorSummary } from "@/app/lib/beaverApi";
import { AccountToggle } from "@/app/(pages)/account/AccountToggle";
import {
    accountGlassIconButtonClassName,
    accountGlassInputClassName,
} from "@/app/(pages)/account/accountStyles";
export type McpConnectorDraft = {
    name: string;
    serverUrl: string;
    bearerToken: string;
    customHeaders: string;
};
const connectorFields = [
    ["name", "Label", "Connector label"],
    ["serverUrl", "URL endpoint", "https://mcp.example.com/mcp"],
] as const;
export function McpConnectorFields({
    draft,
    showTokenNote = false,
    tokenPlaceholder = "Bearer token",
    onClearToken,
    clearingToken,
    disabled = false,
    onDraftChange,
}: {
    draft: McpConnectorDraft;
    showTokenNote?: boolean;
    tokenPlaceholder?: string;
    onClearToken?: () => void;
    clearingToken?: boolean;
    disabled?: boolean;
    onDraftChange: (draft: McpConnectorDraft) => void;
}) {
    const [showToken, setShowToken] = useState(false);
    const setField = <K extends keyof McpConnectorDraft>(
        field: K,
        value: McpConnectorDraft[K],
    ) => onDraftChange({ ...draft, [field]: value });
    return (
        <div className="grid gap-3 pt-1">
            {connectorFields.map(([field, label, placeholder]) => (
                <label
                    key={field}
                    className="grid gap-2 sm:grid-cols-[96px_minmax(0,1fr)] sm:items-center"
                >
                    <span className="text-xs font-medium text-gray-500">
                        {label}
                    </span>
                    <Input
                        value={draft[field]}
                        onChange={(event) =>
                            setField(field, event.target.value)
                        }
                        placeholder={placeholder}
                        className={`h-8 text-sm ${accountGlassInputClassName}`}
                        disabled={disabled}
                    />
                </label>
            ))}
            <div className="grid gap-2 sm:grid-cols-[96px_minmax(0,1fr)] sm:items-start">
                <span className="pt-2 text-xs font-medium text-gray-500">
                    Bearer token
                </span>
                <div className="min-w-0">
                    <div className="relative">
                        <Input
                            value={draft.bearerToken}
                            onChange={(event) =>
                                setField("bearerToken", event.target.value)
                            }
                            type={showToken ? "text" : "password"}
                            placeholder={tokenPlaceholder}
                            className={`h-8 ${
                                onClearToken
                                    ? draft.bearerToken
                                        ? "pr-[6.5rem]"
                                        : "pr-16"
                                    : "pr-10"
                            } text-sm ${accountGlassInputClassName}`}
                            autoComplete="off"
                            spellCheck={false}
                            aria-label="Bearer token"
                            disabled={disabled}
                        />
                        {draft.bearerToken && (
                            <button
                                type="button"
                                className={`absolute inset-y-1 ${
                                    onClearToken ? "right-[3.75rem]" : "right-1.5"
                                } flex items-center ${accountGlassIconButtonClassName}`}
                                onClick={() => setShowToken((shown) => !shown)}
                                aria-label={
                                    showToken ? "Hide token" : "Show token"
                                }
                                disabled={disabled}
                            >
                                {showToken ? (
                                    <EyeOff className="h-4 w-4" />
                                ) : (
                                    <Eye className="h-4 w-4" />
                                )}
                            </button>
                        )}
                        {onClearToken && (
                            <button
                                type="button"
                                onClick={onClearToken}
                                disabled={disabled || clearingToken}
                                className="absolute inset-y-1 right-1.5 px-1 text-xs font-medium text-gray-500 hover:text-gray-900 disabled:cursor-not-allowed disabled:text-gray-300"
                            >
                                <span className="inline-flex items-center gap-1">
                                    Clear
                                    {clearingToken && (
                                        <Loader2 className="h-3 w-3 animate-spin" />
                                    )}
                                </span>
                            </button>
                        )}
                    </div>
                    {showTokenNote && (
                        <p className="mt-1 text-right text-xs text-gray-500">
                            Tokens are stored encrypted.
                        </p>
                    )}
                </div>
            </div>
            <details className="group grid gap-2">
                <summary
                    className="inline-flex cursor-pointer list-none items-center gap-1 justify-self-start text-xs font-medium text-gray-500 hover:text-gray-900"
                    aria-disabled={disabled}
                    tabIndex={disabled ? -1 : undefined}
                    onClick={(event) => {
                        if (disabled) event.preventDefault();
                    }}
                >
                    Advanced
                    <ChevronDown className="h-3.5 w-3.5 -rotate-90 group-open:rotate-0" />
                </summary>
                <label className="mt-2 grid gap-2 sm:grid-cols-[96px_minmax(0,1fr)] sm:items-start">
                    <span className="text-xs font-medium text-gray-500">
                        Custom headers
                    </span>
                    <div className="min-w-0">
                        <textarea
                            value={draft.customHeaders}
                            onChange={(event) =>
                                setField("customHeaders", event.target.value)
                            }
                            placeholder='{"X-API-Key":"secret"}'
                            className={`min-h-20 w-full resize-y rounded-lg px-3 py-2 text-sm outline-none ${accountGlassInputClassName}`}
                            autoComplete="off"
                            spellCheck={false}
                            disabled={disabled}
                        />
                        <p className="mt-1 text-right text-xs text-gray-500">
                            Secrets are stored encrypted.
                        </p>
                    </div>
                </label>
            </details>
        </div>
    );
}
export function McpToolList({
    connector,
    busyKey,
    onToolEnabled,
}: {
    connector: McpConnectorSummary;
    busyKey?: string | null;
    onToolEnabled?: (
        connectorId: string,
        toolId: string,
        enabled: boolean,
    ) => Promise<void>;
}) {
    if (connector.tools.length === 0) {
        return (
            <div className="min-h-0 flex-1 rounded-lg bg-gray-50 px-3 py-3 text-sm text-gray-500">
                No tools discovered yet.
            </div>
        );
    }
    return (
        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-gray-100 bg-white/60">
            <div className="divide-y divide-gray-100">
                {connector.tools.map((tool) => {
                    const loading = busyKey === `tool:${tool.id}`;
                    const toolLabel =
                        tool.title ||
                        (onToolEnabled
                            ? tool.toolName
                            : tool.openaiToolName);
                    const Row = onToolEnabled ? "label" : "div";
                    return (
                        <Row
                            key={tool.id}
                            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2"
                        >
                            <div className="min-w-0">
                                <p className="truncate text-sm font-medium text-gray-800">
                                    {toolLabel}
                                </p>
                                {!onToolEnabled && tool.description && (
                                    <p className="truncate text-xs text-gray-500">
                                        {tool.description}
                                    </p>
                                )}
                            </div>
                            {onToolEnabled ? (
                                <AccountToggle
                                    checked={tool.enabled}
                                    disabled={
                                        loading || tool.requiresConfirmation
                                    }
                                    loading={loading}
                                    onChange={(enabled) =>
                                        void onToolEnabled(
                                            connector.id,
                                            tool.id,
                                            enabled,
                                        )
                                    }
                                />
                            ) : (
                                <span className="text-xs text-gray-400">
                                    {tool.enabled ? "Enabled" : "Disabled"}
                                </span>
                            )}
                        </Row>
                    );
                })}
            </div>
        </div>
    );
}
