import { useEffect, useState } from "react";
import { Check, Loader2, Plus, RefreshCw } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import { McpConnectorFields, McpToolList, type McpConnectorDraft } from "@/app/components/account/NewMcpModal";
import { useMfaAction } from "@/app/components/account/useMfaAction";
import { Switch } from "@/app/components/ui/switch";
import { createMcpConnector, deleteMcpConnector, getMcpConnector, listMcpConnectors, refreshMcpConnectorTools,
    setMcpToolEnabled, startMcpConnectorOAuth, type McpConnectorSummary, updateMcpConnector } from "@/app/lib/api/account";
import { BeaverApiError } from "@/app/lib/api/client";
import { errorMessage } from "@/app/lib/utils";
import { AccountSection, SettingsSection, accountGlassPrimaryButtonClassName } from "./AccountSection";

const SPINNER = <Loader2 className="size-4 animate-spin" />;
type AddState = { draft: McpConnectorDraft; step: "form" | "auth" | "success"; result: McpConnectorSummary | null; error: string | null };
const connectorDraft = (connector?: Pick<McpConnectorSummary, "name" | "serverUrl">): McpConnectorDraft =>
    ({ name: connector?.name ?? "", serverUrl: connector?.serverUrl ?? "", bearerToken: "", customHeaders: "" });
const newAdd = (): AddState => ({ draft: connectorDraft(), step: "form", result: null, error: null });

function parseCustomHeaders(raw: string): Record<string, string> | undefined {
    const text = raw.trim();
    if (!text) return undefined;
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Custom headers must be a JSON object.");
    if (Object.values(parsed).some((value) => typeof value !== "string")) throw new Error("Custom header values must be strings.");
    return parsed as Record<string, string>;
}

/** Opens the server's authorization page in a popup and waits for it to come back to Beaver. */
async function authorizeInPopup(connectorId: string): Promise<boolean> {
    const popup = window.open("about:blank", "_blank", "popup,width=560,height=720,menubar=no,toolbar=no,location=no,status=no");
    const { authorizationUrl, alreadyAuthorized } = await startMcpConnectorOAuth(connectorId);
    if (alreadyAuthorized) { popup?.close(); return true; }
    if (!authorizationUrl) { popup?.close(); throw new Error("OAuth authorization URL was not returned."); }
    if (!popup) { window.location.assign(authorizationUrl); return false; }
    popup.opener = null;
    popup.location.href = authorizationUrl;
    try {
        await new Promise<void>((resolve, reject) => {
            let settled = false;
            const finish = (error?: Error) => {
                if (settled) return;
                settled = true;
                window.clearInterval(poll); window.clearTimeout(timeout);
                if (error) reject(error); else resolve();
            };
            const poll = window.setInterval(() => {
                let result: string | null = null;
                try {
                    if (popup.location.origin === location.origin) result = new URL(popup.location.href).searchParams.get("mcp_oauth");
                } catch { /* The authorization page is cross-origin. */ }
                if (result) finish(result === "success" ? undefined : new Error("OAuth authorization failed."));
                else if (popup.closed) finish(new Error("OAuth authorization window was closed."));
            }, 500);
            const timeout = window.setTimeout(() => finish(new Error("OAuth authorization timed out.")), 5 * 60 * 1000);
        });
    } finally { popup.close(); }
    return true;
}

