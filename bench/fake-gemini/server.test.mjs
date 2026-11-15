import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { getFakeGeminiConfig, responseDelayMs, shouldRateLimit } from "./server.mjs";

const serverDirectory = fileURLToPath(new URL(".", import.meta.url));

async function getAvailablePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

test("fake Gemini exposes configurable delay, token rate, and 429 rate", () => {
  const config = getFakeGeminiConfig({ FAKE_GEMINI_DELAY_MS: "25", FAKE_GEMINI_TOKENS_PER_SECOND: "20", FAKE_GEMINI_429_RATE: "0.5" });
  assert.deepEqual(config, { delayMs: 25, tokensPerSecond: 20, rate429: 0.5 });
  assert.equal(responseDelayMs(config, 20), 1025);
  assert.equal(shouldRateLimit(config, 0.49), true);
  assert.equal(shouldRateLimit(config, 0.5), false);
});

test("fake Gemini controls have safe defaults and no forced real calls", () => {
  const config = getFakeGeminiConfig({});
  assert.deepEqual(config, { delayMs: 0, tokensPerSecond: 0, rate429: 0 });
  assert.equal(responseDelayMs(config, 100), 0);
  assert.equal(shouldRateLimit(config, 0), false);
});

test("fake Gemini starts when run as a script and serves health", async () => {
  const port = await getAvailablePort();
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: serverDirectory,
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  });
  const childExit = once(child, "exit");

  try {
    let response;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        response = await fetch(`http://127.0.0.1:${port}/health`);
        break;
      } catch (error) {
        if (attempt === 19) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  } finally {
    child.kill();
    await childExit;
  }
});
