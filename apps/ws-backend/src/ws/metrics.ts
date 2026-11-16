type CounterKey =
  | "connectionsOpened"
  | "connectionsClosed"
  | "messagesReceived"
  | "bytesReceived"
  | "invalidJsonPayloads"
  | "invalidMessages"
  | "oversizedMessages"
  | "rateLimitedSnapshots"
  | "versionMismatches"
  | "snapshotsCommitted"
  | "snapshotCommitFailures"
  | "redisFanoutEvents"
  | "snapshotCommitLatencyLe10ms"
  | "snapshotCommitLatencyLe50ms"
  | "snapshotCommitLatencyLe100ms"
  | "snapshotCommitLatencyGt100ms"
  | "snapshotProcessLatencyLe25ms"
  | "snapshotProcessLatencyLe75ms"
  | "snapshotProcessLatencyLe150ms"
  | "snapshotProcessLatencyGt150ms"
  | "redisFanoutLagLe10ms"
  | "redisFanoutLagLe50ms"
  | "redisFanoutLagLe100ms"
  | "redisFanoutLagGt100ms"
  | "durableEventsConsumed"
  | "durablePublishFailures"
  | "duplicateCrossNodeEvents"
  | "crossNodeVersionRegressions";

type Counters = Record<CounterKey, number>;

function emptyCounters(): Counters {
  return {
    connectionsOpened: 0,
    connectionsClosed: 0,
    messagesReceived: 0,
    bytesReceived: 0,
    invalidJsonPayloads: 0,
    invalidMessages: 0,
    oversizedMessages: 0,
    rateLimitedSnapshots: 0,
    versionMismatches: 0,
    snapshotsCommitted: 0,
    snapshotCommitFailures: 0,
    redisFanoutEvents: 0,
    snapshotCommitLatencyLe10ms: 0,
    snapshotCommitLatencyLe50ms: 0,
    snapshotCommitLatencyLe100ms: 0,
    snapshotCommitLatencyGt100ms: 0,
    snapshotProcessLatencyLe25ms: 0,
    snapshotProcessLatencyLe75ms: 0,
    snapshotProcessLatencyLe150ms: 0,
    snapshotProcessLatencyGt150ms: 0,
    redisFanoutLagLe10ms: 0,
    redisFanoutLagLe50ms: 0,
    redisFanoutLagLe100ms: 0,
    redisFanoutLagGt100ms: 0,
    durableEventsConsumed: 0,
    durablePublishFailures: 0,
    duplicateCrossNodeEvents: 0,
    crossNodeVersionRegressions: 0,
  };
}

const totals: Counters = emptyCounters();

let windowCounters: Counters = emptyCounters();
let reportStarted = false;

function inc(counter: CounterKey, delta = 1) {
  totals[counter] += delta;
  windowCounters[counter] += delta;
}

export function recordConnectionOpened() {
  inc("connectionsOpened");
}

export function recordConnectionClosed() {
  inc("connectionsClosed");
}

export function recordInboundMessage(bytes: number) {
  inc("messagesReceived");
  inc("bytesReceived", Math.max(0, bytes));
}

export function recordInvalidJsonPayload() {
  inc("invalidJsonPayloads");
}

export function recordInvalidMessagePayload() {
  inc("invalidMessages");
}

export function recordOversizedMessage() {
  inc("oversizedMessages");
}

export function recordRateLimitedSnapshot() {
  inc("rateLimitedSnapshots");
}

export function recordVersionMismatch() {
  inc("versionMismatches");
}

function recordCommitLatency(commitLatencyMs: number) {
  if (commitLatencyMs <= 10) {
    inc("snapshotCommitLatencyLe10ms");
  } else if (commitLatencyMs <= 50) {
    inc("snapshotCommitLatencyLe50ms");
  } else if (commitLatencyMs <= 100) {
    inc("snapshotCommitLatencyLe100ms");
  } else {
    inc("snapshotCommitLatencyGt100ms");
  }
}

function recordSnapshotProcessLatency(processLatencyMs: number) {
  if (processLatencyMs <= 25) {
    inc("snapshotProcessLatencyLe25ms");
  } else if (processLatencyMs <= 75) {
    inc("snapshotProcessLatencyLe75ms");
  } else if (processLatencyMs <= 150) {
    inc("snapshotProcessLatencyLe150ms");
  } else {
    inc("snapshotProcessLatencyGt150ms");
  }
}

export function recordSnapshotCommitted(
  commitLatencyMs?: number,
  processLatencyMs?: number,
) {
  inc("snapshotsCommitted");

  if (
    typeof commitLatencyMs === "number" &&
    Number.isFinite(commitLatencyMs) &&
    commitLatencyMs >= 0
  ) {
    recordCommitLatency(commitLatencyMs);
  }

  if (
    typeof processLatencyMs === "number" &&
    Number.isFinite(processLatencyMs) &&
    processLatencyMs >= 0
  ) {
    recordSnapshotProcessLatency(processLatencyMs);
  }
}

export function recordSnapshotCommitFailure() {
  inc("snapshotCommitFailures");
}

export function recordRedisFanoutEvent(fanoutLagMs?: number) {
  inc("redisFanoutEvents");

  if (
    typeof fanoutLagMs === "number" &&
    Number.isFinite(fanoutLagMs) &&
    fanoutLagMs >= 0
  ) {
    if (fanoutLagMs <= 10) {
      inc("redisFanoutLagLe10ms");
    } else if (fanoutLagMs <= 50) {
      inc("redisFanoutLagLe50ms");
    } else if (fanoutLagMs <= 100) {
      inc("redisFanoutLagLe100ms");
    } else {
      inc("redisFanoutLagGt100ms");
    }
  }
}

export function recordDurableEventConsumed() {
  inc("durableEventsConsumed");
}

export function recordDurablePublishFailure() {
  inc("durablePublishFailures");
}

export function recordDuplicateCrossNodeEvent() {
  inc("duplicateCrossNodeEvents");
}

export function recordCrossNodeVersionRegression() {
  inc("crossNodeVersionRegressions");
}

export function metricsEnabled() {
  return (
    process.env.WS_BENCH_SYNC_VARIANT === "baseline" ||
    process.env.WS_BENCH_SYNC_VARIANT === "candidate" ||
    process.env.WS_METRICS_ENABLED === "true"
  );
}

export function renderMetrics() {
  if (!metricsEnabled()) return null;
  return (
    Object.entries(totals)
      .map(([name, value]) => `canvassync_ws_${name} ${value}`)
      .join("\n") + "\n"
  );
}

export function startMetricsReporter(
  intervalMs = Number(process.env.WS_METRICS_LOG_INTERVAL_MS ?? 30000),
) {
  const metricsEnabled = process.env.WS_METRICS_ENABLED === "true";
  if (!metricsEnabled) {
    return;
  }

  if (reportStarted || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    return;
  }

  reportStarted = true;

  setInterval(() => {
    const snapshot = windowCounters;
    windowCounters = emptyCounters();

    console.info("[WS][metrics]", {
      intervalMs,
      window: snapshot,
      totals,
    });
  }, intervalMs).unref();
}
