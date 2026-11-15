import test from "node:test";
import assert from "node:assert/strict";
import {
  discardWarmup,
  generatorCpuPeakPercent,
  interleave,
  median,
  range,
  validateResult,
  SCHEMA_PATH,
} from "./harness.mjs";

test("median and range preserve exact measured values", () => {
  assert.equal(median([9, 1, 5, 3]), 4);
  assert.deepEqual(range([9, 1, 5, 3]), { min: 1, max: 9 });
});

test("interleave alternates A and B without reordering either variant", () => {
  assert.deepEqual(interleave(["a1", "a2"], ["b1", "b2"]), [
    "a1",
    "b1",
    "a2",
    "b2",
  ]);
  assert.throws(() => interleave(["a1"], ["b1", "b2"]), /equal/i);
});

test("warm-up discard removes only the requested prefix", () => {
  assert.deepEqual(discardWarmup([0, 1, 2, 3], 2), [2, 3]);
});

test("generator CPU threshold rejects a sample above the configured limit", () => {
  assert.equal(generatorCpuPeakPercent([12.5, 33, 24]), 33);
  assert.throws(() => generatorCpuPeakPercent([12.5, 70.01, 24]), /70%/);
});

test("uses the vendored ProjectBench schema and rejects schema-invalid results", () => {
  assert.match(SCHEMA_PATH, /bench[\\/]result-schema\.schema\.json$/);
});

test("result writer validator accepts only the supplied schema-v1 shape", () => {
  const result = {
    schema_version: "1",
    claim_id: "w2-trivial",
    project: "canvassync",
    variant: "local",
    workload: "health-check",
    repetition: 1,
    started_at: "2026-01-01T00:00:00.000Z",
    duration_seconds: 0.25,
    metrics: [{ name: "latency", unit: "milliseconds", value: 2.5 }],
    environment: {
      commit: "abc123",
      images: { app: `sha256:${"a".repeat(64)}` },
      host_cpu: "4",
      sut_cpuset: "0-1",
      sut_memory_mb: 384,
      generator_cpu_peak_percent: 0,
      docker: "Docker version 27",
      os: "linux",
    },
    limitations: ["Local Docker only."],
  };

  assert.doesNotThrow(() => validateResult(result));
  assert.throws(
    () => validateResult({ ...result, unexpected: true }),
    /additional property/i,
  );
});
