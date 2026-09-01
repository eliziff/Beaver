import { createChatApplication, type ChatApplicationFeatures } from "./lib/chat/chatApplication";
import { availableParallelism, constants, setPriority, totalmem } from "node:os";
import type { ChatToolContext } from "./lib/chat/turnEngine";
import { toolText, type BeaverTool } from "./lib/chat/toolRegistry";
import { createChatStore, type ChatScope, type ChatStore } from "./lib/chatStore";
import { generateChatTitle } from "./lib/chatTitle";
import { createDocumentApplication } from "./lib/documentApplication";
import { encryptionSecret } from "./lib/secretEncryption";
import { createLibraryStore } from "./lib/libraryStore";
import { isLocalRuntime } from "./lib/localMode";
import { createProjectStore } from "./lib/projectStore";
import { createTabularApplication } from "./lib/tabular/application";
import { durableTabularAgents, tabularAgentJobHandler,
  TABULAR_AGENT_JOB } from "./lib/tabular/agents";
import { publicOrigin } from "./lib/publicOrigin";
import { safeErrorLog } from "./lib/safeError";
import { structureNative } from "./lib/structureNative";
import {
  userPersonalisationPrompt,
} from "./lib/userPreferences";
import { createUserApplication, type UserApplication } from "./lib/userApplication";
import type { UserCredentials } from "./lib/userCredentials";
import type { AuthoritiesWorkspaceApplication } from "./lib/authoritiesWorkspaceApplication";
import type { CourtRecordsApplication } from "./lib/courtRecordsApplication";

type Lazy<T> = (() => Promise<T>) & { loaded: () => Promise<T> | undefined };
const lazy = <T>(load: () => Promise<T>): Lazy<T> => {
  let value: Promise<T> | undefined;
  const get = (() => value ??= load()) as Lazy<T>;
  get.loaded = () => value;
  return get;
};
const backgroundTasks = new Set<Promise<unknown>>();
function background(task: Promise<unknown>, message: string) {
  const handled = task.catch((error) => console.error(message, safeErrorLog(error)));
  backgroundTasks.add(handled);
  void handled.then(() => backgroundTasks.delete(handled));
}
const local = isLocalRuntime();
if (local) setPriority(constants.priority.PRIORITY_BELOW_NORMAL);
function enabled(name: string, fallback: boolean) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}
const capabilities = { connectors: enabled("MCP_CONNECTORS_ENABLED", !local) };
const preparationWorkers = local ? 1 : Math.min(4,
  Math.max(1, Math.floor(availableParallelism() / 8)),
  Math.max(1, Math.floor(totalmem() / (8 * 1024 ** 3))));
const connectors = lazy(async () => {
  if (!capabilities.connectors) throw new Error("MCP connectors are disabled.");
  const [{ createMcpApplication }, { relationalDatabase }] = await Promise.all([
    import("./lib/mcp/servers"), import("./lib/relationalDatabase"),
  ]);
  return createMcpApplication(await relationalDatabase());
});
const persistence = lazy(async () => {
  const [documentPorts, libraryPorts, projectPorts, tabularPorts, chatPorts,
    workflowPorts, workProductPorts, shared] = await Promise.all([
    import("./lib/relationalDocumentRepository"), import("./lib/relationalLibraryRepository"),
    import("./lib/relationalProjectRepository"), import("./lib/relationalTabularRepository"),
    import("./lib/relationalChatRepository"), import("./lib/relationalWorkflowRepository"),
    import("./lib/relationalWorkProductRepository"),
    import("./lib/providerSessionFeatures"),
  ]);
  const objects = local
    ? (await import("./lib/filesystemObjectStorage")).filesystemDocumentObjects()
    : await import("./lib/storage").then((storage) => storage.scopeObjectStorage(
      storage.createS3ObjectStorage(storage.readS3Configuration()), "documents"));
  return { documents: documentPorts.documentRepository,
    features: shared.providerSessionFeatures,
    library: libraryPorts.libraryRepository, projects: projectPorts.projectRepository,
    tabular: tabularPorts.tabularRepository, chats: chatPorts.chatRepository,
    workflows: workflowPorts.workflowRepository,
    workProducts: workProductPorts.workProductRepository,
    workflowCollaboration: workflowPorts.workflowCollaboration,
    objects };
});
const documents = lazy(async () => {
  const ports = await persistence();
  return createDocumentApplication(ports.documents, ports.objects);
});
const library = lazy(async () => createLibraryStore((await persistence()).library, await documents()));
const cancelChatTurn = async (scope: ChatScope, chatId: string) =>
  (await import("./lib/chatTurnQueue")).durableChatTurns.cancel(scope, chatId);
