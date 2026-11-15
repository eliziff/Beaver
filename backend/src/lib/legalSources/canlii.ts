// CanLII is linked, never read: a decision's page opens in the reader's browser and its PDF is attached.
import type { AlrIndexedCase } from "mike/shared/engine-types/AlrIndexedCase";
/** A decision a CanLII number names: its title, its year and the courts its CanLII database holds. */
export type NumberedCase = { name: string; year: string; courts: string[] };
/** A host's index of CanLII's decisions, for what the engine cannot build or find from a citation alone: a decision's
 *  page, found by what the engine read off its citation; and the decision a CanLII number names. */
export type CanliiIndex = { caseUrl: (indexed: AlrIndexedCase) => string | null; numberedCase: (text: string) => NumberedCase | null };
let index: CanliiIndex | null = null;
export const useCanliiIndex = (host: CanliiIndex | null) => { index = host; };
/** Whether the host supplied an index. */
export const hasCanliiIndex = () => !!index;
/** The CanLII page of a decision, from the host's index; null without one, or where it finds none. */
export const indexedCaseUrl = (indexed: AlrIndexedCase) => index?.caseUrl(indexed) ?? null;
/** The decision `text` cites by its CanLII number, from the host's index; null without one, or where it names none. */
export const indexedNumberedCase = (text: string) => index?.numberedCase(text) ?? null;
