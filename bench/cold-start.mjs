import { mkdirSync, writeFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { writeResult } from "./w4-harness.mjs";

const CPU_GATE_PERCENT = 70;

export function discardWarmup(samples, count) {
  if (!Number.isInteger(count) || count < 0)
    throw new Error("warm-up count must be a non-negative integer");
  if (count >= samples.length)
    throw new Error("warm-up discard would remove every sample");
  return samples.slice(count);
}

export function interleaveVariants(first, second) {
  if (first.length !== second.length)
    throw new Error("interleave requires equal repetitions");
  return first.flatMap((sample, index) => [sample, second[index]]);
}

export function verifyRoomJoined(message, roomId, expectedShapes) {
  if (message?.type !== "room_joined") throw new Error("missing room_joined");
  if (message.roomId !== roomId)
    throw new Error("room_joined room ID mismatch");
  if (
    !Array.isArray(message.shapes) ||
    message.shapes.length !== expectedShapes.length
  ) {
    throw new Error("room_joined shape count mismatch");
  }
  if (!isDeepStrictEqual(message.shapes, expectedShapes)) {
    throw new Error("room_joined shape content mismatch");
  }
}

export function summarizeSamples(samples) {
  if (samples.length === 0) throw new Error("cannot summarize empty samples");
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];
  return {
    median_ms: median,
    range_ms: { min: Math.min(...samples), max: Math.max(...samples) },
    samples: samples.length,
  };
}

export function validateRepetitionPlan(measured, warmup, collected) {
  if (measured !== 30)
    throw new Error("W4 requires exactly 30 measured repetitions");
  if (!Number.isInteger(warmup) || warmup < 1)
    throw new Error("warmup must be positive");
  if (collected !== measured + warmup)
    throw new Error("warmup samples must precede measured samples");
  return measured;
}

// The sample window is exactly one socket open -> room_joined operation. CPU is
// process.cpuUsage() delta divided by performance.now() wall-clock delta.
export function cpuPercentFromUsage(usage, elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0)
    throw new Error("CPU sample window must be positive");
  return ((usage.user + usage.system) / (elapsedMs * 1000)) * 100;
}

export function assertCpuGate(cpuPercent) {
  if (!Number.isFinite(cpuPercent) || cpuPercent < 0) {
    throw new Error("CPU sample must be a non-negative finite percentage");
  }
  if (cpuPercent > CPU_GATE_PERCENT)
    throw new Error(`CPU gate exceeded ${CPU_GATE_PERCENT}%: ${cpuPercent}`);
}

export function validateProvenance(provenance) {
  const digest = /^sha256:[0-9a-f]{64}$/;
  if (!provenance.commit || provenance.commit.includes("placeholder"))
    throw new Error("commit provenance is missing");
  for (const name of ["generator", "ws_baseline", "ws_candidate"]) {
    if (!digest.test(provenance.images?.[name] ?? ""))
      throw new Error(`${name} image provenance must be a digest`);
  }
  if (provenance.images.ws_baseline !== provenance.images.ws_candidate) {
    throw new Error("baseline and candidate must use the same image digest");
  }
  for (const name of ["host_cpu", "sut_cpuset", "docker", "os"]) {
    if (!provenance[name]) throw new Error(`${name} provenance is missing`);
  }
  if (
    !Number.isInteger(provenance.sut_memory_mb) ||
    provenance.sut_memory_mb < 1
  ) {
    throw new Error("sut memory provenance is invalid");
  }
  assertCpuGate(provenance.generator_cpu_peak_percent);
  return provenance;
}

export function makeResult({
  variant,
  shapeCount,
  repetition,
  elapsedMs,
  startedAt,
  provenance,
}) {
  return {
    schema_version: "1",
    claim_id: "w4-canvassync-cold-start",
    project: "canvassync",
    variant,
    workload: `cold-start-${shapeCount}-shapes`,
    repetition,
    started_at: startedAt,
    duration_seconds: elapsedMs / 1000,
    metrics: [{ name: "cold_join_ms", unit: "milliseconds", value: elapsedMs }],
    environment: provenance,
    limitations: ["Local Docker Compose only."],
  };
}

