import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const composePath = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "docker-compose.bench.yml",
);
const compose = await readFile(composePath, "utf8");

function serviceBlock(name) {
  const lines = compose.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.notEqual(start, -1, `service ${name} should be present`);
  const end = lines.findIndex(
    (line, index) => index > start && /^  [a-zA-Z0-9_-]+:/.test(line),
  );
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

test("bench db-init uses the Prisma CLI installed in the db package", () => {
  const dbInit = serviceBlock("db-init");

  assert.match(
    dbInit,
    /command: \["packages\/db\/node_modules\/\.bin\/prisma", "db", "push", "--config", "packages\/db\/prisma\.config\.ts", "--schema", "packages\/db\/prisma\/schema\.prisma"\]/,
  );
  assert.doesNotMatch(dbInit, /--skip-generate/);
  assert.doesNotMatch(dbInit, /command: \["node_modules\/\.bin\/prisma"/);
});

test("bench database initialization keeps ordering and resource limits", () => {
  const dbInit = serviceBlock("db-init");
  const dbSeed = serviceBlock("db-seed");

  assert.match(dbInit, /postgres:\n\s+condition: service_healthy/);
  assert.match(dbInit, /mem_limit: 384m/);
  assert.match(
    dbSeed,
    /db-init:\n\s+condition: service_completed_successfully/,
  );
  assert.match(dbSeed, /mem_limit: 384m/);
});

test("fake Gemini healthcheck uses IPv4 loopback", () => {
  const fakeGemini = serviceBlock("fake-gemini");

  assert.match(
    fakeGemini,
    /test: \["CMD", "wget", "-qO-", "http:\/\/127\.0\.0\.1:8088\/health"\]/,
  );
  assert.doesNotMatch(fakeGemini, /http:\/\/localhost:8088\/health/);
});

test("W4 seeds through its running Postgres service without starting the W2 seed container", () => {
  const makefile = readFileSync(
    new URL("../Makefile", import.meta.url),
    "utf8",
  );
  const w4Up = makefile.slice(
    makefile.indexOf("bench-w4-up:"),
    makefile.indexOf("bench-w4-down:"),
  );
  assert.match(serviceBlock("db-seed"), /profiles: \["w2"\]/);
  assert.match(serviceBlock("http-backend"), /profiles: \["w2"\]/);
  assert.match(
    serviceBlock("ws-baseline"),
    /db-init:\n\s+condition: service_completed_successfully/,
  );
  assert.match(
    serviceBlock("ws-candidate"),
    /db-init:\n\s+condition: service_completed_successfully/,
  );
  assert.match(
    w4Up,
    /exec -T postgres psql .*ON_ERROR_STOP=1.*< bench\/seed\.sql/,
  );
});

test("W4 baseline and candidate run the same built image", () => {
  const baseline = serviceBlock("ws-baseline");
  const candidate = serviceBlock("ws-candidate");
  const image = baseline.match(/^    image: (.+)$/m)?.[1];
  assert.ok(image, "baseline must name the shared image");
  assert.match(baseline, /^    build:$/m);
  assert.match(candidate, new RegExp(`^    image: ${image}$`, "m"));
  assert.doesNotMatch(candidate, /^    build:$/m);
});

test("W4 passes running-container image digests to the harness", () => {
  const makefile = readFileSync(new URL("../Makefile", import.meta.url), "utf8");
  const w4 = makefile.slice(makefile.indexOf("bench-w4:\n"));
  for (const service of ["generator-w4", "ws-baseline", "ws-candidate"]) {
    assert.match(w4, new RegExp(`docker inspect -f '\\{\\{.Image\\}\\}' .*ps -q ${service}`));
  }
  assert.doesNotMatch(w4, /images -q/);
});
