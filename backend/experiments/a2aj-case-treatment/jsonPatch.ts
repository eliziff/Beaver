/** Repair copied double quotes that a model left unescaped inside JSON strings. */
function repairUnescapedQuotes(text: string) {
  let out = "";
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (!inString) {
      if (character === '"') inString = true;
      out += character;
      continue;
    }
    if (character === "\\") {
      out += character + (text[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (character !== '"') {
      out += character;
      continue;
    }
    let lookahead = index + 1;
    while (lookahead < text.length && /\s/u.test(text[lookahead])) lookahead += 1;
    const next = text[lookahead];
    if (next === undefined || /[,}\]:]/u.test(next)) {
      inString = false;
      out += character;
    } else out += '\\"';
  }
  return out;
}

export function parseJson(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const unfenced = trimmed.replace(/^```(?:json)?\s*/u, "").replace(/```\s*$/u, "");
  try { return JSON.parse(unfenced) as unknown; }
  catch { /* Try the one known quote defect. */ }
  try { return JSON.parse(repairUnescapedQuotes(unfenced)) as unknown; }
  catch { /* Try one outermost balanced value. */ }
  const start = unfenced.search(/[{[]/u);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < unfenced.length; index += 1) {
    const character = unfenced[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") depth += 1;
    else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(unfenced.slice(start, index + 1)) as unknown; }
        catch { return null; }
      }
    }
  }
  return null;
}

type Operation = { op: "add" | "replace" | "remove"; path: string; value?: unknown };

function pointerParts(pointer: string) {
  if (!pointer.startsWith("/") || pointer === "/") throw new Error(`unsupported JSON Pointer ${JSON.stringify(pointer)}`);
  return pointer.slice(1).split("/").map((part) => {
    if (/~(?:[^01]|$)/u.test(part)) throw new Error(`invalid JSON Pointer escape in ${JSON.stringify(pointer)}`);
    const decoded = part.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (["__proto__", "prototype", "constructor"].includes(decoded)) throw new Error(`unsafe JSON Pointer ${JSON.stringify(pointer)}`);
    return decoded;
  });
}

export function applyJsonPatch(document: unknown, rawPatch: unknown) {
  if (!Array.isArray(rawPatch)) return { value: document, errors: ["correction: expected a JSON Patch array"] };
  if (rawPatch.length > 60) return { value: document, errors: ["correction: patch exceeds 60 operations"] };
  let value = structuredClone(document);
  try {
    for (const [index, raw] of rawPatch.entries()) {
      const operation = raw as Partial<Operation> | null;
      if (!operation || typeof operation !== "object" || !["add", "replace", "remove"].includes(String(operation.op)) || typeof operation.path !== "string") {
        throw new Error(`operation ${index + 1} is invalid`);
      }
      if (operation.path === "") {
        if (operation.op === "remove") throw new Error(`operation ${index + 1} cannot remove the root document`);
        if (!Object.hasOwn(operation, "value")) throw new Error(`operation ${index + 1} requires value`);
        value = structuredClone(operation.value);
        continue;
      }
      let parts = pointerParts(operation.path);
      if (
        parts.length > 1 && ["analysis", "structure"].includes(parts[0]) &&
        value && typeof value === "object" && !Array.isArray(value) &&
        !Object.hasOwn(value, parts[0]) && Object.hasOwn(value, parts[1])
      ) parts = parts.slice(1);
      let parent: unknown = value;
      for (const part of parts.slice(0, -1)) {
        if (Array.isArray(parent)) {
          if (!/^(?:0|[1-9][0-9]*)$/u.test(part) || Number(part) >= parent.length) throw new Error(`operation ${index + 1} path does not exist`);
          parent = parent[Number(part)];
        } else if (parent && typeof parent === "object" && Object.hasOwn(parent, part)) {
          parent = (parent as Record<string, unknown>)[part];
        } else throw new Error(`operation ${index + 1} path does not exist`);
      }
      const key = parts.at(-1)!;
      const op = operation.op as Operation["op"];
      if (op !== "remove" && !Object.hasOwn(operation, "value")) throw new Error(`operation ${index + 1} requires value`);
      if (Array.isArray(parent)) {
        if (op === "add" && key === "-") parent.push(operation.value);
        else {
          if (!/^(?:0|[1-9][0-9]*)$/u.test(key)) throw new Error(`operation ${index + 1} has an invalid array index`);
          const position = Number(key);
          if (op === "add") {
            if (position > parent.length) throw new Error(`operation ${index + 1} path does not exist`);
            parent.splice(position, 0, operation.value);
          } else {
            if (position >= parent.length) throw new Error(`operation ${index + 1} path does not exist`);
            if (op === "remove") parent.splice(position, 1);
            else parent[position] = operation.value;
          }
        }
      } else if (parent && typeof parent === "object") {
        const target = parent as Record<string, unknown>;
        if (op !== "add" && !Object.hasOwn(target, key)) throw new Error(`operation ${index + 1} path does not exist`);
        if (op === "remove") delete target[key];
        else target[key] = operation.value;
      } else throw new Error(`operation ${index + 1} parent is not a container`);
    }
    return { value, errors: [] as string[] };
  } catch (error) {
    return { value: document, errors: [`correction: ${error instanceof Error ? error.message : String(error)}`] };
  }
}
