// On-demand dependency/container vulnerability scanning. Not wired into CI —
// this project has no CI by design; run `pnpm security:check` yourself before
// a release. The production image scan proper is exception E4 in
// docs/security/remediation-checklist.md, deferred to Part 79 when production
// images exist (today compose.yaml only builds development images).
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = join(workspace, "compose.yaml");

// An unpinned scanner is itself a supply-chain risk: a floating tag can pull a
// different Trivy build (and vulnerability DB behaviour) on every run, which
// defeats the point of scanning. Bump this deliberately, not implicitly.
//
// BY DIGEST, like every image in compose.yaml. This was the one image reference
// in the repository pinned by tag, and `security-scan.test.mjs` could not see it
// to enforce the rule, because the rule is asserted over compose.yaml and this
// lives in a `.mjs`.
//
// The tag it carried, `aquasec/trivy:0.68.0`, WAS NEVER PUBLISHED — upstream
// went 0.67 to 0.69. Every `docker run` therefore failed with "not found",
// which this script counted as a non-zero scan and reported as
// "Trivy reported HIGH/CRITICAL fixable vulnerabilities in N of N images": a
// scanner that has never once run, reporting findings. The digest below is
// 0.74.0, resolved from `docker image inspect`.
export const TRIVY_IMAGE =
  "aquasec/trivy@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969";

/**
 * The `docker run` argv for one scan. Exported so a test can assert what this
 * command is and is not handed.
 *
 * NO DOCKER SOCKET. `--volume /var/run/docker.sock:...:ro` was mounted so Trivy
 * could pull the image out of the daemon, and `:ro` on a unix socket restricts
 * writing the socket FILE, not the API behind it — a container holding it can
 * start privileged containers and delete images and volumes belonging to every
 * other project on this shared daemon. The image is exported to a tarball first
 * and the tarball is mounted read-only instead, so the scanner gets exactly the
 * bytes it is scanning and nothing else.
 *
 * ponytail: a tarball, not the `docker save <image> | trivy image --input -`
 * pipe the finding suggests — Trivy's `--input` takes a file path and rejects
 * `-` ("unable to open - as a Docker image"). The tar is written to a temporary
 * directory and removed in a `finally`. Revisit if Trivy ever reads stdin.
 */
export function trivyRunArguments(tarballDirectory, tarballName) {
  return [
    "run",
    "--rm",
    "--volume",
    `${tarballDirectory}:/scan:ro`,
    "--volume",
    `${process.env.HOME}/.cache/trivy:/root/.cache/trivy`,
    TRIVY_IMAGE,
    "image",
    "--input",
    `/scan/${tarballName}`,
    "--severity",
    "HIGH,CRITICAL",
    "--ignore-unfixed",
    "--exit-code",
    "1",
  ];
}

function spawnCode(command, argumentsList, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, argumentsList, {
      cwd: workspace,
      env: process.env,
      stdio: options.quiet === true ? "ignore" : "inherit",
      shell: false,
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => resolvePromise(code ?? 1));
  });
}

/**
 * Extracts the concrete image references from compose.yaml's `image:` lines.
 *
 * ponytail: a regex over `image:` lines, not a YAML parser — compose.yaml
 * today only ever declares `image:` as a flat top-level service key, plainly
 * or with a `&anchor`/`*alias`. If it grows nested image declarations (inside
 * a list, a merge key, a second document) this stops being enough; reach for
 * a real YAML parser then instead of patching the regex further.
 */
export function imagesFromCompose(composeText) {
  const images = new Set();
  for (const rawLine of composeText.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const match = /^image:\s*(.+)$/u.exec(line);
    if (match === null) {
      continue;
    }
    const value = match[1].trim();
    if (value.startsWith("*")) {
      // Alias: the anchor definition's own `image:` line already added this
      // reference, so counting the alias too would just be a duplicate.
      continue;
    }
    const anchorMatch = /^&\S+\s+(.+)$/u.exec(value);
    images.add(anchorMatch === null ? value : anchorMatch[1].trim());
  }
  return [...images].sort();
}

async function imageExistsLocally(image) {
  const code = await spawnCode("docker", ["image", "inspect", image], { quiet: true });
  return code === 0;
}

const TARBALL_NAME = "image.tar";

async function scanImage(image) {
  const directory = await mkdtemp(join(tmpdir(), "notted-trivy-"));
  try {
    const saved = await spawnCode("docker", [
      "save",
      "--output",
      join(directory, TARBALL_NAME),
      image,
    ]);
    if (saved !== 0) {
      console.error(`docker save failed for ${image}; nothing was scanned.`);
      return saved;
    }
    return await spawnCode("docker", trivyRunArguments(directory, TARBALL_NAME));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function scanContainers() {
  const composeText = await readFile(composeFile, "utf8");
  const images = imagesFromCompose(composeText);
  let scanned = 0;
  let failing = 0;

  for (const image of images) {
    if (!(await imageExistsLocally(image))) {
      console.log(
        `skip ${image}: not present locally. Build it (\`pnpm infra:up\`) or pull it ` +
          `(\`docker pull ${image}\`), then re-run \`pnpm security:containers\`.`,
      );
      continue;
    }
    console.log(`scanning ${image} with Trivy...`);
    scanned += 1;
    const code = await scanImage(image);
    if (code !== 0) {
      failing += 1;
    }
  }

  if (scanned === 0) {
    // Exiting 0 here is correct — no image was scanned, so none can have
    // failed — but that must never be mistaken for a clean scan.
    console.log(
      `Nothing scanned: none of the ${images.length} image(s) declared in compose.yaml ` +
        "are present locally. This is not a pass; build or pull them and re-run.",
    );
    return;
  }

  if (failing > 0) {
    throw new Error(
      `Trivy reported HIGH/CRITICAL fixable vulnerabilities in ${failing} of ${scanned} scanned image(s).`,
    );
  }
  console.log(`Scanned ${scanned} image(s); no HIGH/CRITICAL fixable vulnerabilities found.`);
}

export async function main() {
  const command = process.argv[2];
  switch (command) {
    case "containers":
      await scanContainers();
      break;
    default:
      console.error("Usage: node scripts/security-scan.mjs containers");
      process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Security scan failed.");
    process.exitCode = 1;
  });
}
