import { createChatApplication } from "./lib/chat/chatApplication";
import { createChatStore, type ChatScope } from "./lib/chatStore";
import { generateChatTitle } from "./lib/chatTitle";
import { createDocumentApplication } from "./lib/documentApplication";
import { createLibraryStore } from "./lib/libraryStore";
import { isLocalRuntime } from "./lib/localMode";
import { createProjectStore } from "./lib/projectStore";
import { createTabularApplication } from "./lib/tabular/application";

const lazy = <T>(load: () => Promise<T>) => {
  let value: Promise<T> | undefined;
  return () => value ??= load();
};
const local = isLocalRuntime();
const persistence = lazy(async () => {
  if (local) {
    const [sqlite, project, tabular, chat, workflow, objects, features] = await Promise.all([
      import("./lib/sqlitePersistence"), import("./lib/sqliteProjectRepository"),
      import("./lib/sqliteTabularRepository"), import("./lib/sqliteChatRepository"),
      import("./lib/sqliteWorkflowRepository"),
      import("./lib/filesystemObjectStorage"), import("./lib/sqliteChatFeatures"),
    ]);
    return { documents: sqlite.sqliteDocumentRepository, features: features.sqliteChatFeatures,
      library: sqlite.sqliteLibraryRepository, projects: project.sqliteProjectRepository,
      tabular: tabular.sqliteTabularRepository, chats: chat.sqliteChatRepository,
      workflows: workflow.sqliteWorkflowRepository, workflowCollaboration: undefined,
      objects: objects.filesystemDocumentObjects() };
  }
  const [documents, library, projects, tabular, chats, workflows, objects, features] = await Promise.all([
    import("./lib/postgresDocumentRepository"), import("./lib/postgresLibraryRepository"),
    import("./lib/postgresProjectRepository"), import("./lib/postgresTabularRepository"),
    import("./lib/postgresChatRepository"), import("./lib/postgresWorkflowRepository"),
    import("./lib/s3ObjectStorage"),
    import("./lib/postgresChatFeatures"),
  ]);
  return { documents: documents.postgresDocumentRepository,
    features: features.postgresChatFeatures,
    library: library.postgresLibraryRepository, projects: projects.postgresProjectRepository,
    tabular: tabular.postgresTabularRepository, chats: chats.postgresChatRepository,
    workflows: workflows.postgresWorkflowRepository,
    workflowCollaboration: workflows.postgresWorkflowCollaboration,
    objects: objects.s3DocumentObjects() };
});
const documents = lazy(async () => {
  const ports = await persistence(), store = createDocumentApplication(ports.documents, ports.objects);
  await store.resumeCleanup();
  return store;
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
const modelApiKeys = async (userId: string) => {
  if (local) return undefined;
  const [{ getUserModelSettings }, { createServerSupabase }] = await Promise.all([import("./lib/userSettings"), import("./lib/supabase")]);
  return (await getUserModelSettings(userId, createServerSupabase())).api_keys;
};
const chat = lazy(async () => {
  const [chatStore, documentStore, libraryStore, projectStore, tabularStore, ports] = await Promise.all([chats(), documents(), library(), projects(), tabular(), persistence()]);
  return createChatApplication({ chats: chatStore, documents: documentStore,
    library: libraryStore, projects: projectStore, tabular: tabularStore,
    features: { ...ports.features, async load(auth) {
      const [loaded, custom, { SYSTEM_ASSISTANT_WORKFLOWS }] = await Promise.all([
        ports.features.load?.(auth) ?? {},
        (await workflows()).repository(auth).assistants(),
        import("./lib/systemWorkflows"),
      ]);
      return { includeResearchTools: true, ...loaded, workflows: new Map([
        ...SYSTEM_ASSISTANT_WORKFLOWS.map((item) => [item.id, item] as const),
        ...custom,
      ]) };
    } },
  });
});
const shutdown = lazy(async () => {
  const tasks: Promise<unknown>[] = [
    import("./lib/llm/codexAppServer")
      .then(({ shutdownCodexAppServers }) => shutdownCodexAppServers()),
  ];
  if (local) tasks.push(import("./lib/sqliteDatabase")
    .then(({ closeSqliteDatabase }) => closeSqliteDatabase()));
  await Promise.all(tasks);
});
export const runtime = { mode: local ? "local" as const : "cloud" as const,
  initialize: () => documents().then(() => undefined), chat, chats, documents,
  library, projects, tabular, workflows, modelApiKeys, shutdown };