export function assertResetResponse(payload) {
  if (payload?.statePresent !== false)
    throw new Error("reset did not clear in-memory room state");
}

export function assertSnapshotWarmResponse(payload) {
  if (payload?.snapshotWarmed !== true)
    throw new Error("Redis snapshot was not warmed");
}

function expectedShapes(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `shape-${index + 1}`,
    type: "rectangle",
    x: index + 1,
  }));
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok)
    throw new Error(
      `${options.method ?? "GET"} ${url} returned HTTP ${response.status}`,
    );
  return response;
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function getWsToken() {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      userId: "00000000-0000-4000-8000-000000000001",
      name: "Bench User",
      type: "ws-handshake",
    }),
  );
  const body = `${header}.${payload}`;
  const signature = createHmac("sha256", "projectbench-local-only-jwt-secret")
    .update(body)
    .digest("base64url");
  return `${body}.${signature}`;
}

async function resetRoom(url, roomId) {
  const response = await request(
    `${url}/__bench/reset-room-state?roomId=${roomId}`,
    { method: "POST" },
  );
  const payload = await response.json();
  try {
    assertResetResponse(payload);
  } catch (error) {
    throw new Error(`${error.message} for ${roomId}`);
  }
}

async function warmSnapshot(url, roomId) {
  const response = await request(
    `${url}/__bench/warm-room-state?roomId=${roomId}`,
    { method: "POST" },
  );
  const payload = await response.json();
  try {
    assertSnapshotWarmResponse(payload);
  } catch (error) {
    throw new Error(`${error.message} for ${roomId}`);
  }
}

async function join(url, token, roomId, shapes) {
  const socket = new WebSocket(
    `${url.replace(/^http/, "ws")}/?token=${encodeURIComponent(token)}`,
  );
  return new Promise((resolve, reject) => {
    let openedAt;
    let startedAt;
    let cpuStarted;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      const complete = () => (error ? reject(error) : resolve(value));
      if (socket.readyState === WebSocket.CLOSED) complete();
      else {
        socket.addEventListener("close", complete, { once: true });
        socket.close();
      }
    };
    socket.addEventListener("error", (error) => finish(error));
    socket.addEventListener(
      "open",
      () => {
        openedAt = performance.now();
        startedAt = new Date().toISOString();
        cpuStarted = process.cpuUsage();
        socket.send(JSON.stringify({ type: "join_room", roomId }));
      },
      { once: true },
    );
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch (error) {
        finish(error);
        return;
      }
      if (message.type !== "room_joined") return;
      try {
        const elapsedMs = performance.now() - openedAt;
        const cpuPercent = cpuPercentFromUsage(
          process.cpuUsage(cpuStarted),
          elapsedMs,
        );
        verifyRoomJoined(message, roomId, shapes);
        finish(null, { elapsedMs, cpuPercent, startedAt });
      } catch (error) {
        finish(error);
      }
    });
  });
}

function envRequired(name) {
  const value = process.env[name];
  if (!value)
    throw new Error(`${name} must be supplied by the host Make target`);
  return value;
}

function runtimeProvenance() {
  return validateProvenance({
    commit: envRequired("PROJECTBENCH_COMMIT"),
    images: {
      generator: envRequired("PROJECTBENCH_IMAGE_GENERATOR"),
      ws_baseline: envRequired("PROJECTBENCH_IMAGE_WS_BASELINE"),
      ws_candidate: envRequired("PROJECTBENCH_IMAGE_WS_CANDIDATE"),
    },
    host_cpu: envRequired("PROJECTBENCH_HOST_CPU"),
    sut_cpuset: envRequired("PROJECTBENCH_SUT_CPUSET"),
    sut_memory_mb: Number(envRequired("PROJECTBENCH_SUT_MEMORY_MB")),
    generator_cpu_peak_percent: 0,
    docker: envRequired("PROJECTBENCH_DOCKER_VERSION"),
    os: envRequired("PROJECTBENCH_OS"),
  });
}

