"use client";

import { useEffect, useRef, useState } from "react";
import { launchTableOfAuthorities } from "@/app/lib/beaverApi";

export default function TableOfAuthoritiesPage() {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef("");

  useEffect(() => {
    let active = true;
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
    launchTableOfAuthorities()
      .then((result) => {
        if (!active) return;
        const job = new URLSearchParams(window.location.search).get("job");
        const serviceUrl = new URL(result.url);
        serviceUrl.searchParams.set("mode", "mike");
        serviceUrl.searchParams.set("session", sessionRef.current);
        if (job && /^[0-9a-f]{32}$/.test(job)) {
          serviceUrl.searchParams.set("job", job);
        }
        setUrl(serviceUrl.toString());
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(
          reason instanceof Error
            ? reason.message
            : "Table of Authorities could not be started.",
        );
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div
      className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-white"
      aria-busy={!url && !error}
    >
      <iframe
        src={url ?? "about:blank"}
        title="Table of Authorities"
        aria-hidden={!url}
        tabIndex={url ? 0 : -1}
        className="absolute inset-0 h-full w-full border-0 bg-white"
      />
      {!url && (
        <div className="absolute inset-0 flex items-center justify-center bg-white p-8">
          {error ? (
            <div className="max-w-lg text-center">
              <h1 className="font-serif text-2xl text-gray-900">
                Authorities unavailable
              </h1>
              <p className="mt-3 text-sm leading-6 text-gray-600">{error}</p>
              <button
                type="button"
                className="mt-5 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white"
                onClick={() => window.location.reload()}
              >
                Try again
              </button>
            </div>
          ) : (
            <div className="text-sm text-gray-500">Starting Authorities…</div>
          )}
        </div>
      )}
    </div>
  );
}
