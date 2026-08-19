import { useEffect, useState } from "react";
import { Check, Loader2, Plus, RefreshCw } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import {
    McpConnectorFields,
    McpToolList,
    type McpConnectorDraft,
} from "@/app/components/account/NewMcpModal";
import { useMfaAction } from "@/app/components/account/useMfaAction";
import {
    API_BASE,
    BeaverApiError,
    createMcpConnector,
    deleteMcpConnector,
    getMcpConnector,
    listMcpConnectors,
    refreshMcpConnectorTools,
    setMcpToolEnabled,
    startMcpConnectorOAuth,
    type McpConnectorSummary,
    updateMcpConnector,
} from "@/app/lib/beaverApi";
import { accountGlassPrimaryButtonClassName } from "../accountStyles";
import { AccountSection } from "../AccountSection";
import { AccountToggle } from "../AccountToggle";
const emptyAddDraft: McpConnectorDraft = {
    name: "",
    serverUrl: "",
    bearerToken: "",
    customHeaders: "",
};
type DetailState = {
    id: string;
    draft: McpConnectorDraft;
    loading: boolean;
};
const emptyAddState = {
    draft: emptyAddDraft,
    step: "form" as "form" | "auth" | "success",
    result: null as McpConnectorSummary | null,
    error: null as string | null,
    authMessage: null as string | null,
};
const connectorDraft = (
    connector?: Pick<McpConnectorSummary, "name" | "serverUrl">,
): McpConnectorDraft => ({
    ...emptyAddDraft,
    name: connector?.name ?? "",
    serverUrl: connector?.serverUrl ?? "",
});
const errorMessage = (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback;
function parseCustomHeaders(raw: string): Record<string, string> | undefined {
    const text = raw.trim();
    if (!text) return undefined;
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Custom headers must be a JSON object.");
    }
    if (Object.values(parsed).some((value) => typeof value !== "string")) {
        throw new Error("Custom header values must be strings.");
    }
    return parsed as Record<string, string>;
}
export default function ConnectorsPage() {
    const [connectors, setConnectors] =
        useState<McpConnectorSummary[] | null>(null);
    const [busyKey, setBusyKey] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const { runMfa, mfaPopup } = useMfaAction();
    const [add, setAdd] = useState<typeof emptyAddState | null>(null);
    const [detail, setDetail] = useState<DetailState | null>(null);
    const connectorList = connectors ?? [];
    const selectedConnector =
        connectorList.find(({ id }) => id === detail?.id) ?? null;
    const adding = busyKey === "create";
    const authorizing = add?.step === "auth";
    const addSuccess = add?.step === "success";
    const addBusy = adding || authorizing;
    const addDraft = add?.draft ?? emptyAddDraft;
    const updateAdd = (patch: Partial<typeof emptyAddState>) =>
        setAdd((current) => (current ? { ...current, ...patch } : current));
    const updateDetail = (
        patch: Partial<DetailState>,
        connectorId = detail?.id,
    ) =>
        setDetail((current) =>
            current && current.id === connectorId
                ? { ...current, ...patch }
                : current,
        );
    useEffect(() => {
        listMcpConnectors()
            .then(setConnectors)
            .catch((err) => {
                setError(errorMessage(err, "Failed to load connectors."));
                setConnectors([]);
            });
    }, []);
    const replaceConnector = (
        connector: McpConnectorSummary,
        preserveTools = false,
    ) => {
        setConnectors((prev) => {
            const current = prev ?? [];
            const existing = current.find(({ id }) => id === connector.id);
            const next =
                preserveTools &&
                !connector.tools.length &&
                existing?.tools.length
                    ? { ...connector, tools: existing.tools }
                    : connector;
            return existing
                ? current.map((item) =>
                      item.id === connector.id ? next : item,
                  )
                : [next, ...current];
        });
    };
    const openConnectorDetails = async (connectorId: string) => {
        setDetail({
            id: connectorId,
            draft: connectorDraft(
                connectorList.find(({ id }) => id === connectorId),
            ),
            loading: true,
        });
        try {
            const connector = await getMcpConnector(connectorId);
            replaceConnector(connector);
            updateDetail({ draft: connectorDraft(connector) }, connectorId);
        } catch (err) {
            setError(errorMessage(err, "Failed to load connector details."));
        } finally {
            updateDetail({ loading: false }, connectorId);
        }
    };
    const runSensitiveAction = (
        key: string,
        fn: () => Promise<void>,
        setActionError: (message: string) => void = setError,
    ) => {
        setError(null);
        return runMfa(
            async () => {
                setBusyKey(key);
                await fn().finally(() => setBusyKey(null));
            },
            {
                onError: (err) =>
                    setActionError(errorMessage(err, "Action failed.")),
            },
        );
    };
    const closeAddModal = () => {
        if (addBusy) return;
        setAdd(null);
    };
    const refreshTools = async (connectorId: string) => {
        const connector = await refreshMcpConnectorTools(connectorId);
        replaceConnector(connector);
        return connector;
    };
    const connectConnectorOAuth = async (connectorId: string) => {
        const popup = window.open(
            "about:blank",
            "mike_mcp_oauth",
            "popup,width=560,height=720,menubar=no,toolbar=no,location=no,status=no",
        );
        const { authorizationUrl, alreadyAuthorized } =
            await startMcpConnectorOAuth(connectorId);
        if (alreadyAuthorized) {
            popup?.close();
            return refreshTools(connectorId);
        }
        if (!authorizationUrl) {
            popup?.close();
            throw new Error("OAuth authorization URL was not returned.");
        }
        if (!popup) {
            window.location.assign(authorizationUrl);
            return null;
        }
        popup.location.href = authorizationUrl;
        await new Promise<void>((resolve, reject) => {
            const controller = new AbortController();
            const poll = window.setInterval(() => {
                if (popup.closed)
                    finish(new Error("OAuth authorization window was closed."));
            }, 700);
            const timeout = window.setTimeout(
                () => finish(new Error("OAuth authorization timed out.")),
                5 * 60 * 1000,
            );
            const finish = (error?: Error) => {
                controller.abort();
                window.clearInterval(poll);
                window.clearTimeout(timeout);
                if (error) reject(error);
                else resolve();
            };
            window.addEventListener("message", (event) => {
                if (
                    event.source !== popup ||
                    event.origin !== new URL(API_BASE, location.href).origin
                ) return;
                const result = event.data as Record<string, unknown>;
                if (result?.type !== "mcp_oauth_result") return;
                if (result.connectorId && result.connectorId !== connectorId)
                    return;
                (event.source as Window | null)?.postMessage(
                    { type: "mcp_oauth_result_ack" },
                    event.origin,
                );
                const failure =
                    result.detail ?? "OAuth authorization failed.";
                finish(
                    result.success
                        ? undefined
                        : new Error(String(failure)),
                );
            }, { signal: controller.signal });
        });
        return refreshTools(connectorId);
    };
    const authorizeAddedConnector = (
        connectorId: string,
        message: string,
    ) => {
        updateAdd({ authMessage: message, step: "auth" });
        return connectConnectorOAuth(connectorId);
    };
    const refreshConnector = async (
        connector: McpConnectorSummary,
        onOAuth: typeof authorizeAddedConnector = connectConnectorOAuth,
    ) => {
        let refreshed: McpConnectorSummary;
        try {
            refreshed = await refreshTools(connector.id);
        } catch (err) {
            if (
                !(err instanceof BeaverApiError) ||
                err.code !== "oauth_required"
            ) {
                throw err;
            }
            replaceConnector(connector);
            return onOAuth(
                connector.id,
                "Complete authorization in the popup to finish connecting this MCP server.",
            );
        }
        return refreshed;
    };
    const handleCreate = () => {
        if (!add) return;
        return runSensitiveAction(
            "create",
            async () => {
                updateAdd({ error: null, authMessage: null });
                try {
                    const headers = parseCustomHeaders(add.draft.customHeaders);
                    const connector = await createMcpConnector({
                        name: add.draft.name,
                        serverUrl: add.draft.serverUrl,
                        bearerToken: add.draft.bearerToken.trim() || null,
                        ...(headers ? { headers } : {}),
                    });
                    const refreshed = await refreshConnector(
                        connector,
                        authorizeAddedConnector,
                    );
                    if (refreshed) {
                        updateAdd({
                            authMessage: null,
                            result: refreshed,
                            step: "success",
                        });
                    }
                } catch (err) {
                    updateAdd({ step: "form", authMessage: null });
                    throw err instanceof Error
                        ? err
                        : new Error("Failed to add connector.");
                }
            },
            (message) => updateAdd({ error: message }),
        );
    };
    const handleSaveSelectedConnector = () => {
        if (!selectedConnector || !detail) return;
        return runSensitiveAction(
            `save:${selectedConnector.id}`,
            async () => {
                const headers = parseCustomHeaders(detail.draft.customHeaders);
                const saved = await updateMcpConnector(selectedConnector.id, {
                    name: detail.draft.name,
                    serverUrl: detail.draft.serverUrl,
                    ...(detail.draft.bearerToken.trim()
                        ? { bearerToken: detail.draft.bearerToken.trim() }
                        : {}),
                    ...(headers ? { headers } : {}),
                });
                const shouldRefreshTools =
                    saved.serverUrl !== selectedConnector.serverUrl ||
                    !!detail.draft.bearerToken.trim() ||
                    !!headers;
                const refreshed = shouldRefreshTools
                    ? await refreshMcpConnectorTools(saved.id)
                    : saved;
                replaceConnector(refreshed, !shouldRefreshTools);
                updateDetail({ draft: connectorDraft(refreshed) });
            },
        );
    };
    const handleClearBearerToken = (connectorId: string) =>
        runSensitiveAction(
            `clear-token:${connectorId}`,
            async () => {
                const saved = await updateMcpConnector(connectorId, {
                    bearerToken: null,
                });
                replaceConnector(saved, true);
                updateDetail({ draft: connectorDraft(saved) }, connectorId);
            },
        );
    const handleRefresh = (connectorId: string) =>
        runSensitiveAction(`refresh:${connectorId}`, async () => {
            const connector = connectorList.find(
                ({ id }) => id === connectorId,
            );
            if (connector) await refreshConnector(connector);
        });
    const handleConnectorEnabled = (connectorId: string, enabled: boolean) =>
        runSensitiveAction(`connector:${connectorId}`, async () =>
            replaceConnector(
                await updateMcpConnector(connectorId, { enabled }),
                true,
            ),
        );
    const handleToolEnabled = (
        connectorId: string,
        toolId: string,
        enabled: boolean,
    ) =>
        runSensitiveAction(`tool:${toolId}`, async () =>
            replaceConnector(
                await setMcpToolEnabled(connectorId, toolId, enabled),
            ),
        );
    const handleDelete = (connectorId: string) =>
        runSensitiveAction(`delete:${connectorId}`, async () => {
            await deleteMcpConnector(connectorId);
            setConnectors((prev) =>
                prev?.filter((item) => item.id !== connectorId) ?? [],
            );
            setDetail((current) =>
                current?.id === connectorId ? null : current,
            );
        });
    const hasChanges =
        !!selectedConnector &&
        !!detail &&
        (detail.draft.name.trim() !== selectedConnector.name ||
            detail.draft.serverUrl.trim() !== selectedConnector.serverUrl ||
            !!detail.draft.bearerToken.trim() ||
            !!detail.draft.customHeaders.trim());
    const selectedBusy = (action: string) =>
        busyKey === `${action}:${selectedConnector?.id}`;
    const isSaving = selectedBusy("save");
    return (
        <div>
            <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className="font-serif text-2xl font-medium text-gray-900">
                    Connectors
                </h2>
                <button
                    type="button"
                    onClick={() => setAdd(emptyAddState)}
                    className={`inline-flex h-9 items-center gap-1.5 text-sm ${accountGlassPrimaryButtonClassName}`}
                >
                    <Plus className="h-4 w-4" />
                    Add
                </button>
            </div>
            {error && !detail && (
                <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                    {error}
                </div>
            )}
            <div className="space-y-3">
                {connectors === null ? (
                    <AccountSection className="h-[228px] bg-gray-100" aria-hidden>{null}</AccountSection>
                ) : connectorList.length === 0 ? (
                    <AccountSection className="p-4">
                        <p className="text-sm text-gray-500">
                            No connectors yet.
                        </p>
                    </AccountSection>
                ) : (
                    connectorList.map((connector) => {
                        const loading =
                            busyKey === `connector:${connector.id}`;
                        const toolCount =
                            connector.toolCount ?? connector.tools.length;
                        return (
                            <AccountSection
                                key={connector.id}
                                className="px-4 py-3"
                            >
                                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
                                    <button
                                        type="button"
                                        onClick={() =>
                                            void openConnectorDetails(
                                                connector.id,
                                            )
                                        }
                                        className="min-w-0 text-left"
                                        aria-label={`Open ${connector.name} connector`}
                                    >
                                        <h3 className="truncate text-sm font-semibold text-gray-900">
                                            {connector.name}
                                        </h3>
                                        <p className="mt-1 truncate text-xs text-gray-500">
                                            {toolCount}{" "}
                                            {toolCount === 1 ? "tool" : "tools"}
                                            {" / "}
                                            {connector.serverUrl}
                                        </p>
                                    </button>
                                    <AccountToggle
                                        checked={connector.enabled}
                                        disabled={loading}
                                        loading={loading}
                                        label={
                                            connector.enabled
                                                ? "Enabled"
                                                : "Disabled"
                                        }
                                        onChange={(enabled) =>
                                            void handleConnectorEnabled(
                                                connector.id,
                                                enabled,
                                            )
                                        }
                                    />
                                </div>
                            </AccountSection>
                        );
                    })
                )}
            </div>
            <Modal
                open={add !== null}
                onClose={closeAddModal}
                breadcrumbs={[
                    "Connectors",
                    addSuccess
                        ? "Connector added"
                        : authorizing
                          ? "Authenticate connector"
                          : "New MCP connector",
                ]}
                size="lg"
                primaryAction={
                    addSuccess && add?.result
                        ? {
                              label: "View connector",
                              onClick: () => {
                                  void openConnectorDetails(add.result!.id);
                                  closeAddModal();
                              },
                          }
                        : {
                              label:
                                  adding
                                      ? "Connecting..."
                                      : authorizing
                                        ? "Authorizing..."
                                        : "Connect",
                              icon: addBusy ? (
                                      <Loader2 className="size-4 animate-spin" />
                                  ) : undefined,
                              onClick: () => void handleCreate(),
                              disabled:
                                  !addDraft.name.trim() ||
                                  !addDraft.serverUrl.trim() ||
                                  addBusy,
                          }
                }
                cancelAction={
                    addBusy
                        ? false
                        : {
                              label:
                                  addSuccess ? "Done" : "Cancel",
                              onClick: closeAddModal,
                          }
                }
                footerStatus={
                    add?.error ? (
                        <div className="rounded-xl border border-red-200 bg-white px-3 py-2 text-sm text-red-600 shadow-sm">
                            {add.error}
                        </div>
                    ) : null
                }
            >
                {addSuccess && add?.result ? (
                    <div className="flex h-full min-h-0 flex-1 flex-col gap-4 pb-4">
                        <div className="flex items-start gap-3 rounded-xl border border-green-100 bg-green-50 px-3 py-3 text-green-800">
                            <Check className="mt-0.5 size-4 shrink-0 text-green-600" />
                            <p className="min-w-0 truncate text-sm font-medium">
                                {add.result.name} is connected.{" "}
                                <span className="font-normal text-green-700">
                                    {add.result.tools.length} tools discovered.
                                </span>
                            </p>
                        </div>
                        <McpToolList connector={add.result} />
                    </div>
                ) : authorizing ? (
                    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 pb-4 text-center">
                        <Loader2 className="size-4 animate-spin text-gray-700" />
                        <p className="max-w-sm text-sm text-gray-500">
                            {add.authMessage ??
                                "Complete authorization in the popup to finish connecting this MCP server."}
                        </p>
                    </div>
                ) : (
                    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pb-4">
                        <p className="text-sm text-gray-500">
                            The assistant will have access to this MCP server
                            and its enabled tools.
                        </p>
                        <McpConnectorFields
                            draft={addDraft}
                            showTokenNote
                            disabled={adding}
                            onDraftChange={(draft) => updateAdd({ draft })}
                        />
                    </div>
                )}
            </Modal>
            <Modal
                open={!!selectedConnector}
                onClose={() => setDetail(null)}
                breadcrumbs={[
                    "Connectors",
                    selectedConnector?.name ?? "MCP connector",
                ]}
                size="md"
                secondaryAction={
                    selectedConnector
                        ? {
                              label: "Delete connector",
                              variant: "danger",
                              onClick: () =>
                                  void handleDelete(selectedConnector.id),
                              disabled: selectedBusy("delete"),
                          }
                        : undefined
                }
                primaryAction={{
                    label: isSaving ? "Saving..." : "Save",
                    icon: isSaving ? (
                        <Loader2 className="size-4 animate-spin" />
                    ) : undefined,
                    onClick: () => void handleSaveSelectedConnector(),
                    disabled:
                        !hasChanges ||
                        isSaving ||
                        !detail?.draft.name.trim() ||
                        !detail.draft.serverUrl.trim(),
                }}
                footerStatus={
                    detail && error ? (
                        <span className="text-sm text-red-600">{error}</span>
                    ) : null
                }
            >
                {selectedConnector && detail && (
                    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto pb-4">
                        <McpConnectorFields
                            key={selectedConnector.id}
                            draft={detail.draft}
                            tokenPlaceholder={
                                selectedConnector.hasAuthConfig
                                    ? "Saved token encrypted"
                                    : "Bearer token"
                            }
                            onClearToken={
                                selectedConnector.hasAuthConfig
                                    ? () =>
                                          void handleClearBearerToken(
                                              selectedConnector.id,
                                          )
                                    : undefined
                            }
                            clearingToken={
                                selectedBusy("clear-token")
                            }
                            onDraftChange={(draft) =>
                                updateDetail({ draft })
                            }
                        />
                        <div className="flex min-h-0 flex-1 flex-col">
                            <button
                                type="button"
                                title="Refresh tools"
                                aria-label="Refresh tools"
                                onClick={() =>
                                    void handleRefresh(selectedConnector.id)
                                }
                                disabled={selectedBusy("refresh")}
                                className="mb-2 self-end text-gray-500 hover:text-gray-900 disabled:text-gray-300"
                            >
                                {selectedBusy("refresh") ? (
                                    <Loader2 className="size-4 animate-spin" />
                                ) : (
                                    <RefreshCw className="size-4" />
                                )}
                            </button>
                            {detail.loading ? (
                                <div className="min-h-24 flex-1 rounded-lg border border-gray-100 bg-gray-50" />
                            ) : (
                                <McpToolList
                                    connector={selectedConnector}
                                    busyKey={busyKey}
                                    onToolEnabled={handleToolEnabled}
                                />
                            )}
                        </div>
                    </div>
                )}
            </Modal>
            {mfaPopup}
        </div>
    );
}
