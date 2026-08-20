export const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const jsonRecord = (value: unknown): Record<string, unknown> | null =>
  isJsonRecord(value) ? value : null;

export const trimmedText = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

export const nonemptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

export const positiveInteger = (value: unknown) => {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};
