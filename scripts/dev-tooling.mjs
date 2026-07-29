import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = join(workspace, "docker", "docker-compose.dev.yml");
const composeEnvironment = join(workspace, "docker", ".env");
const RESET_CONFIRMATION = "DELETE NOTTED DEV DATA";
const LEGACY_VOLUMES = Object.freeze([
  "notted-dev_notted_postgres_dev_data",
  "notted-dev_notted_redis_dev_data",
  "notted-dev_notted_meilisearch_dev_data",
  "notted-dev_notted_minio_dev_data",
]);

async function projectName() {
  const canonical = await realpath(workspace);
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
  return `notted-dev-${hash}`;
}

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

async function composeArguments(context) {
  return [
    ...(context === undefined ? [] : ["--context", context]),
    "compose",
    "--env-file",
    composeEnvironment,
    "--file",
    composeFile,
    "--project-name",
    await projectName(),
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

async function ensureEnvironment() {
  try {
    await access(composeEnvironment);
  } catch {
    throw new Error("docker/.env is missing. Run `pnpm env:init` first.");
  }
}

function parseComposeProcesses(output) {
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

async function waitForInfrastructure(timeoutMs = 180_000) {
  const persistentServices = ["postgres", "redis", "meilisearch", "minio", "mailpit"];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { stdout } = await run(
      "docker",
      [...(await composeArguments()), "ps", "--all", "--format", "json"],
      { capture: true },
    );
    const processes = parseComposeProcesses(stdout);
    const byService = new Map(processes.map((entry) => [entry.Service, entry]));
    const initializer = byService.get("minio-init");
    if (initializer?.State === "exited" && Number(initializer.ExitCode) !== 0) {
      throw new Error("MinIO bucket initialization failed.");
    }
    const persistentReady = persistentServices.every((service) => {
      const entry = byService.get(service);
      return entry?.State === "running" && entry.Health === "healthy";
    });
    if (persistentReady && initializer?.State === "exited" && Number(initializer.ExitCode) === 0) {
      console.log("Development infrastructure is healthy; MinIO initialization exited 0.");
      return;
    }
    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, 1_000);
    });
  }
  throw new Error("Development infrastructure did not become ready within 180 seconds.");
}

async function initializeEnvironment() {
  const copies = [
    ["docker/.env.example", "docker/.env"],
    ["apps/api/.env.example", "apps/api/.env"],
    ["apps/web/.env.example", "apps/web/.env.local"],
  ];
  for (const [source, destination] of copies) {
    const target = join(workspace, destination);
    try {
      await access(target);
      console.log(`kept existing ${destination}`);
    } catch {
      await copyFile(join(workspace, source), target);
      console.log(`created ${destination}`);
    }
  }
}

export function parseEnvironment(contents) {
  try {
    return parseEnv(contents);
  } catch {
    throw new Error("Environment file contains an invalid assignment.");
  }
}

function decodeUrlComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error("API dependency URLs contain invalid percent encoding.");
  }
}

