import test from "node:test";
import assert from "node:assert/strict";
import { imageDigestsFromDetails } from "./provenance.mjs";

test("benchmark image provenance records image digests, not container IDs", () => {
  const details = {
    "http-backend": {
      Id: "container-http-id",
      Image: `sha256:${"a".repeat(64)}`,
    },
    generator: {
      Id: "container-generator-id",
      Image: `sha256:${"b".repeat(64)}`,
    },
  };

  assert.deepEqual(imageDigestsFromDetails(details), {
    "http-backend": `sha256:${"a".repeat(64)}`,
    generator: `sha256:${"b".repeat(64)}`,
  });
  assert.notEqual(imageDigestsFromDetails(details)["http-backend"], details["http-backend"].Id);
});