/** The assistant's MCP servers: add, edit, authorize, turn servers and their tools on or off. */
export function ConnectorSettings() {
    const [connectors, setConnectors] = useState<McpConnectorSummary[] | null>(null);
    const [busyKey, setBusyKey] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const { runMfa, mfaPopup } = useMfaAction();
    const [add, setAdd] = useState<AddState | null>(null);
    const [detail, setDetail] = useState<{ id: string; draft: McpConnectorDraft; loading: boolean } | null>(null);
    const list = connectors ?? [];
    const selected = list.find(({ id }) => id === detail?.id) ?? null;
    const adding = busyKey === "create", authorizing = add?.step === "auth", addBusy = adding || authorizing;
    const addDraft = add?.draft ?? connectorDraft();
    const updateAdd = (patch: Partial<AddState>) => setAdd((current) => current && { ...current, ...patch });
    const updateDetail = (patch: Partial<NonNullable<typeof detail>>, connectorId = detail?.id) =>
        setDetail((current) => current && current.id === connectorId ? { ...current, ...patch } : current);
    useEffect(() => {
        listMcpConnectors().then(setConnectors).catch((err) => {
            setError(errorMessage(err, "Failed to load connectors.")); setConnectors([]);
        });
    }, []);
    const replaceConnector = (connector: McpConnectorSummary, preserveTools = false) => setConnectors((prev) => {
        const current = prev ?? [], existing = current.find(({ id }) => id === connector.id);
        const next = preserveTools && !connector.tools.length && existing?.tools.length ? { ...connector, tools: existing.tools } : connector;
        return existing ? current.map((item) => item.id === connector.id ? next : item) : [next, ...current];
    });
    const openDetails = async (connectorId: string) => {
        setDetail({ id: connectorId, draft: connectorDraft(list.find(({ id }) => id === connectorId)), loading: true });
        try {
            const connector = await getMcpConnector(connectorId);
            replaceConnector(connector);
            updateDetail({ draft: connectorDraft(connector) }, connectorId);
        } catch (err) { setError(errorMessage(err, "Failed to load connector details.")); }
        finally { updateDetail({ loading: false }, connectorId); }
    };
    const sensitive = (key: string, fn: () => Promise<void>, onError: (message: string) => void = setError) => {
        setError(null);
        return runMfa(async () => { setBusyKey(key); await fn().finally(() => setBusyKey(null)); },
            { onError: (err) => onError(errorMessage(err, "Action failed.")) });
    };
    const refreshTools = async (connectorId: string) => {
        const connector = await refreshMcpConnectorTools(connectorId);
        replaceConnector(connector);
        return connector;
    };
    /** Refreshes the tools, authorizing first when the server asks for OAuth. */
    const refreshConnector = async (connector: McpConnectorSummary, beforeOAuth?: () => void) => {
        try { return await refreshTools(connector.id); }
        catch (err) {
            if (!(err instanceof BeaverApiError) || err.code !== "oauth_required") throw err;
            replaceConnector(connector);
            beforeOAuth?.();
            return await authorizeInPopup(connector.id) ? refreshTools(connector.id) : null;
        }
    };
    const create = () => add && sensitive("create", async () => {
        updateAdd({ error: null });
        try {
            const headers = parseCustomHeaders(add.draft.customHeaders);
            const connector = await createMcpConnector({ name: add.draft.name, serverUrl: add.draft.serverUrl,
                bearerToken: add.draft.bearerToken.trim() || null, ...(headers ? { headers } : {}) });
            const refreshed = await refreshConnector(connector, () => updateAdd({ step: "auth" }));
            if (refreshed) updateAdd({ result: refreshed, step: "success" });
        } catch (err) {
            updateAdd({ step: "form" });
            throw err instanceof Error ? err : new Error("Failed to add connector.");
        }
    }, (message) => updateAdd({ error: message }));
    const save = () => selected && detail && sensitive(`save:${selected.id}`, async () => {
        const headers = parseCustomHeaders(detail.draft.customHeaders), token = detail.draft.bearerToken.trim();
        const saved = await updateMcpConnector(selected.id, { name: detail.draft.name, serverUrl: detail.draft.serverUrl,
            ...(token ? { bearerToken: token } : {}), ...(headers ? { headers } : {}) });
        const changed = saved.serverUrl !== selected.serverUrl || !!token || !!headers;
        const refreshed = changed ? await refreshMcpConnectorTools(saved.id) : saved;
        replaceConnector(refreshed, !changed);
        updateDetail({ draft: connectorDraft(refreshed) });
    });
    /** Toggles and token clearing: call the API, keep what it returns. */
    const apply = (key: string, call: () => Promise<McpConnectorSummary>, preserveTools = false) =>
        sensitive(key, async () => replaceConnector(await call(), preserveTools));
    const remove = (connectorId: string) => sensitive(`delete:${connectorId}`, async () => {
        await deleteMcpConnector(connectorId);
        setConnectors((prev) => prev?.filter((item) => item.id !== connectorId) ?? []);
        setDetail((current) => current?.id === connectorId ? null : current);
    });
    const hasChanges = !!selected && !!detail && (detail.draft.name.trim() !== selected.name
        || detail.draft.serverUrl.trim() !== selected.serverUrl || !!detail.draft.bearerToken.trim() || !!detail.draft.customHeaders.trim());
    const selectedBusy = (action: string) => busyKey === `${action}:${selected?.id}`;
    const saving = selectedBusy("save");
    return <SettingsSection title="Connectors" description="The assistant can use the enabled tools of these MCP servers."
        action={<button type="button" onClick={() => setAdd(newAdd())}
            className={`inline-flex h-9 shrink-0 items-center gap-1.5 text-sm ${accountGlassPrimaryButtonClassName}`}>
            <Plus className="h-4 w-4" />Add</button>}>
        {error && !detail && <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        <div className="space-y-3">
            {connectors === null ? <AccountSection className="h-[228px] bg-gray-100" aria-hidden>{null}</AccountSection>
                : !list.length ? <AccountSection className="p-4"><p className="text-sm text-gray-500">No connectors yet.</p></AccountSection>
                : list.map((connector) => {
                    const loading = busyKey === `connector:${connector.id}`, tools = connector.toolCount ?? connector.tools.length;
                    return <AccountSection key={connector.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 px-4 py-3">
                        <button type="button" onClick={() => void openDetails(connector.id)} className="min-w-0 text-left"
                            aria-label={`Open ${connector.name} connector`}>
                            <h3 className="truncate text-sm font-semibold text-gray-900">{connector.name}</h3>
                            <p className="mt-1 truncate text-xs text-gray-500">{tools} {tools === 1 ? "tool" : "tools"} / {connector.serverUrl}</p>
                        </button>
                        <Switch checked={connector.enabled} disabled={loading} loading={loading}
                            label={connector.enabled ? "Enabled" : "Disabled"} ariaLabel={`${connector.name} enabled`}
                            onChange={(enabled) => void apply(`connector:${connector.id}`, () => updateMcpConnector(connector.id, { enabled }), true)} />
                    </AccountSection>;
                })}
        </div>
        <Modal open={add !== null} onClose={() => { if (!addBusy) setAdd(null); }} size="lg"
            breadcrumbs={["Connectors", add?.step === "success" ? "Connector added" : authorizing ? "Authenticate connector" : "New MCP connector"]}
            primaryAction={add?.step === "success" && add.result
                ? { label: "View connector", onClick: () => { void openDetails(add.result!.id); setAdd(null); } }
                : { label: adding ? "Connecting..." : authorizing ? "Authorizing..." : "Connect", icon: addBusy ? SPINNER : undefined,
                    onClick: () => void create(), disabled: !addDraft.name.trim() || !addDraft.serverUrl.trim() || addBusy }}
            footerStatus={add?.error ? <div className="rounded-xl border border-red-200 bg-white px-3 py-2 text-sm text-red-600 shadow-sm">{add.error}</div> : null}>
            {add?.step === "success" && add.result ? <div className="flex h-full min-h-0 flex-1 flex-col gap-4 pb-4">
                <div className="flex items-start gap-3 rounded-xl border border-green-100 bg-green-50 px-3 py-3 text-green-800">
                    <Check className="mt-0.5 size-4 shrink-0 text-green-600" />
                    <p className="min-w-0 truncate text-sm font-medium">{add.result.name} is connected.{" "}
                        <span className="font-normal text-green-700">{add.result.tools.length} tools discovered.</span></p>
                </div>
                <McpToolList connector={add.result} />
            </div> : authorizing ? <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 pb-4 text-center">
                <Loader2 className="size-4 animate-spin text-gray-700" />
                <p className="max-w-sm text-sm text-gray-500">Complete authorization in the popup to finish connecting this MCP server.</p>
            </div> : <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pb-4">
                <p className="text-sm text-gray-500">The assistant will have access to this MCP server and its enabled tools.</p>
                <McpConnectorFields draft={addDraft} showTokenNote disabled={adding} onDraftChange={(draft) => updateAdd({ draft })} />
            </div>}
        </Modal>
        <Modal open={!!selected} onClose={() => setDetail(null)} size="md" breadcrumbs={["Connectors", selected?.name ?? "MCP connector"]}
            secondaryAction={selected ? { label: "Delete connector", variant: "danger", onClick: () => void remove(selected.id),
                disabled: selectedBusy("delete") } : undefined}
            primaryAction={{ label: saving ? "Saving..." : "Save", icon: saving ? SPINNER : undefined, onClick: () => void save(),
                disabled: !hasChanges || saving || !detail?.draft.name.trim() || !detail.draft.serverUrl.trim() }}
            footerStatus={detail && error ? <span className="text-sm text-red-600">{error}</span> : null}>
            {selected && detail && <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto pb-4">
                <McpConnectorFields key={selected.id} draft={detail.draft}
                    tokenPlaceholder={selected.hasAuthConfig ? "Saved token encrypted" : "Bearer token"}
                    onClearToken={selected.hasAuthConfig ? () => void apply(`clear-token:${selected.id}`, async () => {
                        const saved = await updateMcpConnector(selected.id, { bearerToken: null });
                        updateDetail({ draft: connectorDraft(saved) }, selected.id);
                        return saved;
                    }, true) : undefined}
                    clearingToken={selectedBusy("clear-token")} onDraftChange={(draft) => updateDetail({ draft })} />
                <div className="flex min-h-0 flex-1 flex-col">
                    <button type="button" title="Refresh tools" aria-label="Refresh tools" disabled={selectedBusy("refresh")}
                        onClick={() => void sensitive(`refresh:${selected.id}`, async () => void await refreshConnector(selected))}
                        className="mb-2 self-end text-gray-500 hover:text-gray-900 disabled:text-gray-300">
                        {selectedBusy("refresh") ? SPINNER : <RefreshCw className="size-4" />}</button>
                    {detail.loading ? <div className="min-h-24 flex-1 rounded-lg border border-gray-100 bg-gray-50" />
                        : <McpToolList connector={selected} busyKey={busyKey}
                            onToolEnabled={(connectorId, toolId, enabled) =>
                                apply(`tool:${toolId}`, () => setMcpToolEnabled(connectorId, toolId, enabled))} />}
                </div>
            </div>}
        </Modal>
        {mfaPopup}
    </SettingsSection>;
}
