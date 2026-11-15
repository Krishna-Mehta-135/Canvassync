import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

export const SCHEMA_PATH = process.env.PROJECTBENCH_SCHEMA ??
  resolve(dirname(fileURLToPath(import.meta.url)), "result-schema.schema.json");

export function median(values) {
  if (values.length === 0) throw new Error("median requires at least one value");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function range(values) {
  if (values.length === 0) throw new Error("range requires at least one value");
  return { min: Math.min(...values), max: Math.max(...values) };
}

export function interleave(first, second) {
  if (first.length !== second.length) {
    throw new Error("interleave requires equal repetitions");
  }
  const output = [];
  const length = first.length;
  for (let index = 0; index < length; index += 1) {
    if (index < first.length) output.push(first[index]);
    if (index < second.length) output.push(second[index]);
  }
  return output;
}

export function discardWarmup(samples, count) {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error("warm-up count must be a non-negative integer");
  }
  if (count >= samples.length) {
    throw new Error("warm-up discard would remove every sample");
  }
  return samples.slice(count);
}

export function generatorCpuPeakPercent(samples) {
  if (samples.length === 0) throw new Error("CPU sampling requires samples");
  const peak = Math.max(...samples);
  if (!Number.isFinite(peak) || peak < 0 || peak > 100) {
    throw new Error("generator CPU samples must be between 0 and 100");
  }
  if (peak > 70) {
    throw new Error("generator CPU peak exceeds threshold 70%");
  }
  return peak;
}

function assertType(value, expected, path) {
  const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
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
      if (!Object.hasOwn(value, required)) throw new Error(`${path}.${required} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties ?? {}, key)) {
          throw new Error(`${path} has additional property ${key}`);
        }
      }
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) validateAgainstSchema(value[key], child, `${path}.${key}`, root);
    }
    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) {
      throw new Error(`${path} needs at least ${schema.minProperties} properties`);
    }
    return;
  }
  if (schema.type === "array") {
    assertType(value, "array", path);
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      throw new Error(`${path} needs at least ${schema.minItems} items`);
    }
    for (const [index, child] of value.entries()) validateAgainstSchema(child, schema.items, `${path}[${index}]`, root);
    return;
  }
  if (schema.type === "string") {
    assertType(value, "string", path);
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new Error(`${path} is empty`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) throw new Error(`${path} has invalid format`);
    if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) throw new Error(`${path} is not date-time`);
    return;
  }
  if (schema.type === "integer") {
    if (!Number.isInteger(value)) throw new Error(`${path} must be integer`);
  } else if (schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be number`);
  } else {
    assertType(value, schema.type, path);
  }
  if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`${path} is below minimum`);
  if (schema.maximum !== undefined && value > schema.maximum) throw new Error(`${path} is above maximum`);
}

export function validateResult(result, schemaPath = SCHEMA_PATH) {
  const schema = JSON.parse(readFileSync(resolve(schemaPath), "utf8"));
  validateAgainstSchema(result, schema, "$", schema);
  return result;
}

export function writeResult(result, outputPath, schemaPath = SCHEMA_PATH) {
  validateResult(result, schemaPath);
  mkdirSync(dirname(resolve(outputPath)), { recursive: true });
  writeFileSync(resolve(outputPath), `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

export function dockerInspect(format, container) {
  return execFileSync("docker", ["inspect", "--format", format, container], { encoding: "utf8" }).trim();
}

export async function measureHealth(url, repetitions, warmup) {
  const samples = [];
  for (let index = 0; index < repetitions + warmup; index += 1) {
    const started = performance.now();
    const response = await fetch(url);
    if (!response.ok) throw new Error(`health check returned HTTP ${response.status}`);
    const elapsed = performance.now() - started;
    samples.push(elapsed);
  }
  return discardWarmup(samples, warmup);
}