const chats: Lazy<ChatStore> = lazy(async () => {
  const contexts = {
    project: async (scope: ChatScope, id: string) => !!await (await projects()).get(scope, id),
    review: async (scope: ChatScope, id: string) => {
      try { await (await tabular()).detail(scope, id); return true; }
      catch (error) { if ((error as { status?: number }).status === 404) return false; throw error; }
    },
  };
  return createChatStore((await persistence()).chats,
    async (scope, message) => generateChatTitle(
      await (await user()).modelSettings(scope.userId), message,
    ), contexts, cancelChatTurn);
});
const projects = lazy(async () => createProjectStore((await persistence()).projects,
  await documents(), cancelChatTurn));
const workflows = lazy(async () => {
  const ports = await persistence();
  return { repository: ports.workflows, collaboration: ports.workflowCollaboration };
});
const workProducts = lazy(async () => (await import("./lib/workProductApplication"))
  .createWorkProductApplication((await persistence()).workProducts));
const preferences = lazy(async () => {
  const [repository, database] = await Promise.all([
    import("./lib/relationalUserPreferencesRepository"),
    import("./lib/relationalDatabase").then((value) => value.relationalDatabase()),
  ]);
  return repository.createUserPreferencesRepository(database);
});
const workflowFiles = lazy(async () => (await import("./lib/workflowFiles"))
  .createWorkflowFiles(await documents(), await library(), await preferences(), await projects()));
const user: Lazy<UserApplication> = lazy(async () => {
  const keys = await import("./lib/userApiKeys");
  const db = local ? undefined
    : (await import("./lib/supabase")).createServerSupabase();
  const credentials: UserCredentials = {
    status: async (userId) => db
      ? keys.getUserApiKeyStatus(userId, db) : keys.getEnvironmentApiKeyStatus(),
    keys: async (userId) => db
      ? keys.getUserApiKeys(userId, db) : keys.getEnvironmentApiKeys(),
    environmentConfigured: keys.hasEnvApiKey,
    ...(db ? { save: (userId, provider, value) =>
      keys.saveUserApiKey(userId, provider, value, db) } : {}),
  };
  const cloud = db ? (await import("./lib/supabaseUserAccount"))
    .createSupabaseUserAccount(db, documents, preferences) : undefined;
  return createUserApplication({ preferences, credentials, cloud,
    connectors: capabilities.connectors ? connectors : undefined,
    deleteAll: (kind, scope) => kind === "chats"
      ? chats().then((value) => value.deleteAll(scope))
      : kind === "projects" ? projects().then((value) => value.deleteAll(scope))
        : tabular().then((value) => value.deleteAll(scope)),
    recordExport(kind, scope) {
      const action = { account: "export.account", chats: "export.chats",
        "tabular-reviews": "export.tabular" }[kind];
      background(audit().then((store) => store.record({ userId: scope.userId,
        userEmail: scope.userEmail, action, surface: "account" })),
      "[audit] unavailable");
    },
  });
});
const tabular: Lazy<ReturnType<typeof createTabularApplication>> = lazy(async () =>
  createTabularApplication(
  (await persistence()).tabular, await documents(), await projects(),
  { agents: durableTabularAgents,
    settings: (userId) => user().then((value) => value.modelSettings(userId)) }));
const authoritiesWorkspace = lazy(async () =>
  (await import("./lib/authoritiesWorkspaceApplication"))
    .createAuthoritiesWorkspaceApplication(
      await documents(), await workProducts(), await workflowFiles()));
const courtRecords = lazy(async () => (await import("./lib/courtRecordsApplication"))
  .createCourtRecordsApplication(await documents(), await workflowFiles(), await workProducts()));
const chatAuthorities: Pick<AuthoritiesWorkspaceApplication,
  "importDraft" | "act" | "refresh" | "refreshInput" | "prepareSources" |
    "discrepancies" | "build" |
    "addReceipts" | "attachLibraryPdf"> = Object.freeze({
  async importDraft(...args) { return (await authoritiesWorkspace()).importDraft(...args); },
  async act(...args) { return (await authoritiesWorkspace()).act(...args); },
  async refresh(...args) { return (await authoritiesWorkspace()).refresh(...args); },
  async refreshInput(...args) { return (await authoritiesWorkspace()).refreshInput(...args); },
  async prepareSources(...args) { return (await authoritiesWorkspace()).prepareSources(...args); },
  async discrepancies(...args) { return (await authoritiesWorkspace()).discrepancies(...args); },
  async build(...args) { return (await authoritiesWorkspace()).build(...args); },
  async addReceipts(...args) { return (await authoritiesWorkspace()).addReceipts(...args); },
  async attachLibraryPdf(...args) {
    return (await authoritiesWorkspace()).attachLibraryPdf(...args);
  },
});
const chatCourtRecords: Pick<CourtRecordsApplication,
  "bindOutput" | "updateDraft"> = Object.freeze({
  async bindOutput(...args) { return (await courtRecords()).bindOutput(...args); },
  async updateDraft(...args) { return (await courtRecords()).updateDraft(...args); },
});
const legalSources = lazy(async () => (await import("./lib/legalSourceStore"))
  .createLegalSourceStore(await (await import("./lib/relationalDatabase")).relationalDatabase()));
