import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { imagesFromCompose } from "./security-scan.mjs";

const FIXTURE = `
services:
  redis:
    image: redis:7-alpine
  postgres:
    image: &postgres-image pgvector/pgvector:0.8.5-pg16@sha256:abc
  db-reset:
    image: *postgres-image
  # image: ignored:1
  other:
    image: redis:7-alpine
`;

test("imagesFromCompose dedupes anchors/aliases/duplicates and ignores comments", () => {
  assert.deepEqual(imagesFromCompose(FIXTURE), [
    "pgvector/pgvector:0.8.5-pg16@sha256:abc",
    "redis:7-alpine",
  ]);
});

test("imagesFromCompose finds every concrete image the real compose.yaml declares", () => {
  const composeFile = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "compose.yaml");
  const images = imagesFromCompose(readFileSync(composeFile, "utf8"));

  assert.ok(images.length > 0, "compose.yaml must declare at least one image");
  for (const image of images) {
    assert.equal(image.startsWith("*"), false, `${image} is an unresolved alias`);
    assert.equal(image.startsWith("&"), false, `${image} is an unstripped anchor`);
    assert.ok(
      image.includes(":") || image.includes("@sha256:"),
      `${image} has neither a tag nor a digest`,
    );
  }
});
