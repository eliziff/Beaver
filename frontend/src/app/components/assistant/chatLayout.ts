/** The assistant reading-column measure, in one place.
 *
 * The transcript, the composer, and the new-chat view must all lay out at the
 * same width; when this was copy-pasted, a change to one silently left the
 * others stale and the views drifted apart. Change the measure here only. */
export const CHAT_COLUMN_CLASS = "w-full max-w-[min(48rem,calc(100%_-_4rem))]";
