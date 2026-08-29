import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  IGNORE_FILE,
  imagesFromCompose,
  TRIVY_IMAGE,
  trivyRunArguments,
} from "./security-scan.mjs";

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
test("imagesFromCompose finds the built images, which have no upstream tag", () => {
  const composeFile = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "compose.yaml");
  const images = imagesFromCompose(readFileSync(composeFile, "utf8"));

  for (const expected of [
    "notted-dev-minio-server:local",
    "notted-dev-minio-client:local",
    // Patched upstream images (docker/patched-images). They are built for the
    // sole purpose of clearing advisories, so a scan that cannot see them is
    // worse than useless: it would report clean while the patch layer went
    // missing.
    "notted-dev-postgres:local",
    "notted-dev-meilisearch:local",
    "notted-dev-mailpit:local",
  ]) {
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

/*
 * A suppressed advisory must expire against something that is actually
 * scheduled.
 *
 * `pnpm security:deps` is `pnpm audit --prod --audit-level=high`, so every id in
 * `pnpm.auditConfig.ignoreGhsas` is a HIGH-or-worse advisory the gate reports as
 * green. E6 and E7 were both filed with the deadline "the next dependency-matrix
 * refresh", and E3 with "the next dependency refresh" — none of which is an
 * event anyone has committed to. An undated suppression survives to production
 * by default rather than by decision, and the release checklist has nothing to
 * trip on. Requiring a numbered Plan part in the exception's own Deadline line
 * is what turns the suppression back into a dated promise.
 *
 * A text predicate over the checklist, not a Markdown parse — same ceiling and
 * same upgrade path as the two predicates above.
 */
test("every suppressed advisory names a Plan part as its deadline", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const checklist = readFileSync(
    join(root, "docs", "security", "remediation-checklist.md"),
    "utf8",
  );

  const suppressed = packageJson.pnpm?.auditConfig?.ignoreGhsas ?? [];
  assert.ok(suppressed.length > 0, "expected at least one suppressed advisory to check");

  // Each `### E<n> — …` block runs until the next `###`/`##` heading.
  const sections = checklist.split(/\n(?=#{2,3} )/u).filter((block) => /^### E\d+ /u.test(block));

  for (const advisory of suppressed) {
    const owning = sections.filter((section) => section.includes(advisory));
    assert.equal(
      owning.length >= 1,
      true,
      `${advisory} is suppressed in package.json but has no exception section in ` +
        "docs/security/remediation-checklist.md",
    );
    for (const section of owning) {
      const deadline = /\*\*Deadline:\*\*([\s\S]*?)\n- /u.exec(section)?.[1] ?? "";
      assert.match(
        deadline,
        /\*\*Part \d+\*\*/u,
        `${advisory}: exception "${section.slice(4, section.indexOf("\n"))}" has a deadline ` +
          `that names no Plan part (${deadline.trim().replace(/\s+/gu, " ")})`,
      );
    }
  }
});

/*
 * The scanner's own image was the only image reference in the repository pinned
 * by tag rather than digest, and the digest rule above cannot see it: that rule
 * reads compose.yaml, and this one lives in a `.mjs`.
 */
test("the Trivy image is pinned by digest, like every compose image", () => {
  assert.match(
    TRIVY_IMAGE,
    /@sha256:[0-9a-f]{64}$/u,
    "the scanner must be pinned by digest, not by a floating tag",
  );
});

/*
 * `--volume /var/run/docker.sock:...:ro` gave the scanner container the full
 * daemon API: read-only on a unix socket restricts writing the socket file, not
 * what can be asked through it. On this shared daemon that is the ability to
 * delete images and volumes belonging to every other project on the machine.
 */
test("the scan container is handed a tarball, never the Docker socket", () => {
  const argv = trivyRunArguments("/tmp/notted-trivy-abc", "image.tar");

  assert.equal(
    argv.some((argument) => argument.includes("docker.sock")),
    false,
    "the Docker socket must not be mounted into the scanner",
  );
  assert.ok(argv.includes("/tmp/notted-trivy-abc:/scan:ro"), "the tarball mount must be read-only");
  assert.ok(argv.includes("--input"), "the image must be scanned from the exported tarball");
  assert.ok(argv.includes("/scan/image.tar"));
  // The severity gate is what makes a non-zero exit mean something.
  assert.ok(argv.includes("--exit-code") && argv.includes("1"));
});

/*
 * The suppression list is the one place a container finding can be made to
 * disappear, so the scanner must actually be handed it — and read-only, for the
 * same reason the tarball mount is.
 */
test("the scan container is handed the ignore file, read-only", () => {
  const argv = trivyRunArguments("/tmp/notted-trivy-abc", "image.tar");

  assert.ok(argv.includes("--ignorefile"), "the accepted-advisory list must be passed to Trivy");
  assert.ok(argv.includes("/ignore.yaml"), "the ignore file must be the one this repository owns");
  assert.ok(
    argv.includes(`${IGNORE_FILE}:/ignore.yaml:ro`),
    "the ignore file must be mounted read-only",
  );
});

/*
 * Same rule as the `ignoreGhsas` test above, for the container half: an accepted
 * advisory names a numbered Plan part, or it is not accepted. Trivy adds one
 * property `pnpm audit` has no equivalent of — `expired_at` — which turns the
 * promise into something that enforces itself: past that date the finding comes
 * back on its own and `pnpm security:containers` fails again. A suppression that
 * has already expired in the committed file is therefore also a defect: it means
 * the deadline passed and nothing was re-triaged.
 *
 * A text predicate over the YAML rather than a parser, for the same reason
 * `imagesFromCompose` is one — same ceiling, same upgrade path. An empty list is
 * a pass: nothing suppressed is the goal state, not a broken test.
 */
test("every suppressed container advisory expires and names a Plan part", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const ignoreText = readFileSync(IGNORE_FILE, "utf8");
  const checklist = readFileSync(
    join(root, "docs", "security", "remediation-checklist.md"),
    "utf8",
  );
  const sections = checklist.split(/\n(?=#{2,3} )/u).filter((block) => /^### E\d+ /u.test(block));

  const entries = ignoreText
    .split(/\n {2}- id: /u)
    .slice(1)
    .map((block) => ({
      id: block.slice(0, block.indexOf("\n")).trim(),
      expiresAt: /\n {4}expired_at: (\S+)/u.exec(block)?.[1] ?? "",
    }));

  for (const { id, expiresAt } of entries) {
    assert.match(id, /^(?:CVE|GHSA)-[\w.-]+$/u, `${id} is not a vulnerability identifier`);
    assert.match(expiresAt, /^\d{4}-\d{2}-\d{2}$/u, `${id} has no expiry date`);
    assert.ok(
      new Date(`${expiresAt}T00:00:00Z`).getTime() > Date.now(),
      `${id} is suppressed with an expiry that has already passed (${expiresAt}); ` +
        "re-triage it rather than extending the date by reflex",
    );

    const owning = sections.filter((section) => section.includes(id));
    assert.ok(
      owning.length >= 1,
      `${id} is suppressed in .trivyignore.yaml but has no exception section in ` +
        "docs/security/remediation-checklist.md",
    );
    for (const section of owning) {
      const deadline = /\*\*Deadline:\*\*([\s\S]*?)\n- /u.exec(section)?.[1] ?? "";
      assert.match(
        deadline,
        /\*\*Part \d+\*\*/u,
        `${id}: exception "${section.slice(4, section.indexOf("\n"))}" has a deadline ` +
          `that names no Plan part (${deadline.trim().replace(/\s+/gu, " ")})`,
      );
    }
  }
});
