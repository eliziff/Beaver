import type { Router } from "express";
import type { ChatStore } from "./lib/chatStore";
import type { ChatApplication } from "./lib/chat/chatApplication";
import type { DocumentStore } from "./lib/documentStore";
import type { LibraryStore } from "./lib/libraryStore";
import { isAnonymousLocalMode } from "./lib/localMode";
import type { ProjectStore } from "./lib/projectStore";
import type { TabularStore } from "./lib/tabularStore";

const lazy = <T>(load: () => Promise<T>) => {
  let value: Promise<T> | undefined;
  return () => value ??= load();
};
const local = isAnonymousLocalMode();
const documents = lazy<DocumentStore>(async () => {
  const { createDocumentApplication } = await import("./lib/documentApplication");
  const store = local
    ? createDocumentApplication(
        (await import("./lib/localDocumentStore")).localDocumentRepository,
        (await import("./lib/localObjectStorage")).localDocumentObjects(),
      )
    : createDocumentApplication(
        (await import("./lib/cloudDocumentRepository")).cloudDocumentRepository,
        (await import("./lib/cloudObjectStorage")).cloudDocumentObjects(),
      );
  await store.resumeCleanup();
  return store;
});
const library = lazy<LibraryStore>(async () => local
  ? (await import("./lib/localLibraryStore")).createLocalLibraryStore(await documents())
  : (await import("./lib/cloudLibraryStore")).createCloudLibraryStore(await documents()));
const tabular = lazy<TabularStore>(() => local
  ? import("./lib/localTabularStore").then(({ localTabularData }) => localTabularData)
  : import("./lib/cloudTabularStore").then(({ cloudTabularData }) => cloudTabularData));
const chats = lazy<ChatStore>(async () => local
  ? (await import("./lib/localChatStore")).createLocalChatStore(await tabular())
  : (await import("./lib/cloudChatStore")).createCloudChatStore(await tabular()));
const projects = lazy<ProjectStore>(async () => local
  ? (await import("./lib/localProjectStore")).createLocalProjectStore(await documents())
  : (await import("./lib/cloudProjectStore")).createCloudProjectStore(await documents()));
const chat = lazy<ChatApplication>(async () => {
  const [{ createChatApplication }, features, chatStore, documentStore,
    libraryStore, projectStore, tabularStore] =
    await Promise.all([
      import("./lib/chat/chatApplication"),
      local
        ? import("./lib/chat/localChatApplicationFeatures")
          .then(({ localChatApplicationFeatures }) => localChatApplicationFeatures)
        : import("./lib/chat/cloudChatApplicationFeatures")
          .then(({ cloudChatApplicationFeatures }) => cloudChatApplicationFeatures),
      chats(), documents(), library(), projects(), tabular(),
    ]);
  return createChatApplication({
    chats: chatStore,
    documents: documentStore,
    library: libraryStore,
    projects: projectStore,
    tabular: tabularStore,
    features,
  });
});
export const runtime = {
  mode: local ? "anonymous-local" as const : "cloud" as const,
  initialize: () => documents().then(() => undefined),
  chat,
  chats,
  documents,
  library,
  projects,
  tabular,
  documentExtensions: lazy(async () => local
    ? (await import("./routes/localDocuments")).localDocumentExtensionsRouter
    : null) as () => Promise<Router | null>,
  libraryExtensions: lazy(async () => local
    ? (await import("./routes/localLibraryExtensions"))
      .createLocalLibraryExtensionsRouter(await documents())
    : null) as () => Promise<Router | null>,
};
