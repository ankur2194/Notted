// On-demand dependency/container vulnerability scanning. Not wired into CI —
// this project has no CI by design; run `pnpm security:check` yourself before
// a release. The production image scan proper is exception E4 in
// docs/security/remediation-checklist.md, deferred to Part 79 when production
// images exist (today compose.yaml only builds development images).
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = join(workspace, "compose.yaml");

// An unpinned scanner is itself a supply-chain risk: a floating tag can pull a
// different Trivy build (and vulnerability DB behaviour) on every run, which
// defeats the point of scanning. Bump this deliberately, not implicitly.
const TRIVY_IMAGE = "aquasec/trivy:0.68.0";

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

function scanImage(image) {
  return spawnCode("docker", [
    "run",
    "--rm",
    "--volume",
    "/var/run/docker.sock:/var/run/docker.sock:ro",
    "--volume",
    `${process.env.HOME}/.cache/trivy:/root/.cache/trivy`,
    TRIVY_IMAGE,
    "image",
    "--severity",
    "HIGH,CRITICAL",
    "--ignore-unfixed",
    "--exit-code",
    "1",
    image,
  ]);
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
