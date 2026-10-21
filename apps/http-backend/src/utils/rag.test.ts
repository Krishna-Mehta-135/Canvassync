import { describe, it, expect, vi } from "vitest";

vi.mock("@repo/db/client", () => ({ prismaClient: {} }));

import { buildReferenceBlock, chunkText } from "./rag";

describe("chunkText", () => {
  it("returns nothing for blank text", () => {
    expect(chunkText("  \n ")).toEqual([]);
  });

  it("keeps short text as one chunk", () => {
    expect(chunkText("Hello world.")).toEqual(["Hello world."]);
  });

  it("splits long text into overlapping bounded chunks that cover everything", () => {
    const text = Array.from({ length: 200 }, (_, i) => `Sentence number ${i}.`).join(" ");
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000);
    expect(chunks[0]).toContain("Sentence number 0.");
    expect(chunks[chunks.length - 1]).toContain("Sentence number 199.");
  });
});

describe("buildReferenceBlock", () => {
  it("is empty without chunks", () => {
    expect(buildReferenceBlock([])).toBe("");
  });

  it("numbers passages with their source name", () => {
    const block = buildReferenceBlock([{ content: "Auth uses JWT.", sourceName: "spec.md", score: 0.9 }]);
    expect(block).toContain("[1] (spec.md) Auth uses JWT.");
    expect(block.endsWith("Request: ")).toBe(true);
  });
});
