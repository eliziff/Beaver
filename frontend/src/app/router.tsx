import type { ComponentType } from "react";
import {
  createBrowserRouter,
  Navigate,
  RouterProvider,
  type RouteObject,
} from "react-router-dom";
import AppShell from "@/app/(pages)/layout";
import RouteError from "@/app/error";
import Root from "@/app/layout";

type PageModule = { default: ComponentType };
const page = (load: () => Promise<PageModule>) => async () => ({
  Component: (await load()).default,
});
const route = (
  path: string,
  load: () => Promise<PageModule>,
  children?: RouteObject[],
): RouteObject & { index?: false } => ({ path, lazy: page(load), children });

const projectRoutes = [
  route("assistant", () => import("@/app/(pages)/projects/[id]/assistant/page")),
  route("assistant/chat/:chatId", () => import("@/app/(pages)/projects/[id]/assistant/chat/[chatId]/page")),
  route("tabular-reviews", () => import("@/app/(pages)/projects/[id]/tabular-reviews/page")),
  route("tabular-reviews/:reviewId", () => import("@/app/(pages)/projects/[id]/tabular-reviews/[reviewId]/page")),
];

const appRoutes: RouteObject[] = [
  route("assistant", () => import("@/app/(pages)/assistant/page")),
  route("assistant/chat/:id", () => import("@/app/(pages)/assistant/chat/[id]/page")),
  route("history", () => import("@/app/(pages)/history/page")),
  route("projects", () => import("@/app/(pages)/projects/page")),
  {
    ...route("projects/:id", () => import("@/app/(pages)/projects/[id]/layout"), projectRoutes),
    children: [
      { index: true, lazy: page(() => import("@/app/(pages)/projects/[id]/page")) },
      ...projectRoutes,
    ],
  },
  route("workflows", () => import("@/app/(pages)/workflows/page")),
  route("workflows/assistant/:id", () => import("@/app/(pages)/workflows/assistant/[id]/page")),
  route("workflows/tabular-review/:id", () => import("@/app/(pages)/workflows/tabular-review/[id]/page")),
  route("tabular-reviews", () => import("@/app/(pages)/tabular-reviews/page")),
  route("tabular-reviews/:id", () => import("@/app/(pages)/tabular-reviews/[id]/page")),
  route("sources", () => import("@/app/(pages)/sources/page")),
  route("sources/view", () => import("@/app/(pages)/sources/view/page")),
  route("sources/:id", () => import("@/app/(pages)/sources/[id]/page")),
  route("table-of-authorities", () => import("@/app/(pages)/table-of-authorities/page")),
  {
    ...route("library", () => import("@/app/(pages)/library/(documents)/layout")),
    children: [
      { index: true, lazy: page(() => import("@/app/(pages)/library/(documents)/page")) },
      route("templates", () => import("@/app/(pages)/library/(documents)/templates/page")),
    ],
  },
  {
    ...route("account", () => import("@/app/(pages)/account/layout")),
    children: [
      { index: true, lazy: page(() => import("@/app/(pages)/account/page")) },
      route("features", () => import("@/app/(pages)/account/features/page")),
      route("privacy-data", () => import("@/app/(pages)/account/privacy-data/page")),
      route("security", () => import("@/app/(pages)/account/security/page")),
      route("models", () => import("@/app/(pages)/account/models/page")),
      route("api-keys", () => import("@/app/(pages)/account/api-keys/page")),
      route("connectors", () => import("@/app/(pages)/account/connectors/page")),
    ],
  },
];

const router = createBrowserRouter([{
  Component: Root,
  ErrorBoundary: RouteError,
  children: [
    { index: true, element: <Navigate to="/assistant" replace /> },
    route("login", () => import("@/app/login/page")),
    route("signup", () => import("@/app/signup/page")),
    { Component: AppShell, children: appRoutes },
    route("*", () => import("@/app/not-found")),
  ],
}]);

export function Router() {
  return <RouterProvider router={router} />;
}
