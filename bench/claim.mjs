import { execFile, execFileSync, spawn } from "node:child_process";
import { cpus, platform, release } from "node:os";
import { promisify } from "node:util";
import { writeResult, generatorCpuPeakPercent, median, range } from "./harness.mjs";
import { imageDigestsFromDetails } from "./provenance.mjs";

const execFileAsync = promisify(execFile);
const compose = ["compose", "-f", "docker-compose.bench.yml", "--project-name", "projectbench-w2"];
const run = (args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const gitCommit = () => execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const containerFor = (service) => run([...compose, "ps", "-q", service]);
const serviceContainers = ["http-backend", "ws-backend", "ai-worker", "generator"];
const containers = Object.fromEntries(serviceContainers.map((service) => [service, containerFor(service)]));
if (Object.values(containers).some((id) => !id)) throw new Error("bench stack is not running; run make bench-up first");

const inspect = (id) => JSON.parse(run(["inspect", id]))[0];
const appDetails = Object.fromEntries(Object.entries(containers).map(([service, id]) => [service, inspect(id)]));
const metadata = {
  commit: process.env.PROJECTBENCH_GIT_SHA ?? gitCommit(),
  docker: process.env.PROJECTBENCH_DOCKER_VERSION ?? run(["version", "--format", "{{.Server.Version}}"]),
  os: process.env.PROJECTBENCH_OS ?? `${platform()} ${release()}`,
  cpuModel: process.env.PROJECTBENCH_CPU_MODEL ?? cpus()[0]?.model ?? "unknown",
};
const images = imageDigestsFromDetails(appDetails);
const generator = containers.generator;
const generatorEnv = [metadata.commit, metadata.cpuModel, metadata.docker, metadata.os, JSON.stringify(images)].flatMap((value, index) => ["-e", `${["PROJECTBENCH_GIT_SHA", "PROJECTBENCH_CPU_MODEL", "PROJECTBENCH_DOCKER_VERSION", "PROJECTBENCH_OS", "PROJECTBENCH_IMAGE_IDS"][index]}=${value}`]);
const loadArgs = [...compose, "exec", "-T", ...generatorEnv, "generator", "node", "/bench/load.mjs", "http://http-backend:3001/health", "1"];

const cpuSamples = [];
let sampling = true;
const sampleCpu = async () => {
  try {
    const { stdout } = await execFileAsync("docker", ["stats", "--no-stream", "--format", "{{.CPUPerc}}", generator]);
    const value = Number.parseFloat(stdout.trim().replace("%", ""));
    if (Number.isFinite(value)) cpuSamples.push(value);
  } catch {}
  if (sampling) setTimeout(sampleCpu, 100);
};
const startedAt = new Date();
const started = performance.now();
void sampleCpu();
const load = spawn("docker", loadArgs, { stdio: ["ignore", "pipe", "inherit"] });
let output = "";
load.stdout.on("data", (chunk) => { output += chunk; });
const exitCode = await new Promise((resolve) => load.on("close", resolve));
sampling = false;
if (exitCode !== 0) throw new Error(`generator load failed with exit code ${exitCode}: ${output}`);
const durationSeconds = (performance.now() - started) / 1000;
const loadResult = JSON.parse(output.trim().split("\n").at(-1));
if (cpuSamples.length === 0) cpuSamples.push(Number.parseFloat(run(["stats", "--no-stream", "--format", "{{.CPUPerc}}", generator]).replace("%", "")));
const cpuPeak = generatorCpuPeakPercent(cpuSamples);
const samples = loadResult.samples;

const result = {
  schema_version: "1", claim_id: "w2-trivial", project: "canvassync", variant: "local", workload: "http-health-check",
  repetition: 1, started_at: startedAt.toISOString(), duration_seconds: durationSeconds,
  metrics: [
    { name: "health_latency_median", unit: "milliseconds", value: median(samples) },
    { name: "health_latency_range_min", unit: "milliseconds", value: range(samples).min },
    { name: "health_latency_range_max", unit: "milliseconds", value: range(samples).max },
  ],
  environment: {
    commit: metadata.commit, images, host_cpu: metadata.cpuModel,
    sut_cpuset: appDetails["http-backend"].HostConfig.CpusetCpus,
    sut_memory_mb: Math.round(appDetails["http-backend"].HostConfig.Memory / 1024 / 1024),
    generator_cpu_peak_percent: cpuPeak, docker: metadata.docker, os: metadata.os,
  },
  limitations: ["Local Docker evidence only; no production traffic."],
};
const outputPath = process.env.PROJECTBENCH_RESULT ?? "bench/results/w2-trivial.json";
writeResult(result, outputPath);
console.log(JSON.stringify({ output: outputPath, metrics: result.metrics, duration_seconds: durationSeconds }));
