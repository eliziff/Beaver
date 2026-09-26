import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";

const validators = new WeakMap<object, ReturnType<AjvJsonSchemaValidator["getValidator"]>>();

/** Cache by schema identity, not an untrusted $id. Each compiler dies with its schema. */
export function schemaValidator(schema: Record<string, unknown>) {
  let check = validators.get(schema);
  if (!check) { check = new AjvJsonSchemaValidator().getValidator(schema); validators.set(schema, check); }
  return check;
}

export function validateModelOutput(schema: Record<string, unknown>, value: unknown) {
  const result = schemaValidator(schema)(value);
  return result.valid ? { success: true as const, value }
    : { success: false as const, error: new Error(result.errorMessage) };
}
