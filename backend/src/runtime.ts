import { createChatApplication, type ChatApplicationFeatures } from "./lib/chat/chatApplication";
import { availableParallelism, totalmem } from "node:os";
import type { ChatToolContext } from "./lib/chat/turnEngine";
import { toolText, type BeaverTool } from "./lib/chat/toolRegistry";
import { createChatStore, type ChatScope } from "./lib/chatStore";
import { generateChatTitle } from "./lib/chatTitle";
import { createDocumentApplication } from "./lib/documentApplication";
import { encryptionSecret } from "./lib/secretEncryption";
import { createLibraryStore } from "./lib/libraryStore";
import { isLocalRuntime } from "./lib/localMode";
import { createProjectStore } from "./lib/projectStore";
import { createTabularApplication } from "./lib/tabular/application";
import { publicOrigin } from "./lib/publicOrigin";
import { safeErrorLog } from "./lib/safeError";

const lazy = <T>(load: () => Promise<T>) => {
  let value: Promise<T> | undefined;
  return () => value ??= load();
};
const local = isLocalRuntime();
function enabled(name: string, fallback: boolean) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}
const capabilities = { connectors: enabled("MCP_CONNECTORS_ENABLED", !local) };
const preparationWorkers = Math.min(4,
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
  const [repositories, shared] = await Promise.all([
    import("./lib/relationalRepositories"), import("./lib/providerSessionFeatures"),
  ]);
  const features = { ...shared.providerSessionFeatures, ...(local ? {}
    : (await import("./lib/postgresChatFeatures")).postgresChatFeatures) };
  const objects = local
    ? (await import("./lib/filesystemObjectStorage")).filesystemDocumentObjects()
    : await import("./lib/storage").then((storage) => storage.scopeObjectStorage(
      storage.createS3ObjectStorage(storage.readS3Configuration()), "documents"));
  return { documents: repositories.documentRepository,
    features,
    library: repositories.libraryRepository, projects: repositories.projectRepository,
    tabular: repositories.tabularRepository, chats: repositories.chatRepository,
    workflows: repositories.workflowRepository,
    workflowCollaboration: repositories.workflowCollaboration,
    objects };
});
const documents = lazy(async () => {
  const ports = await persistence();
  return createDocumentApplication(ports.documents, ports.objects);
});
const library = lazy(async () => createLibraryStore((await persistence()).library, await documents()));
const tabular = lazy(async () => createTabularApplication(
  (await persistence()).tabular, await documents(), await projects()));
const chats = lazy(async () => {
  const contexts = {
    project: async (scope: ChatScope, id: string) => !!await (await projects()).get(scope, id),
    review: async (scope: ChatScope, id: string) => {
      try { await (await tabular()).detail(scope, id); return true; }
      catch (error) { if ((error as { status?: number }).status === 404) return false; throw error; }
    },
  };
  return createChatStore((await persistence()).chats, generateChatTitle, contexts);
});
const projects = lazy(async () => createProjectStore((await persistence()).projects, await documents()));
const workflows = lazy(async () => {
  const ports = await persistence();
  return { repository: ports.workflows, collaboration: ports.workflowCollaboration };
});
const legalSources = lazy(async () => (await import("./lib/legalSourceStore"))
  .createLegalSourceStore(await (await import("./lib/relationalDatabase")).relationalDatabase()));
const audit = lazy(async () => (await import("./lib/audit"))
  .createAuditStore(await (await import("./lib/relationalDatabase")).relationalDatabase()));
const jobs = lazy(async () => {
  const [{ startJobWorker }, { pdfJobHandlers }, { providerPdfJobHandlers }, documentStore] = await Promise.all([
    import("./lib/jobQueue"),
    import("./lib/pdfJobs"),
    import("./lib/providerPdfLibraryBridge"),
    documents(),
  ]);
  const handlers = {
    ...pdfJobHandlers(documentStore),
    ...providerPdfJobHandlers(),
  };
  const workers = Array.from({ length: preparationWorkers }, () => startJobWorker(handlers));
  return { stop: () => Promise.all(workers.map((worker) => worker.stop())) };
});
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
  const [chatStore, documentStore, libraryStore, projectStore, tabularStore, ports] = await Promise.all([chats(), documents(), library(), projects(), tabular(), persistence()]);
  return createChatApplication({ chats: chatStore, documents: documentStore,
    library: libraryStore, projects: projectStore, tabular: tabularStore,
    features: { ...ports.features, audit(auth, input) {
      void audit().then((store) => store.recordChatTurn({ userId: auth.userId,
        userEmail: auth.userEmail, chatId: input.chatId, projectId: input.projectId,
        title: input.title, model: input.model,
        ...(input.status ? { status: input.status } : {}) }, input.events))
        .catch((error) => console.error("[audit] unavailable", safeErrorLog(error)));
    }, async load(auth) {
      const loadedFeatures: ReturnType<ChatApplicationFeatures["load"]> =
        ports.features.load?.(auth) ?? Promise.resolve({ includeResearchTools: true });
      const [loaded, custom, extraTools, { SYSTEM_ASSISTANT_WORKFLOWS }] = await Promise.all([
        loadedFeatures,
        (await workflows()).repository(auth).assistants(),
        connectorTools(auth.userId),
        import("./lib/systemWorkflows"),
      ]);
      return { ...loaded, extraTools: [...loaded.extraTools ?? [], ...extraTools], workflows: new Map([
        ...SYSTEM_ASSISTANT_WORKFLOWS.map((item) => [item.id, item] as const),
        ...custom,
      ]) };
    } },
  });
});
const shutdown = lazy(async () => {
  const tasks: Promise<unknown>[] = [
    jobs().then((worker) => worker.stop()),
    import("./lib/llm/codexAppServer")
      .then(({ shutdownCodexAppServers }) => shutdownCodexAppServers()),
    import("./lib/tableOfAuthorities")
      .then(({ shutdownTableOfAuthorities }) => shutdownTableOfAuthorities()),
  ];
  tasks.push(import("./lib/relationalDatabase")
    .then(({ closeRelationalDatabase }) => closeRelationalDatabase()));
  await Promise.all(tasks);
});
export const runtime = { mode: local ? "local" as const : "cloud" as const, capabilities,
  initialize: async () => {
    if (!local) encryptionSecret("USER_API_KEYS_ENCRYPTION_SECRET");
    if (capabilities.connectors) {
      encryptionSecret("MCP_CONNECTORS_ENCRYPTION_SECRET");
      publicOrigin();
    }
    await (await documents()).resumeCleanup();
    await jobs();
  }, chat, chats, documents,
  audit, connectors, legalSources, library, projects, tabular, workflows, shutdown };
