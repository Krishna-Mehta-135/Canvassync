const url = process.argv[2] ?? "http://http-backend:3001/health";
const repetitions = Number(process.argv[3] ?? 6);
const samples = [];

for (let index = 0; index < repetitions; index += 1) {
  const started = performance.now();
  const response = await fetch(url);
  if (!response.ok) throw new Error(`load request returned HTTP ${response.status}`);
  samples.push(performance.now() - started);
}

process.stdout.write(`${JSON.stringify({ samples })}\n`);
