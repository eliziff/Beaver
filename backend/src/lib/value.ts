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
/** Contract fields only: an index signature names no field, so it declares none. */
type Named<T> = { [K in keyof T as string extends K ? never
  : number extends K ? never : K]: T[K] };
type Field<T, K extends keyof T> = {} extends Pick<T, K> ? OptionalCheck : Check;
/** One checker per contract field; a field the type makes optional needs `maybe`. */
export type FieldTable<T> = { [K in keyof Named<T>]-?: Field<Named<T>, K> };

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

/** The same, for a union discriminated by `kind`: one closed table per branch. */
export function tagged<T extends { kind: string }>(
  branches: { [K in T["kind"]]: FieldTable<Omit<Extract<T, { kind: K }>, "kind">> },
) {
  const byKind = new Map(Object.entries(branches).map(([kind, table]) => [kind,
    closed({ ...table as object, kind: literal(kind) } as FieldTable<Record<string, unknown>>)]));
  return (value: unknown): value is T => {
    const item = jsonRecord(value);
    return !!item && Boolean(byKind.get(String(item.kind))?.(item));
  };
}

export const literal = (expected: unknown): Check => (value) => value === expected;
export const flag: Check = (value) => typeof value === "boolean";
export const integer: Check = (value) => Number.isSafeInteger(value);
export const natural: Check = (value) => integer(value) && Number(value) >= 0;
export const hash: Check = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
export const text: Check = (value) => typeof value === "string";
export const string = (max = 5_000): Check => (value) =>
  typeof value === "string" && value.length <= max;
export const nonempty = (max: number): Check => (value) =>
  typeof value === "string" && value.length > 0 && value.length <= max;
/** One line of user text: already trimmed, and free of control characters. */
export const plain = (max: number, min = 0): Check => (value) =>
  typeof value === "string" && value.length >= min && value.length <= max &&
  value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
export const trimmed = (max: number): Check => plain(max, 1);
export const oneOf = (choices: readonly string[]): Check => (value) =>
  typeof value === "string" && choices.includes(value);
export const nullable = (check: Check): Check => (value) => value === null || check(value);
export const list = (max: number, item: Check): Check => (value) =>
  Array.isArray(value) && value.length <= max && value.every(item);
export const dictionary = <T>(item: Check, key: Check = text, max = 50_000) =>
  (value: unknown): value is Record<string, T> => {
    const entries = jsonRecord(value);
    return !!entries && Object.keys(entries).length <= max &&
      Object.entries(entries).every(([name, field]) => key(name) && item(field));
  };
