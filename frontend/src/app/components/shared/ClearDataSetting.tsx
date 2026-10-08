import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/app/components/ui/button";

/** Deletes all the page keeps in this browser, after a second click, then starts the page afresh. `contents` says
 *  what that is, in the page's own words. */
export function ClearDataSetting({ clear, busy = false,
  contents = "Drafts, the files and folders they use, the outputs made from them, saved source lookups and settings." }: {
  clear: () => Promise<void>; busy?: boolean; contents?: string }) {
  const [confirming, setConfirming] = useState(false), [clearing, setClearing] = useState(false);
  const [error, setError] = useState("");
  async function clearAll() {
    setError(""); setClearing(true);
    try { await clear(); location.reload(); }
    catch { setError("The data could not be cleared."); setClearing(false); }
  }
  return <div className="flex flex-wrap items-center justify-between gap-3">
    <div className="min-w-0 flex-1 basis-72"><h3 className="text-sm font-semibold text-gray-950">Data in this browser</h3>
      <p className="text-sm text-gray-600">{confirming
        ? "Deletes all of it from this browser and reloads the page. Files and folders on this computer are not changed."
        : contents}</p>
      <p className="min-h-5 text-sm text-red-700" role={error ? "alert" : undefined}>{error}</p></div>
    <div className="ms-auto flex items-center gap-2">
      {confirming && <Button type="button" variant="ghost" className="h-9" disabled={clearing}
        onClick={() => setConfirming(false)}>Cancel</Button>}
      {confirming
        ? <Button type="button" variant="danger" className="h-9" disabled={busy || clearing}
          onClick={() => void clearAll()}><Trash2 /> Delete all data</Button>
        : <Button type="button" variant="outline" className="h-9 border-gray-400" disabled={busy}
          onClick={() => setConfirming(true)}><Trash2 /> Clear all data</Button>}
    </div>
  </div>;
}
