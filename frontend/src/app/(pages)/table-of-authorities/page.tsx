"use client";

import { useEffect, useRef, useState } from "react";
import { launchTableOfAuthorities } from "@/app/lib/mikeApi";

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

  if (error) {
    return (
      <div className="m-3 flex min-h-0 flex-1 items-center justify-center rounded-2xl border border-red-200 bg-white p-8">
        <div className="max-w-lg text-center">
          <h1 className="font-serif text-2xl text-gray-900">
            Table of Authorities is unavailable
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
      </div>
    );
  }

  if (!url) {
    return (
      <div className="m-3 flex min-h-0 flex-1 items-center justify-center rounded-2xl border border-white/70 bg-app-surface">
        <div className="text-sm text-gray-500">
          Starting Table of Authorities…
        </div>
      </div>
    );
  }

  return (
    <iframe
      src={url}
      title="Table of Authorities"
      className="h-full min-h-0 min-w-0 max-w-full flex-1 border-0 bg-white"
    />
  );
}
