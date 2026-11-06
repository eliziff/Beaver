// Auto-fetch from folder, for Authorities and Authorities-lite alike: the watch on the folder Chrome saves into. It is
// off, asking (Chrome must be asked about a folder kept from an earlier visit, on the next click), or watching, and
// `scan` is called every two seconds, once at the start and whenever `look` is, one at a time, unless `held` says the
// page is busy.

/** @typedef {{ name: string, queryPermission?(options: { mode: "read" }): Promise<PermissionState>,
 *    requestPermission?(options: { mode: "read" }): Promise<PermissionState> }} FolderHandle */
/** @template {FolderHandle} [Handle=FolderHandle]
 *  @typedef {{ kind: "off" } | { kind: "asking", handle: Handle, open: boolean } | { kind: "watching", handle: Handle }} FolderWatchState */
/** @template {FolderHandle} Handle
 *  @param {{ held: () => boolean, scan: (handle: Handle, first: boolean) => Promise<void>,
 *    changed: (state: FolderWatchState<Handle>) => void, failed: (error: any) => void }} options */
export function folderWatch({ held, scan, changed, failed }) {
  let state = { kind: "off" }, timer, scanning = false;
  const become = (next) => { clearInterval(timer); state = next; changed(state); };
  async function look(first = false) {
    if (state.kind !== "watching" || scanning || held()) return;
    const { handle } = state;
    scanning = true;
    try {
      // Chrome's access can end with the visit; the folder is then asked for again on the next click.
      const permission = await handle.queryPermission?.({ mode: "read" });
      if (permission && permission !== "granted") become({ kind: "asking", handle, open: false });
      else await scan(handle, first);
    } catch (error) { become({ kind: "off" }); failed(error); }
    finally { scanning = false; }
  }
  function watch(handle, first = false) {
    become({ kind: "watching", handle });
    timer = setInterval(look, 2000);
    return look(first);
  }
  return {
    watch, look,
    /** A folder kept from an earlier visit: watched again, or asked for on the next click. */
    async restore(handle) {
      const granted = await handle.queryPermission?.({ mode: "read" }) === "granted";
      if (state.kind === "off") await (granted ? watch(handle) : become({ kind: "asking", handle, open: false }));
    },
    /** Asks Chrome again for the folder it is asking about; true if the folder is now watched. */
    async allow(first) {
      if (state.kind !== "asking") return false;
      const { handle } = state, granted = await handle.requestPermission?.({ mode: "read" }).catch(() => "denied") === "granted";
      if (granted) void watch(handle, first); else become({ kind: "asking", handle, open: false });
      return granted;
    },
    /** Whether the page's dialog about the folder shows. */
    showAsking(open) { if (state.kind === "asking") become({ ...state, open }); },
    stop() { become({ kind: "off" }); },
  };
}
