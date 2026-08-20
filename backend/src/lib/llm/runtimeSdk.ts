export async function runtimeConstructor<T>(specifier: string, name = "default"): Promise<T> {
  const loaded: unknown = await import(specifier);
  const exports = loaded as Record<string, unknown>;
  const value = name === "default" ? exports.default ?? loaded : exports[name];
  if (typeof value !== "function") {
    throw new Error(`${specifier} is missing its ${name} constructor`);
  }
  return value as T;
}
