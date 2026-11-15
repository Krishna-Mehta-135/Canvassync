import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const makefile = await readFile(join(root, "Makefile"), "utf8");
const gitignore = await readFile(join(root, ".gitignore"), "utf8");

test("Makefile exposes the planned trivial benchmark target", () => {
  assert.match(makefile, /^bench-trivial:\n\tnode bench\/claim\.mjs$/m);
});

test("claim remains a compatibility alias and benchmark results are ignored", () => {
  assert.match(makefile, /^claim: bench-trivial$/m);
  assert.match(gitignore, /^bench\/results\/$/m);
});
