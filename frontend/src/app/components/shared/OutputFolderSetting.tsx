import { useEffect, useState } from "react";
import { FolderSearch } from "lucide-react";
import { Button } from "@/app/components/ui/button";

export type OutputFolderPort = {
  get(): Promise<string | null>;
  choose(): Promise<string | null>;
  clear(): Promise<void>;
};

export function OutputFolderSetting({ port, busy = false }: {
  port: OutputFolderPort; busy?: boolean;
}) {
  const [folder, setFolder] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void port.get().then((value) => active && setFolder(value))
      .catch(() => active && setError("The output folder could not be opened."));
    return () => { active = false; };
  }, [port]);
  async function choose() {
    setError("");
    try { setFolder(await port.choose()); }
    catch { setError("The output folder could not be changed."); }
  }
  async function clear() {
    setError("");
    try { await port.clear(); setFolder(null); }
    catch { setError("The output folder could not be cleared."); }
  }
  return <div className="flex flex-wrap items-center justify-between gap-3">
    <div className="min-w-0"><h3 className="text-sm font-semibold text-gray-950">Output folder</h3>
      <p className="truncate text-sm text-gray-600">{folder || "Not set"}</p>
      <p className="min-h-5 text-sm text-red-700" role={error ? "alert" : undefined}>{error}</p></div>
    <div className="ms-auto flex items-center gap-2">
      {folder && <Button type="button" variant="ghost" className="h-9"
        disabled={busy} onClick={() => void clear()}>Clear</Button>}
      <Button type="button" variant="outline" className="h-9 border-gray-400"
        disabled={busy} onClick={() => void choose()}><FolderSearch /> Choose folder</Button>
    </div>
  </div>;
}
