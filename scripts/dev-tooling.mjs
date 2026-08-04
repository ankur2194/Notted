import { spawn } from "node:child_process";
import { access, copyFile, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = join(workspace, "compose.yaml");
const servicePortsFile = join(workspace, "docker", "compose.debug-ports.yml");
// Must match the top-level `name:` in compose.yaml so `docker compose up` and
// these wrappers always address the same project, containers, and volumes.
const PROJECT_NAME = "notted-dev";
const RESET_CONFIRMATION = "DELETE NOTTED DEV DATA";
const LEGACY_VOLUMES = Object.freeze([
  "notted-dev_notted_postgres_dev_data",
  "notted-dev_notted_redis_dev_data",
  "notted-dev_notted_meilisearch_dev_data",
  "notted-dev_notted_minio_dev_data",
]);

/** Long-running services that must report `running` and `healthy`. */
export const PERSISTENT_SERVICES = Object.freeze([
  "postgres",
  "redis",
  "meilisearch",
  "minio",
  "mailpit",
  "contracts",
  "api",
  "web",
]);

/** One-shot services that must have exited with code 0. */
export const ONE_SHOT_SERVICES = Object.freeze(["minio-init", "deps", "db-init"]);

function run(command, argumentsList, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, argumentsList, {
      cwd: workspace,
      env: process.env,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
      } else {
        rejectPromise(
          new Error(
            `${command} exited with code ${code}${options.capture ? `: ${stderr.trim()}` : ""}`,
          ),
        );
      }
    });
  });
}

export function parseCommandOptions(argumentsList) {
  const options = { withServicePorts: false };
  for (const argument of argumentsList) {
    if (argument === "--with-service-ports") {
      options.withServicePorts = true;
    } else {
      throw new Error(`Unknown developer command option: ${argument}`);
    }
  }
  return options;
}

function composeArguments(options = {}) {
  return [
    ...(options.context === undefined ? [] : ["--context", options.context]),
    "compose",
    "--file",
    composeFile,
    ...(options.withServicePorts === true ? ["--file", servicePortsFile] : []),
    "--project-name",
    PROJECT_NAME,
  ];
}

export function assertResetEnvironment(environment) {
  if (environment.NODE_ENV === "production") {
    throw new Error("Development reset refused while NODE_ENV=production.");
  }
  if (environment.COMPOSE_FILE !== undefined || environment.COMPOSE_PROJECT_NAME !== undefined) {
    throw new Error("Development reset refuses ambient Compose file/project overrides.");
  }
  if (environment.DOCKER_HOST !== undefined || environment.DOCKER_CONTEXT !== undefined) {
    throw new Error("Development reset refuses ambient Docker endpoint/context overrides.");
  }
}

export function assertLocalDockerEndpoint(endpoint) {
  if (!endpoint.startsWith("unix://") && !endpoint.startsWith("npipe://")) {
    throw new Error("Development reset requires a verified local Docker daemon.");
  }
}

export function assertResetTarget(targetProject, targetComposeFile) {
  if (targetProject !== PROJECT_NAME || !targetComposeFile.endsWith("compose.yaml")) {
    throw new Error("Development reset target verification failed.");
  }
}

export function findLegacyVolumes(volumeNames) {
  const available = new Set(volumeNames);
  return LEGACY_VOLUMES.filter((name) => available.has(name));
}

async function verifiedLocalDockerContext() {
  const { stdout: contextOutput } = await run("docker", ["context", "show"], {
    capture: true,
  });
  const context = contextOutput.trim();
  if (context === "") {
    throw new Error("Development reset could not resolve the active Docker context.");
  }
  const { stdout: endpointOutput } = await run(
    "docker",
    ["context", "inspect", context, "--format", "{{.Endpoints.docker.Host}}"],
    { capture: true },
  );
  assertLocalDockerEndpoint(endpointOutput.trim());
  return context;
}

async function warnAboutLegacyVolumes() {
  const { stdout } = await run("docker", ["volume", "ls", "--format", "{{.Name}}"], {
    capture: true,
  });
  const legacy = findLegacyVolumes(stdout.split(/\r?\n/u).filter(Boolean));
  if (legacy.length > 0) {
    console.warn(
      "Legacy Notted development volumes were detected and will not be attached or deleted. " +
        "Follow `docs/legacy-development-volumes.md` before resetting either stack.",
    );
  }
}

export function parseComposeProcesses(output) {
  const trimmed = output.trim();
  if (trimmed === "") {
    return [];
  }
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return trimmed.split(/\r?\n/u).map((line) => JSON.parse(line));
  }
}

/**
 * Decides whether the development stack is ready from one `compose ps` sample.
 *
 * A one-shot service that exited non-zero is terminal: the stack can never
 * become ready, so it throws immediately with the failing service named rather
 * than letting the caller wait out the whole timeout.
 */
export function evaluateComposeReadiness(processes) {
  const byService = new Map(processes.map((entry) => [entry.Service, entry]));
  const pending = [];

  for (const service of ONE_SHOT_SERVICES) {
    const entry = byService.get(service);
    if (entry?.State === "exited" && Number(entry.ExitCode) !== 0) {
      throw new Error(`Development stack service "${service}" exited with code ${entry.ExitCode}.`);
    }
    if (entry?.State !== "exited" || Number(entry.ExitCode) !== 0) {
      pending.push(service);
    }
  }

  for (const service of PERSISTENT_SERVICES) {
    const entry = byService.get(service);
    if (entry?.State !== "running" || entry.Health !== "healthy") {
      pending.push(service);
    }
  }

  return { ready: pending.length === 0, pending };
}

