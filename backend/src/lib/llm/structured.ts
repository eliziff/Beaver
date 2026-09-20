import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";

const validators = new WeakMap<object, ReturnType<AjvJsonSchemaValidator["getValidator"]>>();

export function validateModelOutput(schema: Record<string, unknown>, value: unknown) {
  let check = validators.get(schema);
  if (!check) { check = new AjvJsonSchemaValidator().getValidator(schema); validators.set(schema, check); }
  const result = check(value);
  return result.valid ? { success: true as const, value }
    : { success: false as const, error: new Error(result.errorMessage) };
}
