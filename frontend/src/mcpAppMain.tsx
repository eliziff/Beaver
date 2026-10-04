import { useEffect, useState, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import "@/app/globals.css";
import { app } from "@/mcpApp/host";
import { initializeRuntimeConfig } from "@/app/lib/runtimeConfig";
import type { View } from "@/mcpApp/views";

// The views read Beaver's configuration as they load, so they load after it.
type Shown = { view: View; BeaverView: ComponentType<{ view: View }> };

/** Beaver's own light or dark appearance, as the host shows its conversation. */
function followTheme(theme: string | undefined) {
  if (theme !== "light" && theme !== "dark") return;
  document.documentElement.dataset.appearance = theme;
  document.documentElement.style.colorScheme = theme;
}

function Beaver() {
  const [shown, setShown] = useState<Shown | null>(null);
  useEffect(() => {
    let loaded: Promise<typeof import("@/mcpApp/views")> | undefined;
    app.ontoolresult = async (result) => {
      if (!result.structuredContent) return;
      const { BeaverView } = await (loaded ??= initializeRuntimeConfig().then(() => import("@/mcpApp/views")));
      setShown({ view: result.structuredContent as View, BeaverView });
    };
    app.addEventListener("hostcontextchanged", (context) => followTheme(context.theme));
    void app.connect().then(() => followTheme(app.getHostContext()?.theme));
  }, []);
  if (!shown) return <p className="p-4 text-sm text-gray-500">Opening Beaver…</p>;
  return <shown.BeaverView view={shown.view} />;
}

createRoot(document.getElementById("root")!).render(<Beaver />);