async function checkEnvironment() {
  const [dockerContents, apiContents, webContents] = await Promise.all([
    readFile(composeEnvironment, "utf8"),
    readFile(join(workspace, "apps", "api", ".env"), "utf8"),
    readFile(join(workspace, "apps", "web", ".env.local"), "utf8"),
  ]);
  const dockerEnvironment = parseEnvironment(dockerContents);
  const apiEnvironment = parseEnvironment(apiContents);
  const webEnvironment = parseEnvironment(webContents);
  let databaseUrl;
  let redisUrl;
  let meilisearchUrl;
  try {
    databaseUrl = new URL(apiEnvironment.DATABASE_URL ?? "invalid:");
    redisUrl = new URL(apiEnvironment.REDIS_URL ?? "invalid:");
    meilisearchUrl = new URL(apiEnvironment.MEILISEARCH_HOST ?? "invalid:");
  } catch {
    throw new Error("API dependency URLs must be valid before consistency can be checked.");
  }
  const consistencyPairs = [
    ["POSTGRES_USER", decodeUrlComponent(databaseUrl.username)],
    ["POSTGRES_PASSWORD", decodeUrlComponent(databaseUrl.password)],
    ["POSTGRES_DB", decodeUrlComponent(databaseUrl.pathname.slice(1))],
    ["POSTGRES_PORT", databaseUrl.port || "5432"],
    ["REDIS_PORT", redisUrl.port || "6379"],
    ["MEILISEARCH_PORT", meilisearchUrl.port || "7700"],
    ["MINIO_ROOT_USER", apiEnvironment.MINIO_ACCESS_KEY],
    ["MINIO_ROOT_PASSWORD", apiEnvironment.MINIO_SECRET_KEY],
    ["MINIO_BUCKET_ATTACHMENTS", apiEnvironment.MINIO_BUCKET_ATTACHMENTS],
    ["MINIO_BUCKET_EXPORTS", apiEnvironment.MINIO_BUCKET_EXPORTS],
    ["MINIO_API_PORT", apiEnvironment.MINIO_PORT],
    ["MEILI_MASTER_KEY", apiEnvironment.MEILISEARCH_API_KEY],
    ["MAILPIT_SMTP_PORT", apiEnvironment.EMAIL_SMTP_PORT],
    ["NEXT_PUBLIC_APP_URL", apiEnvironment.APP_URL, webEnvironment.NEXT_PUBLIC_APP_URL],
    ["NEXT_PUBLIC_API_URL", apiEnvironment.API_URL, webEnvironment.NEXT_PUBLIC_API_URL],
    ["NEXT_PUBLIC_WS_URL", apiEnvironment.WS_URL, webEnvironment.NEXT_PUBLIC_WS_URL],
  ];
  for (const [key, apiValue, explicitValue] of consistencyPairs) {
    const ownedValue = explicitValue ?? dockerEnvironment[key];
    if (ownedValue !== apiValue) {
      throw new Error(
        `Environment mismatch: ${key} and its API counterpart must describe the same development service.`,
      );
    }
  }
  await run("pnpm", ["--filter", "@notted/web", "env:validate"]);
  await run("pnpm", ["--filter", "@notted/api", "env:validate"]);
  console.log("Development environment files are present and mutually consistent.");
}

async function resetDevelopmentData() {
  await ensureEnvironment();
  assertResetEnvironment(process.env);
  const context = await verifiedLocalDockerContext();
  const expectedProject = await projectName();
  if (
    !expectedProject.startsWith("notted-dev-") ||
    !composeFile.endsWith("docker-compose.dev.yml")
  ) {
    throw new Error("Development reset target verification failed.");
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const supplied = await prompt.question(
    `This deletes volumes for ${expectedProject}. Type ${RESET_CONFIRMATION}: `,
  );
  prompt.close();
  if (supplied !== RESET_CONFIRMATION) {
    throw new Error("Development reset cancelled: confirmation did not match.");
  }
  await run("docker", [
    ...(await composeArguments(context)),
    "down",
    "--volumes",
    "--remove-orphans",
  ]);
}

export async function main() {
  const command = process.argv[2];
  switch (command) {
    case "env:init":
      await initializeEnvironment();
      break;
    case "env:check":
      await ensureEnvironment();
      await checkEnvironment();
      break;
    case "infra:up":
      await ensureEnvironment();
      await warnAboutLegacyVolumes();
      await run("docker", [...(await composeArguments()), "up", "--detach", "--build"]);
      await waitForInfrastructure();
      break;
    case "infra:project":
      console.log(await projectName());
      break;
    case "infra:down":
      await ensureEnvironment();
      await run("docker", [...(await composeArguments()), "down", "--remove-orphans"]);
      break;
    case "infra:status":
      await ensureEnvironment();
      await run("docker", [...(await composeArguments()), "ps", "--all"]);
      break;
    case "infra:logs":
      await ensureEnvironment();
      await run("docker", [...(await composeArguments()), "logs", "--follow", "--tail", "100"]);
      break;
    case "infra:reset:dev":
      await resetDevelopmentData();
      break;
    case "db:seed":
      await ensureEnvironment();
      await checkEnvironment();
      await run("pnpm", ["--filter", "@notted/api", "db:seed"]);
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
