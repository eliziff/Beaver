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

export type Check = (value: unknown) => boolean;
type OptionalCheck = Check & { optional: true };
type Field<T, K extends keyof T> = {} extends Pick<T, K> ? OptionalCheck : Check;
/** One checker per contract field; a field the type makes optional needs `maybe`. */
export type FieldTable<T> = { [K in keyof T]-?: Field<T, K> };

export const maybe = (check: Check): OptionalCheck =>
  Object.assign((value: unknown) => value === undefined || check(value),
    { optional: true as const });

/** Derives a decoder from the contract type: every key is declared, nothing else is kept. */
export function closed<T>(table: FieldTable<T>) {
  const fields = Object.entries(table) as Array<[string, Check & { optional?: true }]>;
  return (value: unknown): value is T => {
    const item = jsonRecord(value);
    return !!item && Object.keys(item).every((key) => Object.hasOwn(table, key)) &&
      fields.every(([key, check]) =>
        check.optional && !Object.hasOwn(item, key) || check(item[key]));
  };
}
