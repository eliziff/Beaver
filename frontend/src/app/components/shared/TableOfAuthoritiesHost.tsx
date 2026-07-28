"use client";

import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { launchTableOfAuthorities } from "@/app/lib/beaverApi";
import { isAnonymousMode } from "@/app/lib/authMode";
import { PageHeader } from "@/app/components/shared/PageHeader";

const BOOT_TIMEOUT_MS = 15_000;
const JOB_ID = /^[0-9a-f]{32}$/;
const PROJECT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const localFrameUrl = (() => {
  if (!isAnonymousMode) return null;
  const url = new URL(
    process.env.NEXT_PUBLIC_TABLE_OF_AUTHORITIES_URL ??
      "http://127.0.0.1:8765",
  );
  url.searchParams.set("mode", "mike");
  url.searchParams.set("attempt", "");
  return url.toString();
})();
const warmedService =
  typeof window !== "undefined" && isAnonymousMode
    ? launchTableOfAuthorities()
    : null;
void warmedService?.catch(() => {});

interface TableOfAuthoritiesHostProps {
  active: boolean;
  enabled: boolean;
}

type AuthoritiesScope = {
  job: string;
  project: string;
};

function ScopeReader({
  active,
  onChange,
}: {
  active: boolean;
  onChange: (scope: AuthoritiesScope) => void;
}) {
  const searchParams = useSearchParams();
  const job = JOB_ID.test(searchParams.get("job") || "")
    ? searchParams.get("job")!
    : "";
  const project = PROJECT_ID.test(searchParams.get("project") || "")
    ? searchParams.get("project")!
    : "";

  useLayoutEffect(() => {
    if (active) onChange({ job, project });
  }, [active, job, onChange, project]);

  return null;
}

function AuthoritiesShell({
  active,
  busy,
  children,
}: {
  active: boolean;
  busy: boolean;
  children: ReactNode;
}) {
  return (
    <div
      data-testid="authorities-host"
      aria-hidden={!active}
      inert={!active}
      className={`absolute inset-0 flex min-h-0 min-w-0 flex-col overflow-hidden bg-[#f3f4f6] ${
        active ? "" : "pointer-events-none opacity-0"
      }`}
    >
      <PageHeader shrink>
        <h1 className="font-serif text-2xl font-medium text-gray-900">
          Authorities
        </h1>
      </PageHeader>
      <div
        className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
        aria-busy={busy}
      >
        {children}
      </div>
    </div>
  );
}

