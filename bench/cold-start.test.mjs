import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assertCpuGate,
  assertResetResponse,
  assertSnapshotWarmResponse,
  cpuPercentFromUsage,
  startGeneratorCpuSampler,
  discardWarmup,
  interleaveVariants,
  makeResult,
  validateProvenance,
  summarizeSamples,
  validateRepetitionPlan,
  verifyRoomJoined,
} from "./cold-start.mjs";

test("interleaves baseline and candidate without reordering either variant", () => {
  assert.deepEqual(
    interleaveVariants(
      [
        { variant: "baseline", sample: 1 },
        { variant: "baseline", sample: 2 },
      ],
      [
        { variant: "candidate", sample: 3 },
        { variant: "candidate", sample: 4 },
      ],
    ),
    [
      { variant: "baseline", sample: 1 },
      { variant: "candidate", sample: 3 },
      { variant: "baseline", sample: 2 },
      { variant: "candidate", sample: 4 },
    ],
  );
});

test("discardWarmup keeps the measured suffix", () => {
  assert.deepEqual(discardWarmup([0, 1, 2, 3], 2), [2, 3]);
  assert.throws(() => discardWarmup([0, 1], 2), /every sample/i);
});

test("room_joined self-check verifies deterministic identity, count, and content", () => {
  const expected = [
    { id: "shape-1", type: "rectangle", x: 1 },
    { id: "shape-2", type: "rectangle", x: 2 },
  ];
  assert.doesNotThrow(() =>
    verifyRoomJoined(
      { type: "room_joined", roomId: 7, version: 0, shapes: expected },
      7,
      expected,
    ),
  );
  assert.doesNotThrow(() =>
    verifyRoomJoined(
      {
        type: "room_joined",
        roomId: 7,
        shapes: [
          { x: 1, type: "rectangle", id: "shape-1" },
          { x: 2, type: "rectangle", id: "shape-2" },
        ],
      },
      7,
      expected,
    ),
  );
  assert.throws(
    () =>
      verifyRoomJoined(
        {
          type: "room_joined",
          roomId: 7,
          version: 0,
          shapes: expected.slice(0, 1),
        },
        7,
        expected,
      ),
    /shape count/i,
  );
  assert.throws(
    () =>
      verifyRoomJoined(
        {
          type: "room_joined",
          roomId: 7,
          version: 0,
          shapes: [{ ...expected[0], x: 99 }, expected[1]],
        },
        7,
        expected,
      ),
    /content/i,
  );
});

test("summary reports exact median and range", () => {
  assert.deepEqual(summarizeSamples([9, 1, 5, 3]), {
    median_ms: 4,
    range_ms: { min: 1, max: 9 },
    samples: 4,
  });
});

test("W4 accepts exactly 30 measured repetitions after warmup", () => {
  assert.equal(validateRepetitionPlan(30, 2, 32), 30);
  assert.throws(() => validateRepetitionPlan(29, 2, 31), /30 measured/i);
  assert.throws(() => validateRepetitionPlan(30, 2, 30), /warmup/i);
});

test("CPU gate uses only process.cpuUsage over the documented sample window", () => {
  assert.equal(cpuPercentFromUsage({ user: 7000, system: 3000 }, 10), 100);
  assert.equal(cpuPercentFromUsage({ user: 3500, system: 0 }, 10), 35);
  assert.doesNotThrow(() => assertCpuGate(70));
  assert.throws(() => assertCpuGate(70.01), /70%/);
  assert.throws(() => assertCpuGate(110), /110/);
});

test("generator CPU sampler records peak over complete one-second windows", () => {
  let now = 0;
  let used = 0;
  let tick;
  const sampler = startGeneratorCpuSampler({
    now: () => now,
    cpuUsage: (previous) =>
      previous
        ? { user: used - previous.user, system: 0 }
        : { user: used, system: 0 },
    schedule: (callback) => {
      tick = callback;
      return 1;
    },
    cancel: () => {},
  });
  now = 1000;
  used = 500000;
  tick();
  now = 2000;
  used = 1200000;
  tick();
  now = 2100;
  used = 1300000;
  assert.equal(sampler.stop(), 70);
});

