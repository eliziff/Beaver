"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { launchTableOfAuthorities } from "@/app/lib/beaverApi";
import { PageHeader } from "@/app/components/shared/PageHeader";

const BOOT_TIMEOUT_MS = 15_000;

interface TableOfAuthoritiesHostProps {
  active: boolean;
  enabled: boolean;
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
        active ? "visible" : "invisible pointer-events-none"
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

export function TableOfAuthoritiesFallback({ active }: { active: boolean }) {
  return (
    <AuthoritiesShell active={active} busy={active}>
      <div
        data-testid="authorities-neutral-cover"
        className="absolute inset-0 bg-[#f3f4f6]"
      />
    </AuthoritiesShell>
  );
}

export function TableOfAuthoritiesHost({
  active,
  enabled,
}: TableOfAuthoritiesHostProps) {
  const searchParams = useSearchParams();
  const requestedJob =
    active && /^[0-9a-f]{32}$/.test(searchParams.get("job") || "")
      ? searchParams.get("job")!
      : "";
  const requestedProject =
    active &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      searchParams.get("project") || "",
    )
      ? searchParams.get("project")!
      : "";
  const [url, setUrl] = useState<string | null>(null);
  const [frameReady, setFrameReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const sessionRef = useRef("");
  const urlRef = useRef("");
  const scopeRef = useRef("");
  const expectedOriginRef = useRef("");
  const attemptRef = useRef("");
  const watchdogRef = useRef<number | null>(null);
  const serviceRef = useRef<Promise<string> | null>(null);

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
        setError("Table of Authorities took too long to start.");
      }, BOOT_TIMEOUT_MS);
    },
    [clearWatchdog],
  );

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
        setError(
          typeof data.message === "string"
            ? data.message
            : "Table of Authorities could not be started.",
        );
      }
    };
    window.addEventListener("message", onReady);
    return () => window.removeEventListener("message", onReady);
  }, [clearWatchdog]);

  useEffect(
    () => () => {
      clearWatchdog();
    },
    [clearWatchdog],
  );

  useEffect(() => {
    if (!enabled || (!active && urlRef.current)) return;
    let live = true;
    if (!sessionRef.current) {
      const key = "mike-table-of-authorities-session";
      try {
        const stored = window.sessionStorage.getItem(key);
        sessionRef.current =
          stored && /^[0-9a-f]{32}$/.test(stored)
            ? stored
            : crypto.randomUUID().replaceAll("-", "");
        window.sessionStorage.setItem(key, sessionRef.current);
      } catch {
        sessionRef.current = crypto.randomUUID().replaceAll("-", "");
      }
    }
    if (!serviceRef.current) {
      startWatchdog("");
      serviceRef.current = launchTableOfAuthorities().then(
        (result) => result.url,
      );
    }
    serviceRef.current
      .then((service) => {
        if (!live) return;
        const scope = [requestedJob, requestedProject];
        const signature = scope.join(":");
        if (urlRef.current && scopeRef.current === signature) return;
        const serviceUrl = new URL(service);
        const attempt = crypto.randomUUID();
        serviceUrl.searchParams.set("mode", "mike");
        serviceUrl.searchParams.set("session", sessionRef.current);
        serviceUrl.searchParams.set("attempt", attempt);
        if (scope[0]) serviceUrl.searchParams.set("job", scope[0]);
        if (scope[1]) serviceUrl.searchParams.set("project", scope[1]);
        scopeRef.current = signature;
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
    active,
    clearWatchdog,
    enabled,
    requestedJob,
    requestedProject,
    startWatchdog,
  ]);

  return (
    <AuthoritiesShell
      active={active}
      busy={active && !frameReady && !error}
    >
      {url && (
        <iframe
          ref={frameRef}
          src={url}
          title="Table of Authorities"
          aria-hidden={!active || !frameReady}
          tabIndex={active && frameReady ? 0 : -1}
          className="absolute inset-0 h-full w-full border-0 bg-[#f3f4f6]"
        />
      )}
      {!frameReady &&
        (error ? (
          <div className="absolute inset-0 flex items-center justify-center bg-white p-8">
            <div className="max-w-lg text-center">
              <h2 className="font-serif text-2xl text-gray-900">
                Authorities unavailable
              </h2>
              <p className="mt-3 text-sm leading-6 text-gray-600">{error}</p>
              <button
                type="button"
                className="mt-5 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white"
                onClick={() => window.location.reload()}
              >
                Try again
              </button>
            </div>
          </div>
        ) : (
          <div
            data-testid="authorities-neutral-cover"
            className="absolute inset-0 bg-[#f3f4f6]"
          />
        ))}
    </AuthoritiesShell>
  );
}