const audit = lazy(async () => (await import("./lib/audit"))
  .createAuditStore(await (await import("./lib/relationalDatabase")).relationalDatabase()));
async function startWorkers() {
  const [{ startJobWorker, recoverLocalJobs }, { pdfJobHandlers },
    { providerPdfJobHandlers }, { chatTurnJobHandler, CHAT_TURN_JOB },
    documentStore, chatStore, chatApplication, tabularApplication] = await Promise.all([
    import("./lib/jobQueue"),
    import("./lib/pdfJobs"),
    import("./lib/providerPdfLibraryBridge"),
    import("./lib/chatTurnWorker"),
    documents(),
    chats(),
    chat(),
    tabular(),
  ]);
  const handlers = {
    ...pdfJobHandlers(documentStore),
    ...providerPdfJobHandlers(),
    [CHAT_TURN_JOB]: chatTurnJobHandler(chatApplication, chatStore),
    [TABULAR_AGENT_JOB]: tabularAgentJobHandler(tabularApplication),
  };
  await recoverLocalJobs();
  const workers = Array.from({ length: preparationWorkers }, () => startJobWorker(handlers));
  return { stop: () => Promise.all(workers.map((worker) => worker.stop())) };
}
async function connectorTools(userId: string): Promise<BeaverTool<ChatToolContext>[]> {
  if (!capabilities.connectors) return [];
  const mcp = await connectors();
  return (await mcp.buildUserMcpTools(userId)).map<BeaverTool<ChatToolContext>>((schema) => ({
    ...schema, activity: () => `Using ${schema.name}`,
    async execute(input, context, signal) {
      const { content, event } = await mcp.executeMcpToolCall(userId, schema.name, input, signal);
      context.addEvent(event);
      return { result: toolText(content, event.status === "error") };
    },
  }));
}
const chat = lazy(async () => {
  const [chatStore, documentStore, libraryStore, projectStore, tabularStore,
    workProductApplication, ports] = await Promise.all([
    chats(), documents(), library(), projects(), tabular(), workProducts(),
    persistence(),
  ]);
  return createChatApplication({ chats: chatStore, documents: documentStore,
    library: libraryStore, projects: projectStore, workProducts: workProductApplication,
    tabular: tabularStore,
    authorities: chatAuthorities, courtRecords: chatCourtRecords,
    features: { ...ports.features, audit(auth, input) {
      background(audit().then((store) => store.recordChatTurn({ userId: auth.userId,
        userEmail: auth.userEmail, chatId: input.chatId, projectId: input.projectId,
        title: input.title, model: input.model,
        ...(input.status ? { status: input.status } : {}) }, input.events)),
      "[audit] unavailable");
    }, async load(auth) {
      const loadedFeatures: ReturnType<ChatApplicationFeatures["load"]> =
        ports.features.load?.(auth) ?? Promise.resolve({ includeResearchTools: true });
      const [loaded, account, custom, extraTools, { SYSTEM_ASSISTANT_WORKFLOWS }] = await Promise.all([
        loadedFeatures,
        user().then((value) => value.settings(auth.userId)),
        (await workflows()).repository(auth).assistants(),
        connectorTools(auth.userId),
        import("./lib/systemWorkflows"),
      ]);
      return {
        ...loaded,
        apiKeys: account.models.api_keys,
        includeResearchTools: account.preferences.legalResearchUs,
        productFeatures: account.preferences.features,
        personalisationPrompt: userPersonalisationPrompt(account.preferences),
        draftingStyle: account.preferences.draftingStyle,
        extraTools: [...loaded.extraTools ?? [], ...extraTools], workflows: new Map([
        ...SYSTEM_ASSISTANT_WORKFLOWS.map((item) => [item.variant_id, {
          workflow_id: item.id, title: item.title, skill_md: item.skill_md,
        }] as const),
        ...custom,
      ]) };
    } },
  });
});
const shutdown = lazy(async () => {
  await import("./lib/llm/codexAppServer")
    .then(({ shutdownCodexAppServers }) => shutdownCodexAppServers());
  while (backgroundTasks.size) await Promise.all([...backgroundTasks]);
  await import("./lib/relationalDatabase")
    .then(({ closeRelationalDatabase }) => closeRelationalDatabase());
});
export const runtime = { mode: local ? "local" as const : "cloud" as const, capabilities,
  initialize: async (options: { cleanup?: boolean } = {}) => {
    // Force lazy native citation grammars before the server accepts requests.
    structureNative().hasCitationInText("");
    if (!local) encryptionSecret("USER_API_KEYS_ENCRYPTION_SECRET");
    if (capabilities.connectors) {
      encryptionSecret("MCP_CONNECTORS_ENCRYPTION_SECRET");
      publicOrigin();
    }
    if (options.cleanup !== false) await (await documents()).resumeCleanup();
  }, authoritiesWorkspace, courtRecords, chat, chats, documents,
  audit, background, connectors, legalSources, library, projects, startWorkers, workProducts,
  tabular, workflows, preferences, user, shutdown };
