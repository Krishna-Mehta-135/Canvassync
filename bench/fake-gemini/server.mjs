import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.env.PORT ?? 8088);
export function getFakeGeminiConfig(env = process.env) {
  return {
    delayMs: Math.max(0, Number(env.FAKE_GEMINI_DELAY_MS ?? 0)),
    tokensPerSecond: Math.max(0, Number(env.FAKE_GEMINI_TOKENS_PER_SECOND ?? 0)),
    rate429: Math.min(1, Math.max(0, Number(env.FAKE_GEMINI_429_RATE ?? 0))),
  };
}

export function responseDelayMs(config, tokenCount) {
  return config.delayMs + (config.tokensPerSecond > 0 ? (tokenCount / config.tokensPerSecond) * 1000 : 0);
}

export function shouldRateLimit(config, random = Math.random()) {
  return random < config.rate429;
}

const responseFor = (body) => {
  const prompt = JSON.stringify(body);
  if (prompt.includes('"title"') || prompt.includes("structured")) {
    return JSON.stringify({
      title: "Bench diagram",
      direction: "LR",
      nodes: [
        { id: "start", label: "Start", kind: "circle", tone: "sky" },
        { id: "step", label: "Step", kind: "rect", tone: "blue" },
        { id: "end", label: "End", kind: "circle", tone: "green" },
      ],
      edges: [{ from: "start", to: "step" }, { from: "step", to: "end" }],
    });
  }
  if (prompt.includes("OUTLINE")) return "## Summary\nBench response.\n## Key points\n- Local.\n## Action items\n- [ ] None identified";
  return [{ type: "text", id: "bench-title", x: 100, y: 100, text: "Bench", fontSize: 16, width: 80, height: 24 }];
};

export function createFakeGeminiServer(config = getFakeGeminiConfig()) {
  return createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (request.method !== "POST" || !request.url?.includes(":generateContent")) {
    response.writeHead(404);
    response.end();
    return;
  }
  let raw = "";
  request.on("data", (chunk) => { raw += chunk; });
  request.on("end", () => {
    const text = responseFor(JSON.parse(raw));
    const finish = () => {
      if (shouldRateLimit(config)) {
        response.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
        response.end(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }] }));
    };
    const tokenCount = Math.max(1, Math.ceil(text.length / 4));
    const delay = responseDelayMs(config, tokenCount);
    if (delay > 0) setTimeout(finish, delay);
    else finish();
  });
  });
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  createFakeGeminiServer().listen(port, "0.0.0.0");
}
