/** The name a page keeps what it saves in this browser under: its drafts' database and its settings' keys. Pages opened
 *  from files on a computer share one origin, as a site's pages do, so an app built from the Authorities page with a
 *  `store` of its own (ALR) never lists, changes or clears what Authorities keeps. */
export const PAGE_STORE: string = import.meta.env.VITE_PAGE_STORE || "beaver";