async function waitForStack(options, timeoutMs = 900_000) {
  const deadline = Date.now() + timeoutMs;
  let pending = [];
  while (Date.now() < deadline) {
    const { stdout } = await run(
      "docker",
      [...composeArguments(options), "ps", "--all", "--format", "json"],
      { capture: true },
    );
    const verdict = evaluateComposeReadiness(parseComposeProcesses(stdout));
    if (verdict.ready) {
      console.log(
        "Development stack is ready: dependencies installed, migrations applied, all services healthy.",
      );
      return;
    }
    pending = verdict.pending;
    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, 2_000);
    });
  }
  throw new Error(
    `Development stack did not become ready within ${Math.round(timeoutMs / 1_000)} seconds. ` +
      `Still waiting on: ${pending.join(", ")}. Inspect with \`pnpm infra:logs\`.`,
  );
}

const HOST_TOOLING_ENV_COPIES = Object.freeze([
  ["apps/api/.env.example", "apps/api/.env"],
  ["apps/web/.env.example", "apps/web/.env.local"],
]);

async function initializeEnvironment() {
  for (const [source, destination] of HOST_TOOLING_ENV_COPIES) {
    const target = join(workspace, destination);
    try {
      await access(target);
      console.log(`kept existing ${destination}`);
    } catch {
      await copyFile(join(workspace, source), target);
      console.log(`created ${destination}`);
    }
  }
  console.log(
    "These files are only used by host-side tooling (db:studio, test:ci, Playwright). " +
      "The Docker stack reads its configuration from compose.yaml and needs no environment file.",
  );
}

export function parseEnvironment(contents) {
  try {
    return parseEnv(contents);
  } catch {
    throw new Error("Environment file contains an invalid assignment.");
  }
}

async function readOptionalFile(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Cross-checks the host-side environment files against each other.
 *
 * The Docker stack is configured entirely by `compose.yaml`, so these files are
 * optional; when they are absent this reports that and succeeds instead of
 * blocking a container-only workflow.
 */
async function checkEnvironment() {
  const [apiContents, webContents] = await Promise.all([
    readOptionalFile(join(workspace, "apps", "api", ".env")),
    readOptionalFile(join(workspace, "apps", "web", ".env.local")),
  ]);

  if (apiContents === undefined || webContents === undefined) {
    console.log(
      "No host-side environment files found. The Docker stack does not need them; " +
        "run `pnpm env:init` before using host-side tooling such as `pnpm db:studio`.",
    );
    return;
  }

  const apiEnvironment = parseEnvironment(apiContents);
  const webEnvironment = parseEnvironment(webContents);
  const consistencyPairs = [
    ["NEXT_PUBLIC_APP_URL", apiEnvironment.APP_URL, webEnvironment.NEXT_PUBLIC_APP_URL],
    ["NEXT_PUBLIC_API_URL", apiEnvironment.API_URL, webEnvironment.NEXT_PUBLIC_API_URL],
    ["NEXT_PUBLIC_WS_URL", apiEnvironment.WS_URL, webEnvironment.NEXT_PUBLIC_WS_URL],
  ];
  for (const [key, apiValue, webValue] of consistencyPairs) {
    if (webValue !== apiValue) {
      throw new Error(
        `Environment mismatch: ${key} and its API counterpart must describe the same development origin.`,
      );
    }
  }
  await run("pnpm", ["--filter", "@notted/web", "env:validate"]);
  await run("pnpm", ["--filter", "@notted/api", "env:validate"]);
  console.log("Host-side environment files are present and mutually consistent.");
}

async function resetDevelopmentData() {
  assertResetEnvironment(process.env);
  const context = await verifiedLocalDockerContext();
  assertResetTarget(PROJECT_NAME, composeFile);
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const supplied = await prompt.question(
    `This deletes volumes for ${PROJECT_NAME}. Type ${RESET_CONFIRMATION}: `,
  );
  prompt.close();
  if (supplied !== RESET_CONFIRMATION) {
    throw new Error("Development reset cancelled: confirmation did not match.");
  }
  await run("docker", [...composeArguments({ context }), "down", "--volumes", "--remove-orphans"]);
}

export async function main() {
  const command = process.argv[2];
  const options = parseCommandOptions(process.argv.slice(3));
  switch (command) {
    case "env:init":
      await initializeEnvironment();
      break;
    case "env:check":
      await checkEnvironment();
      break;
    case "infra:up":
      await warnAboutLegacyVolumes();
      await run("docker", [...composeArguments(options), "up", "--detach", "--build"]);
      await waitForStack(options);
      break;
    case "infra:project":
      console.log(PROJECT_NAME);
      break;
    case "infra:down":
      await run("docker", [...composeArguments(options), "down", "--remove-orphans"]);
      break;
    case "infra:status":
      await run("docker", [...composeArguments(options), "ps", "--all"]);
      break;
    case "infra:logs":
      await run("docker", [...composeArguments(options), "logs", "--follow", "--tail", "100"]);
      break;
    case "infra:reset:dev":
      await resetDevelopmentData();
      break;
    case "db:seed":
      await run("docker", [
        ...composeArguments(options),
        "exec",
        "--workdir",
        "/workspace/apps/api",
        "api",
        "node",
        "--import",
        "tsx",
        "src/database/seed.ts",
      ]);
      break;
    default:
      throw new Error("Unknown developer command.");
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Developer command failed.");
    process.exitCode = 1;
  });
}
