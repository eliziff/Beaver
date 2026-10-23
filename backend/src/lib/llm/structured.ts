import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";

type Check = ReturnType<AjvJsonSchemaValidator["getValidator"]>;
type Schema = Record<string, unknown>;
const validators = new WeakMap<object, Check>();

/** The value and its schema at an Ajv instance path ("data/claims/0"). */
function at(value: unknown, schema: Schema, path: string) {
  for (const step of path.split("/").slice(1)) {
    if (value === null || typeof value !== "object") return null;
    value = (value as Record<string, unknown>)[step];
    schema = (/^\d+$/u.test(step) ? schema.items : (schema.properties as Record<string, Schema> | undefined)?.[step]) as Schema ?? {};
  }
  return { value, schema };
}

/** Cache by schema identity, not an untrusted $id. Each compiler dies with its schema. Ajv's message for a
 *  property the schema does not take omits its name, so each such message names it and the properties taken there. */
export function schemaValidator(schema: Schema) {
  let check = validators.get(schema);
  if (!check) {
    const ajv = new AjvJsonSchemaValidator().getValidator(schema);
    check = (value: unknown) => {
      const result = ajv(value);
      if (result.valid || !result.errorMessage) return result;
      const errorMessage = result.errorMessage.replace(/(\bdata[\w/]*) must NOT have additional properties/gu, (message, path: string) => {
        const found = at(value, schema, path);
        if (!found || !found.value || typeof found.value !== "object" || Array.isArray(found.value)) return message;
        const known = Object.keys((found.schema.properties ?? {}) as Schema);
        const extra = Object.keys(found.value).filter((key) => !known.includes(key));
        return extra.length ? `${message} (${extra.join(", ")}; it takes ${known.join(", ")})` : message;
      });
      return { ...result, errorMessage };
    };
    validators.set(schema, check);
  }
  return check;
}

export function validateModelOutput(schema: Schema, value: unknown) {
  const result = schemaValidator(schema)(value);
  return result.valid ? { success: true as const, value }
    : { success: false as const, error: new Error(result.errorMessage) };
}
