import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { ActionMenu } from "../ui/action-menu";
import { buttonClassName } from "../ui/button";
import { errorMessage } from "@/app/lib/utils";

export function ResearchViews({ workspace, table, chat }: {
  workspace?: () => void | Promise<void>;
  table?: () => void | Promise<void>;
  chat?: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <span className="relative inline-flex shrink-0">
    <ActionMenu label="Open as" triggerClassName={buttonClassName({ variant: "outline", size: "compact" })}
      items={([["Workspace", workspace], ["Table", table], ["Chat", chat]] as const)
        .flatMap(([label, open]) => open ? [{ label, disabled: busy, onSelect: () => {
          setBusy(true); setError(""); void Promise.resolve().then(open).catch((reason) =>
            setError(errorMessage(reason, `Could not open ${label.toLowerCase()}`))).finally(() => setBusy(false));
        } }] : [])}>
      {busy ? "Opening…" : "Open as"}<ChevronDown aria-hidden className="size-3.5" />
    </ActionMenu>
    {error && <span role="alert" className="absolute end-0 top-full z-50 mt-1 w-64 rounded border border-red-200 bg-white p-2 text-sm text-red-700">{error}</span>}
  </span>;
}
