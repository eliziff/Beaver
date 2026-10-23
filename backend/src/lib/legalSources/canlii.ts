// CanLII is linked, never read: a decision's page opens in the reader's browser and its PDF is attached.
type IndexedUrl = (text: string, firstPinpoint?: string | null) => string | null;
/** A decision a CanLII number names: its title, its year and the courts its CanLII database holds. */
export type NumberedCase = { name: string; year: string; courts: string[] };
/** A host's index of CanLII's decisions, for what the engine cannot build or find from a citation alone. */
export type CanliiIndex = { caseUrl: IndexedUrl; numberedCase: (text: string) => NumberedCase | null };
let index: CanliiIndex | null = null;
export const useCanliiIndex = (host: CanliiIndex | null) => { index = host; };
/** The CanLII page of the decision `text` cites, from the host's index; null without one, or where it finds none.
 *  At its first paragraph pinpoint (`firstPinpoint`, "par12"). */
export const indexedCaseUrl: IndexedUrl = (text, firstPinpoint) => index?.caseUrl(text, firstPinpoint) ?? null;
/** The decision `text` cites by its CanLII number, from the host's index; null without one, or where it names none. */
export const indexedNumberedCase = (text: string) => index?.numberedCase(text) ?? null;
