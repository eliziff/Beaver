import type { ComponentType } from "react";
import {
  createBrowserRouter,
  Navigate,
  RouterProvider,
  useParams,
  type RouteObject,
} from "react-router-dom";
import AppShell from "@/app/(pages)/layout";
import RouteError from "@/app/error";
import Root from "@/app/layout";

type PageModule = { default: ComponentType };
type LazyRoute = NonNullable<RouteObject["lazy"]>;

const page = (load: () => Promise<PageModule>): LazyRoute => async () => ({
  Component: (await load()).default,
});
const namedPage = <Module, Key extends keyof Module>(
  load: () => Promise<Module>,
  name: Key,
): LazyRoute => async () => ({
  Component: (await load())[name] as ComponentType,
});
const route = (
  path: string,
  lazy: LazyRoute,
  extra: { handle?: unknown; children?: RouteObject[] } = {},
): RouteObject => ({ path, lazy, ...extra });

const libraryPage = (kind: "files" | "templates"): LazyRoute => async () => {
  const { LibraryCollectionPage } = await import(
    "@/app/components/library/LibraryWorkspace"
  );
  return { Component: () => <LibraryCollectionPage kind={kind} /> };
};
const workflowPage = (
  workflowType: "assistant" | "tabular",
): LazyRoute => async () => {
  const { WorkflowDetailPage } = await import(
    "@/app/components/workflows/WorkflowDetailPage"
  );
  return {
    Component: () => {
      const { id = "" } = useParams<{ id: string }>();
      return <WorkflowDetailPage id={id} workflowType={workflowType} />;
    },
  };
};
const reviewPage = (insideProject: boolean): LazyRoute => async () => {
  const { TRView } = await import("@/app/components/tabular/TabularReviewView");
  return {
    Component: () => {
      const { id = "", reviewId = "" } = useParams<{
        id: string;
        reviewId: string;
      }>();
      return (
        <TRView
          reviewId={insideProject ? reviewId : id}
          projectId={insideProject ? id : undefined}
        />
      );
    },
  };
};
const sourcePage: LazyRoute = async () => {
  const { LegalLibrarySourcePage } = await import("@/app/components/legal/LegalLibrary");
  return {
    Component: () => {
      const { id = "" } = useParams<{ id: string }>();
      return <LegalLibrarySourcePage referenceId={id} />;
    },
  };
};

function RouteLoading() {
  return (
    <p className="m-auto p-6 text-sm text-gray-500" role="status">
      Loading…
    </p>
  );
}

const appRoutes: RouteObject[] = [
  route("assistant", page(() => import("@/app/(pages)/assistant/page"))),
  route(
    "assistant/chat/:id",
    page(() => import("@/app/(pages)/assistant/chat/[id]/page")),
  ),
  route("history", page(() => import("@/app/(pages)/history/page")), {
    handle: { localRedirect: "/assistant" },
  }),
  route("projects", namedPage(
    () => import("@/app/components/projects/ProjectsOverview"),
    "ProjectsOverview",
  )),
  route("projects/:id", page(() => import("@/app/(pages)/projects/[id]/layout")), {
    children: [
      {
        index: true,
        lazy: namedPage(
          () => import("@/app/components/projects/ProjectDocumentsView"),
          "ProjectDocumentsView",
        ),
      },
      route("assistant", page(() => import("@/app/(pages)/projects/[id]/assistant/page"))),
      route(
        "assistant/chat/:chatId",
        page(() => import("@/app/(pages)/projects/[id]/assistant/chat/[chatId]/page")),
      ),
      route("tabular-reviews", namedPage(
        () => import("@/app/(pages)/tabular-reviews/page"),
        "ProjectTabularReviewsPage",
      )),
      route("tabular-reviews/:reviewId", reviewPage(true)),
    ],
  }),
  route("workflows", namedPage(
    () => import("@/app/components/workflows/WorkflowList"),
    "WorkflowList",
  )),
  route("workflows/assistant/:id", workflowPage("assistant")),
  route("workflows/tabular-review/:id", workflowPage("tabular")),
  route("tabular-reviews", page(() => import("@/app/(pages)/tabular-reviews/page"))),
  route("tabular-reviews/:id", reviewPage(false)),
  route("sources", namedPage(
    () => import("@/app/components/legal/LegalLibrary"),
    "LegalLibraryPage",
  )),
  route("sources/view", page(() => import("@/app/(pages)/sources/view/page"))),
  route("sources/:id", sourcePage),
  { path: "table-of-authorities", Component: () => null },
  {
    path: "library",
    children: [
      { index: true, lazy: libraryPage("files") },
      route("templates", libraryPage("templates")),
    ],
  },
  route("account", page(() => import("@/app/(pages)/account/layout")), {
    children: [
      {
        index: true,
        handle: { cloudOnly: true },
        lazy: page(() => import("@/app/(pages)/account/page")),
      },
      route("features", page(() => import("@/app/(pages)/account/features/page"))),
      route(
        "privacy-data",
        page(() => import("@/app/(pages)/account/privacy-data/page")),
        { handle: { cloudOnly: true } },
      ),
      route(
        "security",
        page(() => import("@/app/(pages)/account/security/page")),
        { handle: { cloudOnly: true } },
      ),
      route(
        "models",
        page(() => import("@/app/(pages)/account/models/page")),
        { handle: { cloudOnly: true } },
      ),
      route("api-keys", namedPage(
        () => import("@/app/components/settings/ApiKeySettings"),
        "ApiKeySettings",
      )),
      route(
        "connectors",
        page(() => import("@/app/(pages)/account/connectors/page")),
        { handle: { cloudOnly: true } },
      ),
    ],
  }),
];

export const routes: RouteObject[] = [{
  Component: Root,
  ErrorBoundary: RouteError,
  HydrateFallback: RouteLoading,
  children: [
    { index: true, element: <Navigate to="/assistant" replace /> },
    route("login", page(() => import("@/app/login/page"))),
    route("signup", page(() => import("@/app/signup/page"))),
    { Component: AppShell, children: appRoutes },
    route("*", page(() => import("@/app/not-found"))),
  ],
}];

const router = createBrowserRouter(routes);

export function Router() {
  return <RouterProvider router={router} />;
}
