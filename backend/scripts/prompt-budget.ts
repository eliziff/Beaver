/**
 * What a turn pays before the model reads one word of the matter, and how
 * much of that is representation rather than information.
 *
 * The tool array is the dominant cost, and on the routes we actually
 * benchmark (claude -p, codex) we serialize it into a text envelope we write
 * ourselves — so JSON Schema is a choice there, not a requirement. This
 * prices the alternatives deterministically. It does NOT claim they are
 * equally good: a leaner encoding has to be A/B'd for tool-call accuracy
 * before it ships. This answers "how much headroom is there", so that
 * question is worth asking.
 *
 *   npx tsx scripts/prompt-budget.ts
 */
const tok = (s: string) => Math.ceil(Buffer.byteLength(s, "utf8") / 4);
const firstSentence = (s: string) => {
  const cut = s.search(/\.\s/u);
  return cut < 0 ? s : s.slice(0, cut + 1);
};

type Schema = {
  type?: string;
  description?: string;
  enum?: unknown[];
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  minimum?: number;
  maximum?: number;
};

/** "name: type" with enums inlined and optionality marked. */
function signature(name: string, schema: Schema, required: Set<string>): string {
  const optional = required.has(name) ? "" : "?";
  if (Array.isArray(schema.enum)) {
    return `${name}${optional}: ${schema.enum.map((v) => JSON.stringify(v)).join("|")}`;
  }
  if (schema.type === "array") {
    const inner = schema.items?.properties
      ? `{${Object.keys(schema.items.properties).join(",")}}`
      : (schema.items?.type ?? "any");
    return `${name}${optional}: ${inner}[]`;
  }
  if (schema.type === "object" && schema.properties) {
    return `${name}${optional}: {${Object.keys(schema.properties).join(",")}}`;
  }
  const short =
    schema.type === "integer" || schema.type === "number"
      ? "num"
      : schema.type === "boolean"
        ? "bool"
        : "str";
  return `${name}${optional}: ${short}`;
}

async function main() {
  const { ASSISTANT_TOOLS } = await import(
    "../src/lib/chat/assistantTools"
  );

  type Variant = { label: string; render: (s: (typeof ASSISTANT_TOOLS)[number]) => string };

  const variants: Variant[] = [
    {
      label: "V0 JSON Schema (today)",
      render: (s) => JSON.stringify(s),
    },
    {
      label: "V1 JSON, param descriptions dropped",
      render: (s) => {
        const strip = (node: Schema): Schema => {
          const { description, ...rest } = node;
          void description;
          const out: Schema = { ...rest };
          if (out.properties) {
            out.properties = Object.fromEntries(
              Object.entries(out.properties).map(([k, v]) => [k, strip(v)]),
            );
          }
          if (out.items) out.items = strip(out.items);
          return out;
        };
        return JSON.stringify({
          ...s,
          function: {
            ...s.function,
            parameters: strip(s.function.parameters as Schema),
          },
        });
      },
    },
    {
      label: "V2 signature + full descriptions",
      render: (s) => {
        const params = (s.function.parameters ?? {}) as Schema;
        const required = new Set(params.required ?? []);
        const args = Object.entries(params.properties ?? {})
          .map(([name, schema]) => signature(name, schema, required))
          .join(", ");
        const notes = Object.entries(params.properties ?? {})
          .filter(([, schema]) => schema.description)
          .map(([name, schema]) => `  ${name}: ${schema.description}`)
          .join("\n");
        return `${s.function.name}(${args})\n  ${s.function.description}\n${notes}`;
      },
    },
    {
      label: "V3 signature + tool description only",
      render: (s) => {
        const params = (s.function.parameters ?? {}) as Schema;
        const required = new Set(params.required ?? []);
        const args = Object.entries(params.properties ?? {})
          .map(([name, schema]) => signature(name, schema, required))
          .join(", ");
        return `${s.function.name}(${args})\n  ${s.function.description}`;
      },
    },
    {
      label: "V4 signature + first sentence",
      render: (s) => {
        const params = (s.function.parameters ?? {}) as Schema;
        const required = new Set(params.required ?? []);
        const args = Object.entries(params.properties ?? {})
          .map(([name, schema]) => signature(name, schema, required))
          .join(", ");
        return `${s.function.name}(${args})\n  ${firstSentence(s.function.description ?? "")}`;
      },
    },
    {
      label: "V5 index only (name + first sentence)",
      render: (s) =>
        `${s.function.name} — ${firstSentence(s.function.description ?? "")}`,
    },
  ];

  const totals = variants.map((v) => ({
    label: v.label,
    tokens: ASSISTANT_TOOLS.reduce((sum, s) => sum + tok(v.render(s)), 0),
  }));
  const base = totals[0].tokens;

  console.log(`${ASSISTANT_TOOLS.length} tools\n`);
  console.log(`${"encoding".padEnd(38)}${"tokens".padStart(8)}${"saved".padStart(8)}${"of base".padStart(9)}`);
  for (const t of totals) {
    const saved = base - t.tokens;
    console.log(
      `${t.label.padEnd(38)}${String(t.tokens).padStart(8)}${String(saved).padStart(8)}${(`${Math.round((t.tokens / base) * 100)}%`).padStart(9)}`,
    );
  }

  console.log(`\nheaviest tools under today's encoding:`);
  const rows = ASSISTANT_TOOLS.map((s) => ({
    name: s.function.name,
    v0: tok(variants[0].render(s)),
    v3: tok(variants[3].render(s)),
  }))
    .sort((a, b) => b.v0 - a.v0)
    .slice(0, 8);
  console.log(`${"tool".padEnd(32)}${"V0".padStart(7)}${"V3".padStart(7)}${"saved".padStart(8)}`);
  for (const r of rows) {
    console.log(
      `${r.name.padEnd(32)}${String(r.v0).padStart(7)}${String(r.v3).padStart(7)}${String(r.v0 - r.v3).padStart(8)}`,
    );
  }

  console.log(`\nsample of V3 for the heaviest tool:\n`);
  const heaviest = ASSISTANT_TOOLS.find(
    (s) => s.function.name === rows[0].name,
  )!;
  console.log(variants[3].render(heaviest).slice(0, 700));
}

void main();