async function main() {
  const urls = {
    baseline:
      process.env.PROJECTBENCH_WS_BASELINE_URL ?? "http://ws-baseline:8081",
    candidate:
      process.env.PROJECTBENCH_WS_CANDIDATE_URL ?? "http://ws-candidate:8081",
  };
  const repetitions = Number(process.env.PROJECTBENCH_REPETITIONS ?? 30);
  const warmup = Number(process.env.PROJECTBENCH_WARMUP ?? 2);
  validateRepetitionPlan(repetitions, warmup, repetitions + warmup);
  const roomIds = { 100: 1001, 1000: 1002, 5000: 1003 };
  const token = getWsToken();
  const outputDirectory =
    process.env.PROJECTBENCH_OUTPUT_DIR ?? "/bench/results";
  const provenance = runtimeProvenance();
  const table = [];
  const accepted = [];

  for (const shapeCount of [100, 1000, 5000]) {
    const roomId = Number(
      process.env[`PROJECTBENCH_ROOM_${shapeCount}`] ?? roomIds[shapeCount],
    );
    const shapes = expectedShapes(shapeCount);
    const samples = { baseline: [], candidate: [] };
    for (let index = 0; index < warmup; index += 1) {
      await warmSnapshot(urls.candidate, roomId);
      await warmSnapshot(urls.baseline, roomId);
      await resetRoom(urls.baseline, roomId);
      await join(urls.baseline, token, roomId, shapes);
      await resetRoom(urls.candidate, roomId);
      await join(urls.candidate, token, roomId, shapes);
    }
    for (let index = 0; index < repetitions; index += 1) {
      await warmSnapshot(urls.candidate, roomId);
      await warmSnapshot(urls.baseline, roomId);
      await resetRoom(urls.baseline, roomId);
      const baseline = await join(urls.baseline, token, roomId, shapes);
      await resetRoom(urls.candidate, roomId);
      const candidate = await join(urls.candidate, token, roomId, shapes);
      assertCpuGate(baseline.cpuPercent);
      assertCpuGate(candidate.cpuPercent);
      samples.baseline.push(baseline);
      samples.candidate.push(candidate);
      accepted.push({
        variant: "baseline",
        shapeCount,
        repetition: index + 1,
        sample: baseline,
      });
      accepted.push({
        variant: "candidate",
        shapeCount,
        repetition: index + 1,
        sample: candidate,
      });
    }
    table.push({
      shapes: shapeCount,
      baseline: summarizeSamples(
        samples.baseline.map(({ elapsedMs }) => elapsedMs),
      ),
      candidate: summarizeSamples(
        samples.candidate.map(({ elapsedMs }) => elapsedMs),
      ),
    });
  }

  if (accepted.length !== 180)
    throw new Error(`W4 requires 180 accepted samples, got ${accepted.length}`);
  mkdirSync(outputDirectory, { recursive: true });
  for (const { variant, shapeCount, repetition, sample } of accepted) {
    writeResult(
      makeResult({
        variant,
        shapeCount,
        repetition,
        elapsedMs: sample.elapsedMs,
        startedAt: sample.startedAt,
        provenance: validateProvenance({
          ...provenance,
          generator_cpu_peak_percent: sample.cpuPercent,
        }),
      }),
      `${outputDirectory}/w4-cold-start-${variant}-${shapeCount}-${repetition}.json`,
    );
  }
  writeFileSync(
    `${outputDirectory}/w4-cold-start-summary.json`,
    `${JSON.stringify({ table }, null, 2)}\n`,
    "utf8",
  );
  console.table(
    table.map(({ shapes, baseline, candidate }) => ({
      shapes,
      baseline_median_ms: baseline.median_ms,
      baseline_range_ms: `${baseline.range_ms.min}-${baseline.range_ms.max}`,
      candidate_median_ms: candidate.median_ms,
      candidate_range_ms: `${candidate.range_ms.min}-${candidate.range_ms.max}`,
    })),
  );
  console.log(`accepted ${accepted.length} schema-v1 samples`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
