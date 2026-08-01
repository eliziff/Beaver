/**
 * Tool surfaces are CONFIGURATION, not code.
 *
 * A surface is a named set of environment variables plus an optional filter
 * over the tool schemas the model is shown. The benchmark knows nothing about
 * what any particular variable means; it sets them and records them. That is
 * what makes the next surface measurable without editing the benchmark.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { OpenAIToolSchema } from "../../../backend/scripts/docx-edit-bench-bridge";

export type Surface = {
  schema: "mike.docx-edit.surface.v1";
  id: string;
  description: string;
  env: Record<string, string>;
  tools?: {
    /** Remove these tool names entirely. */
    drop_tools?: string[];
    /** Remove these top-level parameters, keyed by tool name. */
    drop_params?: Record<string, string[]>;
    /** Remove these values from any `scope.kind` enum in a tool's schema. */
    drop_scope_kinds?: string[];
    /** Remove these properties from any `scope` object in a tool's schema. */
    drop_scope_params?: string[];
    note?: string;
  };
};

const SURFACES_PATH = path.join(__dirname, "..", "surfaces.jsonl");

export function loadSurfaces(): Surface[] {
  return readFileSync(SURFACES_PATH, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Surface);
}

export function surfaceById(id: string): Surface {
  const found = loadSurfaces().find((surface) => surface.id === id);
  if (!found) {
    throw new Error(
      `unknown surface '${id}'; known: ${loadSurfaces().map((s) => s.id).join(", ")}`,
    );
  }
  return found;
}

/** Deep clone that drops the configured scope kinds and scope properties. */
function pruneScopes(
  value: unknown,
  dropKinds: string[],
  dropParams: string[],
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => pruneScopes(entry, dropKinds, dropParams));
  }
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (key === "scope" && entry && typeof entry === "object") {
      const scope = { ...(entry as Record<string, unknown>) };
      const properties = { ...((scope.properties ?? {}) as Record<string, unknown>) };
      for (const name of dropParams) delete properties[name];
      const kind = properties.kind as { enum?: string[] } | undefined;
      if (kind?.enum) {
        properties.kind = {
          ...kind,
          enum: kind.enum.filter((entry) => !dropKinds.includes(entry)),
        };
      }
      scope.properties = properties;
      out[key] = scope;
      continue;
    }
    out[key] = pruneScopes(entry, dropKinds, dropParams);
  }
  return out;
}

/** The exact schema list the model is shown under this surface. */
export function applySurface(
  tools: OpenAIToolSchema[],
  surface: Surface,
): OpenAIToolSchema[] {
  const config = surface.tools ?? {};
  const dropTools = new Set(config.drop_tools ?? []);
  let out = tools.filter((entry) => !dropTools.has(entry.function.name));
  const dropParams = config.drop_params ?? {};
  out = out.map((entry) => {
    const remove = dropParams[entry.function.name];
    if (!remove?.length) return entry;
    const properties = { ...(entry.function.parameters?.properties ?? {}) } as Record<
      string,
      unknown
    >;
    for (const name of remove) delete properties[name];
    return {
      ...entry,
      function: {
        ...entry.function,
        parameters: { ...entry.function.parameters, properties },
      },
    };
  });
  if (config.drop_scope_kinds?.length || config.drop_scope_params?.length) {
    out = out.map(
      (entry) =>
        pruneScopes(
          entry,
          config.drop_scope_kinds ?? [],
          config.drop_scope_params ?? [],
        ) as OpenAIToolSchema,
    );
  }
  return out;
}
