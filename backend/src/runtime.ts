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
const documents = lazy<DocumentStore>(() => local
  ? import("./lib/localLibraryStore").then(({ localDocuments }) => localDocuments)
  : import("./lib/cloudDocumentStore").then(({ cloudDocuments }) => cloudDocuments));
const library = lazy<LibraryStore>(() => local
  ? import("./lib/localLibraryStore").then(({ localLibraryStore }) => localLibraryStore)
  : import("./lib/cloudLibraryStore").then(({ cloudLibraryStore }) => cloudLibraryStore));
const tabular = lazy<TabularStore>(() => local
  ? import("./lib/localTabularStore").then(({ localTabularData }) => localTabularData)
  : import("./lib/cloudTabularStore").then(({ cloudTabularData }) => cloudTabularData));
const chats = lazy<ChatStore>(async () => local
  ? (await import("./lib/localChatStore")).createLocalChatStore(await tabular())
  : (await import("./lib/cloudChatStore")).createCloudChatStore(await tabular()));
const projects = lazy<ProjectStore>(() => local
  ? import("./lib/localProjectStore").then(({ localProjects }) => localProjects)
  : import("./lib/cloudProjectStore").then(({ cloudProjects }) => cloudProjects));
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
const extension = (path: "./routes/localDocuments" | "./routes/localLibraryExtensions") =>
  local ? import(path) : Promise.resolve(null);

export const runtime = {
  mode: local ? "anonymous-local" as const : "cloud" as const,
  chat,
  chats,
  documents,
  library,
  projects,
  tabular,
  documentExtensions: lazy(() => extension("./routes/localDocuments").then(
    (module) => module?.localDocumentExtensionsRouter ?? null)) as () => Promise<Router | null>,
  libraryExtensions: lazy(() => extension("./routes/localLibraryExtensions").then(
    (module) => module?.localLibraryExtensionsRouter ?? null)) as () => Promise<Router | null>,
};