test("provenance rejects placeholders and requires all runtime digests", () => {
  const provenance = {
    commit: "abc123",
    images: {
      generator: `sha256:${"a".repeat(64)}`,
      ws_baseline: `sha256:${"b".repeat(64)}`,
      ws_candidate: `sha256:${"b".repeat(64)}`,
    },
    host_cpu: "Apple CPU",
    sut_cpuset: "0-1",
    sut_memory_mb: 384,
    generator_cpu_peak_percent: 42,
    docker: "28.0.0",
    os: "darwin",
  };
  assert.doesNotThrow(() => validateProvenance(provenance));
  assert.throws(
    () =>
      validateProvenance({
        ...provenance,
        images: { ws_backend: "runtime-reported-by-manager" },
      }),
    /digest/i,
  );
});

test("per-sample results use the ledger claim and latency metric", () => {
  const result = makeResult({
    variant: "candidate",
    shapeCount: 100,
    repetition: 30,
    elapsedMs: 12.5,
    startedAt: "2026-01-01T00:00:00.000Z",
    provenance: {
      commit: "abc123",
      images: { generator: `sha256:${"a".repeat(64)}` },
      host_cpu: "Apple CPU",
      sut_cpuset: "2-3",
      sut_memory_mb: 384,
      generator_cpu_peak_percent: 40,
      docker: "28.0.0",
      os: "darwin",
    },
  });
  assert.deepEqual(result.metrics, [
    { name: "join_sync_latency_ms", unit: "milliseconds", value: 12.5 },
  ]);
  assert.equal(result.claim_id, "canvassync-redis-cold-start-latency");
  assert.ok(result.limitations.some((item) => item.includes("macOS")));
  assert.equal(result.duration_seconds, 0.0125);
  assert.equal(Object.hasOwn(result, "table"), false);
});

test("bench controls verify reset absence and Redis warm state", () => {
  assert.doesNotThrow(() => assertResetResponse({ statePresent: false }));
  assert.throws(
    () => assertResetResponse({ statePresent: true }),
    /in-memory/i,
  );
  assert.doesNotThrow(() =>
    assertSnapshotWarmResponse({ snapshotWarmed: true }),
  );
  assert.throws(
    () => assertSnapshotWarmResponse({ snapshotWarmed: false }),
    /Redis/i,
  );
});

test("W4 container harness contains no Docker CLI access", () => {
  assert.doesNotMatch(
    readFileSync(new URL("./w4-harness.mjs", import.meta.url), "utf8"),
    /docker/i,
  );
});

test("W4 executes only through the pinned generator container", () => {
  const makefile = readFileSync(
    new URL("../Makefile", import.meta.url),
    "utf8",
  );
  const target = makefile.slice(
    makefile.indexOf("bench-w4:"),
    makefile.indexOf("\nclaim:"),
  );
  assert.match(target, /exec -T/);
  assert.match(target, /generator-w4 node \/bench\/cold-start\.mjs/);
  assert.doesNotMatch(target, /\n\tnode bench\/cold-start\.mjs/);
});

test("cold join timing ends when parsed state arrives, before self-check work", () => {
  const source = readFileSync(
    new URL("./cold-start.mjs", import.meta.url),
    "utf8",
  );
  const messageHandler = source.slice(
    source.indexOf('socket.addEventListener("message"'),
  );
  const parsedAt = messageHandler.indexOf("JSON.parse(String(event.data))");
  const stoppedAt = messageHandler.indexOf(
    "const elapsedMs = performance.now() - openedAt",
  );
  const checkedAt = messageHandler.indexOf(
    "verifyRoomJoined(message, roomId, shapes)",
  );
  assert.ok(parsedAt >= 0 && stoppedAt > parsedAt && checkedAt > stoppedAt);
});
