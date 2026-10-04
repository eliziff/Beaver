// The folder a reader's browser saves downloads into, watched while the page is open: each PDF saved
// there is offered to the page, which attaches it to the source still waiting for it (Authorities'
// Auto-fetch from folder, the ALR Quote Verifier's CanLII step). The folder is looked at every two
// seconds and whenever the tab is come back to; a file the page has tried is not offered again.

const MAX_PDF_BYTES = 100 * 1024 * 1024;

/** A file's identity across looks: the same name saved again with other contents is offered again. */
export const folderFileId = (file) => `${file.name}\0${file.size}\0${file.lastModified}`;

/** The folder the reader picks, starting in Downloads, as `{ handle }`; null when they cancel.
 *  Without folder access (Firefox, Safari) the folder is read once: `{ files }`, its top-level PDFs. */
export async function chooseWatchedFolder(id) {
  const picker = globalThis.showDirectoryPicker;
  if (!picker) return readFolderOnce();
  try { return { handle: await picker({ id, mode: "read", startIn: "downloads" }) }; }
  catch (error) { if (error?.name === "AbortError") return null; throw error; }
}

function readFolderOnce() {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement("input"), { type: "file", multiple: true, webkitdirectory: true });
    input.onchange = () => resolve({ files: pdfsFirst(Array.from(input.files ?? [])
      .filter((file) => file.webkitRelativePath.split("/").length <= 2)) });
    input.oncancel = () => resolve(null);
    input.click();
  });
}

const pdfsFirst = (files) => files.filter((file) => /\.pdf$/iu.test(file.name) && file.size <= MAX_PDF_BYTES)
  .sort((left, right) => right.lastModified - left.lastModified);

/** Whether a kept folder may still be read without asking ("granted"), or must be asked for on a click. */
export async function folderPermission(handle) {
  return (await handle.queryPermission?.({ mode: "read" })) ?? "granted";
}
/** Asks again for a kept folder; call from a click. */
export async function requestFolderAccess(handle) {
  return (await handle.requestPermission?.({ mode: "read" }).catch(() => "denied")) ?? "granted";
}

/** Watches `handle`. `offer(files, tried)` gets the PDFs not tried before, newest first, and calls
 *  `tried(file)` for each it looked at; one it leaves untried is offered again on the next look.
 *  `lost(error)` is called once if the folder can no longer be read (null: its access ended). */
export function watchFolder(handle, { offer, lost, interval = 2_000 }) {
  const tried = new Set();
  let scanning = false, stopped = false;
  async function look() {
    if (scanning || stopped) return;
    scanning = true;
    try {
      // Chrome's access can end with the visit; the folder is then asked for on the next click.
      if (await folderPermission(handle) !== "granted") { stop(); lost(null); return; }
      const files = [];
      for await (const entry of handle.values())
        if (entry.kind === "file" && /\.pdf$/iu.test(entry.name)) files.push(await entry.getFile());
      const fresh = pdfsFirst(files).filter((file) => !tried.has(folderFileId(file)));
      if (fresh.length) await offer(fresh, (file) => tried.add(folderFileId(file)));
    } catch (error) { if (!stopped) { stop(); lost(error); } }
    finally { scanning = false; }
  }
  const timer = setInterval(look, interval);
  globalThis.addEventListener?.("focus", look);
  function stop() {
    stopped = true;
    clearInterval(timer);
    globalThis.removeEventListener?.("focus", look);
  }
  void look();
  return { look, stop, name: handle.name, forget: () => tried.clear() };
}
