import type { Router } from "express";
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
const projects = lazy<ProjectStore>(() => local
  ? import("./lib/localProjectStore").then(({ localProjects }) => localProjects)
  : import("./lib/cloudProjectStore").then(({ cloudProjects }) => cloudProjects));
const tabular = lazy<TabularStore>(() => local
  ? import("./lib/localTabularStore").then(({ localTabularData }) => localTabularData)
  : import("./lib/cloudTabularStore").then(({ cloudTabularData }) => cloudTabularData));
const extension = (path: "./routes/localDocuments" | "./routes/localLibraryExtensions") =>
  local ? import(path) : Promise.resolve(null);

export const runtime = {
  mode: local ? "anonymous-local" as const : "cloud" as const,
  documents,
  library,
  projects,
  tabular,
  documentExtensions: lazy(() => extension("./routes/localDocuments").then(
    (module) => module?.localDocumentExtensionsRouter ?? null)) as () => Promise<Router | null>,
  libraryExtensions: lazy(() => extension("./routes/localLibraryExtensions").then(
    (module) => module?.localLibraryExtensionsRouter ?? null)) as () => Promise<Router | null>,
};
