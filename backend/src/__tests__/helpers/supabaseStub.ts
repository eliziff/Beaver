import { vi } from "vitest";

export type SupabaseResult = { data: unknown; error: unknown };

type ResultSource = SupabaseResult | ((table: string) => SupabaseResult);

type StubOptions = {
    result?: ResultSource;
    rpc?: ResultSource;
    onInsert?: (table: string, payload: unknown) => void;
    adminGetUserById?: () => SupabaseResult;
    adminDeleteUser?: () => { error: unknown };
};

export type MutableSupabaseState = {
    rpc: SupabaseResult;
    tables: Record<string, SupabaseResult>;
    inserts: { table: string; payload: unknown }[];
};

export function createMutableSupabaseState(): MutableSupabaseState {
    return { rpc: { data: [], error: null }, tables: {}, inserts: [] };
}

export function createMutableSupabaseStub(state: MutableSupabaseState) {
    return createSupabaseStub({
        result: (table) => state.tables[table] ?? { data: null, error: null },
        rpc: () => state.rpc,
        onInsert: (table, payload) => state.inserts.push({ table, payload }),
    });
}

const chainMethods = [
    "select", "insert", "update", "delete", "upsert",
    "eq", "neq", "in", "is", "or", "not", "lt", "gt", "gte", "lte",
    "filter", "order", "limit", "range", "contains",
];

function resolve(source: ResultSource | undefined, table: string): SupabaseResult {
    return typeof source === "function"
        ? source(table)
        : source ?? { data: null, error: null };
}

export function createSupabaseStub(options: StubOptions = {}) {
    const from = vi.fn((table: string) => {
        const query: Record<string, any> = {};
        for (const method of chainMethods) {
            query[method] = vi.fn((payload?: unknown) => {
                if (method === "insert") options.onInsert?.(table, payload);
                return query;
            });
        }
        query.single = vi.fn(() => Promise.resolve(resolve(options.result, table)));
        query.maybeSingle = vi.fn(() => Promise.resolve(resolve(options.result, table)));
        query.then = (
            onFulfilled: (value: SupabaseResult) => unknown,
            onRejected?: (reason: unknown) => unknown,
        ) => Promise.resolve(resolve(options.result, table)).then(onFulfilled, onRejected);
        return query;
    });

    const auth: Record<string, unknown> = {
        getUser: vi.fn(async () => ({
            data: { user: { id: "u1" } },
            error: null,
        })),
    };
    if (options.adminGetUserById || options.adminDeleteUser) {
        auth.admin = {
            getUserById: vi.fn(async () =>
                options.adminGetUserById?.() ?? { data: null, error: null }),
            deleteUser: vi.fn(async () =>
                options.adminDeleteUser?.() ?? { error: null }),
        };
    }

    return {
        from,
        rpc: vi.fn((name: string, args?: unknown) => {
            void name;
            void args;
            return Promise.resolve(resolve(options.rpc, "rpc"));
        }),
        auth,
    };
}