export function TableOfAuthoritiesHost({
  active,
  enabled,
}: TableOfAuthoritiesHostProps) {
  const [scope, setScope] = useState<AuthoritiesScope>({
    job: "",
    project: "",
  });
  const [url, setUrl] = useState<string | null>(localFrameUrl);
  const [frameReady, setFrameReady] = useState(Boolean(localFrameUrl));
  const [frameScope, setFrameScope] = useState(
    localFrameUrl ? ":" : "",
  );
  const [error, setError] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const urlRef = useRef(localFrameUrl ?? "");
  const expectedOriginRef = useRef(
    localFrameUrl ? new URL(localFrameUrl).origin : "",
  );
  const attemptRef = useRef("");
  const watchdogRef = useRef<number | null>(null);
  const serviceRef = useRef(warmedService);

  const onScopeChange = useCallback((next: AuthoritiesScope) => {
    setScope((current) =>
      current.job === next.job && current.project === next.project
        ? current
        : next,
    );
  }, []);

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current !== null) {
      window.clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  const startWatchdog = useCallback(
    (attempt: string) => {
      clearWatchdog();
      watchdogRef.current = window.setTimeout(() => {
        if (attemptRef.current !== attempt) return;
        watchdogRef.current = null;
        setFrameReady(false);
        setError("Table of Authorities took too long to start.");
      }, BOOT_TIMEOUT_MS);
    },
    [clearWatchdog],
  );

  const pingFrame = useCallback(() => {
    if (!frameRef.current?.contentWindow || !expectedOriginRef.current) return;
    frameRef.current.contentWindow.postMessage(
      { type: "mike:table-of-authorities-probe" },
      expectedOriginRef.current,
    );
  }, []);

  useEffect(() => {
    const onReady = (event: MessageEvent) => {
      if (
        event.source !== frameRef.current?.contentWindow ||
        event.origin !== expectedOriginRef.current
      ) {
        return;
      }
      const data = event.data;
      if (
        !data ||
        typeof data !== "object" ||
        data.attempt !== attemptRef.current
      ) {
        return;
      }
      if (data.type === "mike:table-of-authorities-ready") {
        clearWatchdog();
        setError(null);
        setFrameReady(true);
      } else if (data.type === "mike:table-of-authorities-error") {
        clearWatchdog();
        setFrameReady(false);
        setError(
          typeof data.message === "string"
            ? data.message
            : "Table of Authorities could not be started.",
        );
      }
    };
    window.addEventListener("message", onReady);
    if (urlRef.current) {
      startWatchdog(attemptRef.current);
      pingFrame();
    }
    return () => window.removeEventListener("message", onReady);
  }, [clearWatchdog, pingFrame, startWatchdog]);

  useEffect(
    () => () => {
      clearWatchdog();
    },
    [clearWatchdog],
  );

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    if (!serviceRef.current) {
      serviceRef.current = launchTableOfAuthorities();
    }
    serviceRef.current
      .then((service) => {
        if (!live) return;
        const signature = `${scope.job}:${scope.project}`;
        const serviceUrl = new URL(service.url);
        const currentOrigin = urlRef.current
          ? new URL(urlRef.current).origin
          : "";
        if (
          urlRef.current &&
          frameScope === signature &&
          currentOrigin === serviceUrl.origin
        ) {
          pingFrame();
          return;
        }
        const attempt = crypto.randomUUID();
        serviceUrl.searchParams.set("mode", "mike");
        serviceUrl.searchParams.set("attempt", attempt);
        if (scope.job) serviceUrl.searchParams.set("job", scope.job);
        if (scope.project) {
          serviceUrl.searchParams.set("project", scope.project);
        }
        setFrameScope(signature);
        urlRef.current = serviceUrl.toString();
        expectedOriginRef.current = serviceUrl.origin;
        attemptRef.current = attempt;
        setError(null);
        setFrameReady(false);
        startWatchdog(attempt);
        setUrl(urlRef.current);
      })
      .catch((reason: unknown) => {
        if (!live) return;
        clearWatchdog();
        setFrameScope(`${scope.job}:${scope.project}`);
        setFrameReady(false);
        setError(
          reason instanceof Error
            ? reason.message
            : "Table of Authorities could not be started.",
        );
      });
    return () => {
      live = false;
    };
  }, [
    clearWatchdog,
    enabled,
    frameScope,
    pingFrame,
    scope.job,
    scope.project,
    startWatchdog,
  ]);

  const scopeSignature = `${scope.job}:${scope.project}`;
  const frameCurrent =
    frameReady && frameScope === scopeSignature;
  const visibleError =
    frameScope === scopeSignature ? error : null;

  return (
    <>
      <Suspense fallback={null}>
        <ScopeReader active={active} onChange={onScopeChange} />
      </Suspense>
      <AuthoritiesShell
        active={active}
        busy={active && !frameCurrent && !visibleError}
      >
        {url && (
          <iframe
            ref={frameRef}
            src={url}
            title="Table of Authorities"
            aria-hidden={!active || !frameCurrent}
            tabIndex={active && frameCurrent ? 0 : -1}
            onLoad={pingFrame}
            className={`absolute inset-0 h-full w-full border-0 bg-[#f3f4f6] ${
              frameCurrent ? "" : "invisible"
            }`}
          />
        )}
        {!frameCurrent && !visibleError ? (
          <div
            data-testid="authorities-neutral-cover"
            className="absolute inset-0 bg-[#f3f4f6]"
          />
        ) : !frameCurrent && visibleError ? (
          <div className="absolute inset-0 flex items-center justify-center bg-white p-8">
            <div className="max-w-lg text-center">
              <h2 className="font-serif text-2xl text-gray-900">
                Authorities unavailable
              </h2>
              <p className="mt-3 text-sm leading-6 text-gray-600">
                {visibleError}
              </p>
              <button
                type="button"
                className="mt-5 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white"
                onClick={() => window.location.reload()}
              >
                Try again
              </button>
            </div>
          </div>
        ) : null}
      </AuthoritiesShell>
    </>
  );
}
