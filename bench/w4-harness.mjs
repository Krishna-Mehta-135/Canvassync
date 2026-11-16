import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "result-schema.schema.json",
);

function assertType(value, expected, path) {
  const actual = Array.isArray(value)
    ? "array"
    : value === null
      ? "null"
      : typeof value;
  if (actual !== expected) throw new Error(`${path} must be ${expected}`);
}

function validateAgainstSchema(value, schema, path, root) {
  if (schema.$ref) {
    const definition = schema.$ref.replace("#/$defs/", "");
    return validateAgainstSchema(value, root.$defs[definition], path, root);
  }
  if (schema.const !== undefined && value !== schema.const) {
    throw new Error(`${path} must equal ${JSON.stringify(schema.const)}`);
  }
  if (!schema.type) return;
  if (schema.type === "object") {
    assertType(value, "object", path);
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required))
        throw new Error(`${path}.${required} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties ?? {}, key))
          throw new Error(`${path} has additional property ${key}`);
      }
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key))
        validateAgainstSchema(value[key], child, `${path}.${key}`, root);
    }
    if (
      schema.minProperties !== undefined &&
      Object.keys(value).length < schema.minProperties
    ) {
      throw new Error(
        `${path} needs at least ${schema.minProperties} properties`,
      );
    }
    return;
  }
  if (schema.type === "array") {
    assertType(value, "array", path);
    if (schema.minItems !== undefined && value.length < schema.minItems)
      throw new Error(`${path} needs at least ${schema.minItems} items`);
    for (const [index, child] of value.entries())
      validateAgainstSchema(child, schema.items, `${path}[${index}]`, root);
    return;
  }
  if (schema.type === "string") {
    assertType(value, "string", path);
    if (schema.minLength !== undefined && value.length < schema.minLength)
      throw new Error(`${path} is empty`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value))
      throw new Error(`${path} has invalid format`);
    if (schema.format === "date-time" && Number.isNaN(Date.parse(value)))
      throw new Error(`${path} is not date-time`);
    return;
  }
  if (schema.type === "integer") {
    if (!Number.isInteger(value)) throw new Error(`${path} must be integer`);
  } else if (schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new Error(`${path} must be number`);
  } else {
    assertType(value, schema.type, path);
  }
  if (schema.minimum !== undefined && value < schema.minimum)
    throw new Error(`${path} is below minimum`);
  if (schema.maximum !== undefined && value > schema.maximum)
    throw new Error(`${path} is above maximum`);
}

export function validateResult(result, schemaPath = SCHEMA_PATH) {
  const schema = JSON.parse(readFileSync(resolve(schemaPath), "utf8"));
  validateAgainstSchema(result, schema, "$", schema);
  return result;
}

export function writeResult(result, outputPath, schemaPath = SCHEMA_PATH) {
  validateResult(result, schemaPath);
  mkdirSync(dirname(resolve(outputPath)), { recursive: true });
  writeFileSync(
    resolve(outputPath),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
}
