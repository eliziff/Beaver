// CanLII is linked, never read: a decision's page opens in the reader's browser and its PDF is attached.
type IndexedUrl = (text: string, firstPinpoint?: string | null) => string | null;
let indexedUrl: IndexedUrl | null = null;
/** A host's own lookup of a decision's CanLII page, for a citation the engine builds no page for. */
export const useCanliiIndex = (resolve: IndexedUrl | null) => { indexedUrl = resolve; };
/** The CanLII page of the decision `text` cites, from the host's lookup; null without one, or where it finds none.
 *  At its first paragraph pinpoint (`firstPinpoint`, "par12"). */
export const indexedCaseUrl: IndexedUrl = (text, firstPinpoint) => indexedUrl?.(text, firstPinpoint) ?? null;
