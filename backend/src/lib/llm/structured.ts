import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";

type Check = ReturnType<AjvJsonSchemaValidator["getValidator"]>;
const validators = new WeakMap<object, Check>();

/** Cache by schema identity, not an untrusted $id. Each compiler dies with its schema. Ajv's message for an
 *  argument the schema does not take omits its name, so the message names it and the arguments the schema takes. */
export function schemaValidator(schema: Record<string, unknown>) {
  let check = validators.get(schema);
  if (!check) {
    const ajv = new AjvJsonSchemaValidator().getValidator(schema);
    const known = Object.keys((schema.properties ?? {}) as Record<string, unknown>);
    check = (value: unknown) => {
      const result = ajv(value);
      const extra = !result.valid && value && typeof value === "object" && !Array.isArray(value)
        ? Object.keys(value).filter((key) => !known.includes(key)) : [];
      return extra.length && result.errorMessage?.includes("must NOT have additional properties")
        ? { ...result, errorMessage: `${result.errorMessage}: ${extra.join(", ")}; it takes ${known.join(", ")}` } : result;
    };
    validators.set(schema, check);
  }
  return check;
}

export function validateModelOutput(schema: Record<string, unknown>, value: unknown) {
  const result = schemaValidator(schema)(value);
  return result.valid ? { success: true as const, value }
    : { success: false as const, error: new Error(result.errorMessage) };
}
