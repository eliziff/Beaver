export type SqlValue = string | number | Uint8Array | null;
export type SqlStatement = { text: string; params: SqlValue[] };
export type QueryResult<T> = { rows: T[]; changes: number };
export type RelationalDatabase = {
  readonly engine: "sqlite" | "postgres";
  query<T extends Record<string, unknown>>(statement: SqlStatement): Promise<QueryResult<T>>;
  transaction<T>(run: (database: RelationalDatabase) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

const fragment = Symbol("sql-fragment");
type Fragment = SqlStatement & { [fragment]: true };
const isFragment = (value: unknown): value is Fragment =>
  !!value && typeof value === "object" && fragment in value;

export function sql(
  strings: TemplateStringsArray,
  ...values: Array<SqlValue | Fragment>
): Fragment {
  const params: SqlValue[] = [];
  let text = strings[0];
  values.forEach((value, index) => {
    if (isFragment(value)) {
      text += value.text.replace(/\$(\d+)/gu, (_match, raw: string) =>
        `$${params.length + Number(raw)}`);
      params.push(...value.params);
    } else {
      params.push(value);
      text += `$${params.length}`;
    }
    text += strings[index + 1];
  });
  return { text, params, [fragment]: true };
}

sql.raw = (text: string): Fragment => ({ text, params: [], [fragment]: true });
sql.join = (values: Array<SqlValue | Fragment>): Fragment => values.length
  ? values.map((value) => isFragment(value) ? value : sql`${value}`).reduce((left, right) =>
    sql`${left},${right}`)
  : sql.raw("NULL");
