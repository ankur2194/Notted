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

/*
 * The scan reads `image:` keys only. `minio` and `minio-init` are BUILT from a
 * pinned upstream source commit rather than pulled, and they declared no
 * `image:` at all — so `pnpm security:containers` skipped both and still printed
 * "no vulnerabilities found". They are the two images a scan is most useful on.
 *
 * Asserting against the real compose.yaml, not a fixture: a fixture would have
 * passed on the day the bug shipped.
 */
test("imagesFromCompose finds the built MinIO images, which have no upstream tag", () => {
  const composeFile = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "compose.yaml");
  const images = imagesFromCompose(readFileSync(composeFile, "utf8"));

  for (const expected of ["notted-dev-minio-server:local", "notted-dev-minio-client:local"]) {
    assert.ok(images.includes(expected), `${expected} is not scanned`);
  }
});

/*
 * Docker's default json-file driver has no size limit, and this daemon is shared
 * with other projects — one crash-looping service fills the host disk and takes
 * all of them down. Every service that stays up must therefore opt into the
 * `x-log-rotation` anchor. `restart: unless-stopped` is the marker for "stays
 * up": the one-shot init containers use `restart: "no"` and are exempt.
 *
 * A text predicate rather than a YAML parse, for the same reason
 * `imagesFromCompose` is one — see its ponytail note. Same ceiling, same
 * upgrade path.
 */
test("every long-running compose service opts into bounded logs", () => {
  const composeFile = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "compose.yaml");
  const text = readFileSync(composeFile, "utf8");

  // Split on top-level (two-space indented) service keys, skipping the
  // `x-`prefixed YAML extension blocks above `services:`.
  const blocks = text.split(/\n {2}(?=[a-z][a-z0-9-]*:\n)/u);
  const offenders = blocks
    .filter((block) => /\n {4}restart: unless-stopped\b/u.test(block))
    .filter((block) => !/\n {4}logging: \*log-rotation\b/u.test(block))
    .map((block) => block.slice(0, block.indexOf(":")).trim());

  assert.deepEqual(offenders, [], `services with unbounded logs: ${offenders.join(", ")}`);
});
