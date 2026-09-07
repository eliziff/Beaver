import { useState, type ComponentType } from "react";
import {
  createBrowserRouter,
  matchRoutes,
  Navigate,
  RouterProvider,
  useMatch,
  useParams,
  type RouteObject,
} from "react-router-dom";
import RouteError from "@/app/error";
import type { LoginGate } from "@/app/components/providers";
import { CollectionState } from "@/app/components/shared/CollectionState";

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

const libraryPage: LazyRoute = async () => {
  const { LibraryCollectionPage, LibraryWorkspaceProvider } = await import(
    "@/app/components/library/LibraryWorkspace"
  );
  function LibraryPage() {
    const kind = useMatch("/library/templates") ? "templates" : "files";
    return <LibraryWorkspaceProvider>
      <LibraryCollectionPage kind={kind} />
    </LibraryWorkspaceProvider>;
  }
  return { Component: LibraryPage };
};
const workflowPage: LazyRoute = async () => {
  const { WorkflowDetailPage } = await import(
    "@/app/components/workflows/WorkflowDetailPage"
  );
  return {
    Component: () => {
      const { id = "" } = useParams<{ id: string }>();
      return <WorkflowDetailPage id={id} />;
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

const appRoutes: RouteObject[] = [
  route("assistant", page(() => import("@/app/(pages)/assistant/page"))),
  route(
    "assistant/chat/:id",
    page(() => import("@/app/(pages)/assistant/chat/[id]/page")),
  ),
  route("history", page(() => import("@/app/(pages)/history/page"))),
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
  route("workflows/:id", workflowPage),
  route("tabular-reviews", page(() => import("@/app/(pages)/tabular-reviews/page"))),
  route("tabular-reviews/:id", reviewPage(false)),
  route("sources", namedPage(
    () => import("@/app/components/legal/LegalLibrary"),
    "LegalLibraryPage",
  )),
  route("sources/view", page(() => import("@/app/(pages)/sources/view/page"))),
  route("sources/:id", sourcePage),
  route("court-records", page(() => import("@/app/(pages)/court-records/page"))),
  route("table-of-authorities", page(() => import("@/app/(pages)/table-of-authorities/page"))),
  route("library/templates?", libraryPage),
  route("account", page(() => import("@/app/(pages)/account/layout")), {
    children: [
      {
        index: true,
        handle: { cloudOnly: true },
        lazy: page(() => import("@/app/(pages)/account/page")),
      },
      route("features", page(() => import("@/app/(pages)/account/features/page"))),
      route("personalisation", namedPage(
        () => import("@/app/components/account/PersonalisationPage"),
        "PersonalisationSettingsPage",
      )),
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
        { handle: { capability: "connectors" } },
      ),
    ],
  }),
];

// Keep runtime-dependent modules behind route.lazy: main imports these route
// definitions while configuration is loading. Matched layouts and pages are
// then downloaded concurrently, rather than behind the entire app shell.
function routes(LoginGate?: LoginGate): RouteObject[] {
  return [{
  lazy: async () => {
    const { default: Root } = await import("@/app/layout");
    return { Component: () => <Root LoginGate={LoginGate} /> };
  },
  ErrorBoundary: RouteError,
  HydrateFallback: () => <CollectionState loading className="m-auto min-h-0 p-6">Loading…</CollectionState>,
  children: [
    { index: true, element: <Navigate to="/assistant" replace /> },
    route("login", page(() => import("@/app/login/page"))),
    route("signup", page(() => import("@/app/signup/page"))),
    route("signup/check-email", namedPage(
      () => import("@/app/components/account/AuthFlowPages"), "CheckEmailPage",
    )),
    route("auth/callback", namedPage(
      () => import("@/app/components/account/AuthFlowPages"), "AuthCallbackPage",
    )),
    route("forgot-password", namedPage(
      () => import("@/app/components/account/AuthFlowPages"), "ForgotPasswordPage",
    )),
    route("reset-password", namedPage(
      () => import("@/app/components/account/AuthFlowPages"), "ResetPasswordPage",
    )),
    route("onboarding", namedPage(
      () => import("@/app/components/account/PersonalisationPage"), "OnboardingPage",
    )),
    route("word", namedPage(
      () => import("@/app/components/word/WordPage"), "WordPage",
    )),
    route("word.html", namedPage(
      () => import("@/app/components/word/WordPage"), "WordPage",
    )),
    { lazy: page(() => import("@/app/(pages)/layout")), children: appRoutes },
    route("*", page(() => import("@/app/not-found"))),
  ],
}];
}

const preloaded = new WeakSet<RouteObject>();
export async function preloadAppRoute(pathname: string) {
  await Promise.all((matchRoutes(appRoutes, pathname) ?? []).map(async ({ route }) => {
    if (typeof route.lazy !== "function" || preloaded.has(route)) return;
    preloaded.add(route);
    try { await route.lazy(); }
    catch { preloaded.delete(route); } // Actual navigation still owns its error UI/retry.
  }));
}

export function Router({ LoginGate }: { LoginGate?: LoginGate }) {
  const [router] = useState(() => createBrowserRouter(routes(LoginGate)));
  return <RouterProvider router={router} />;
}
