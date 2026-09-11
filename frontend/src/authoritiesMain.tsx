import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "@/app/authorities.css";
import { AuthoritiesWorkspace } from "@/app/authorities/AuthoritiesWorkspace";
import { standaloneAuthoritiesHost } from "@/app/authorities/standaloneHost";

const container = document.getElementById("root");
if (!container) throw new Error("Missing Authorities root");

function StandaloneAuthorities() {
  const [search, setSearch] = useState(location.search);
  useEffect(() => {
    const sync = () => setSearch(location.search);
    addEventListener("popstate", sync); return () => removeEventListener("popstate", sync);
  }, []);
  const draftId = new URLSearchParams(search).get("draft") ?? "";
  return <AuthoritiesWorkspace host={standaloneAuthoritiesHost} initialDraftId={draftId}
    onDraftChange={(draft) => {
      if (draftId === (draft?.id ?? "")) return;
      const next = new URL(location.href);
      if (draft) next.searchParams.set("draft", draft.id); else next.searchParams.delete("draft");
      history.replaceState(history.state, "", next); setSearch(next.search);
    }} />;
}

createRoot(container).render(<StandaloneAuthorities />);
