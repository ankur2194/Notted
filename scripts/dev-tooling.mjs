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

/**
 * The opt-in `e2e` Compose profile: a second application stack on its own
 * disposable database and MinIO buckets, so Playwright never writes to
 * `notted_dev`. These services only exist while the profile is enabled, which
 * is why they are classified separately from the development lists above.
 */
export const E2E_PROFILE = "e2e";

/** Long-running services added by the `e2e` profile. */
export const E2E_PERSISTENT_SERVICES = Object.freeze(["api-e2e", "web-e2e"]);

/** One-shot services added by the `e2e` profile. */
export const E2E_ONE_SHOT_SERVICES = Object.freeze([
  "db-reset-e2e",
  "redis-reset-e2e",
  "db-init-e2e",
  "minio-init-e2e",
]);

const E2E_SERVICES = Object.freeze([...E2E_ONE_SHOT_SERVICES, ...E2E_PERSISTENT_SERVICES]);

/** Shared dependencies required by the disposable stack, excluding dev-only applications. */
export const E2E_SUPPORTING_PERSISTENT_SERVICES = Object.freeze([
  "postgres",
  "redis",
  "meilisearch",
  "minio",
  "mailpit",
  "contracts",
]);

/** `deps` is shared; the dev database/minio initializers are intentionally not. */
export const E2E_SUPPORTING_ONE_SHOT_SERVICES = Object.freeze(["deps"]);

export function e2eReadinessServices() {
  return {
    oneShot: [...E2E_SUPPORTING_ONE_SHOT_SERVICES, ...E2E_ONE_SHOT_SERVICES],
    persistent: [...E2E_SUPPORTING_PERSISTENT_SERVICES, ...E2E_PERSISTENT_SERVICES],
  };
}

export function e2eUpServices() {
  return [...E2E_PERSISTENT_SERVICES];
}

const E2E_WEB_PORT = process.env.NOTTED_E2E_WEB_PORT ?? "3010";
const E2E_API_PORT = process.env.NOTTED_E2E_API_PORT ?? "3011";
const E2E_DATABASE = process.env.POSTGRES_E2E_DB ?? "notted_e2e_test";

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
    ...(options.profile === undefined ? [] : ["--profile", options.profile]),
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
export function evaluateComposeReadiness(
  processes,
  expected = { oneShot: ONE_SHOT_SERVICES, persistent: PERSISTENT_SERVICES },
) {
  const byService = new Map(processes.map((entry) => [entry.Service, entry]));
  const pending = [];

  for (const service of expected.oneShot) {
    const entry = byService.get(service);
    if (entry?.State === "exited" && Number(entry.ExitCode) !== 0) {
      throw new Error(`Development stack service "${service}" exited with code ${entry.ExitCode}.`);
    }
    if (entry?.State !== "exited" || Number(entry.ExitCode) !== 0) {
      pending.push(service);
    }
  }

  for (const service of expected.persistent) {
    const entry = byService.get(service);
    if (entry?.State !== "running" || entry.Health !== "healthy") {
      pending.push(service);
    }
  }

  return { ready: pending.length === 0, pending };
}

async function waitForStack(options, expected, readyMessage, timeoutMs = 900_000) {
  const deadline = Date.now() + timeoutMs;
  let pending = [];
  while (Date.now() < deadline) {
    const { stdout } = await run(
      "docker",
      [...composeArguments(options), "ps", "--all", "--format", "json"],
      { capture: true },
    );
    const verdict = evaluateComposeReadiness(parseComposeProcesses(stdout), expected);
    if (verdict.ready) {
      console.log(readyMessage);
      return;
    }
    pending = verdict.pending;
    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, 2_000);
    });
  }
  throw new Error(
    `Stack did not become ready within ${Math.round(timeoutMs / 1_000)} seconds. ` +
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

/**
 * Resolves the Playwright container image from the pinned `@playwright/test`
 * dependency. The browsers baked into the image must match the runner exactly,
 * so deriving the tag keeps them from drifting apart on an upgrade.
 */
export function playwrightImageTag(webPackageJson) {
  const version = webPackageJson?.devDependencies?.["@playwright/test"];
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error("apps/web must pin an exact @playwright/test version.");
  }
  return `mcr.microsoft.com/playwright:v${version}-noble`;
}

/**
 * Environment for a Playwright process that has joined `api-e2e`'s network
 * namespace.
 *
 * Inside that namespace `127.0.0.1` is the API container, so every dependency
 * that is *not* the application has to be addressed by Compose DNS. The
 * application itself is reachable on the same ports its public origins name,
 * because `web-e2e` listens on NOTTED_E2E_WEB_PORT rather than on 3000 — see
 * the comment on `web-e2e` in compose.yaml.
 */
export function playwrightEnvironment({
  webPort,
  apiPort,
  databaseName,
  postgresUser,
  postgresPassword,
  ci = false,
  lightweight = false,
}) {
  return {
    HOME: "/tmp",
    PLAYWRIGHT_DISPOSABLE_TEST_RUN: "true",
    // The disposable applications are already healthy. Omitting Playwright's
    // webServer lifecycle avoids rebuilding or starting dev applications for a
    // targeted run and keeps retries attached to the same isolated processes.
    PLAYWRIGHT_EXTERNAL_SERVERS: "true",
    PLAYWRIGHT_APP_URL: `http://localhost:${webPort}`,
    PLAYWRIGHT_API_URL: `http://localhost:${apiPort}`,
    PLAYWRIGHT_MAILPIT_URL: "http://mailpit:8025",
    DATABASE_URL: `postgres://${postgresUser}:${postgresPassword}@postgres:5432/${databaseName}`,
    ...(ci ? { CI: "true" } : {}),
    ...(lightweight ? { PLAYWRIGHT_LIGHTWEIGHT_MODE: "true" } : {}),
  };
}

/**
 * Environment names whose VALUE must never appear on a command line.
 *
 * `docker run --env KEY=VALUE` puts the value in the host process table, where
 * `ps auxww` shows it to every local user for the whole 7-13 minute run.
 * `DATABASE_URL` embeds `POSTGRES_PASSWORD`. Today that password is the
 * throwaway `notted_dev_password`, so the impact is nil — but this function is
 * the template a staging or CI runner copies, and the pattern travels.
 */
export const SECRET_ENVIRONMENT_KEYS = new Set(["DATABASE_URL"]);

/**
 * Flatten an environment map into `docker run` arguments, passing secret names
 * WITHOUT their values. `--env KEY` (no `=`) tells Docker to forward the value
 * from the parent process, which `run()` already inherits via `env: process.env`
 * — so the caller must set those on `process.env` first. See `e2eTest`.
 */
export function dockerEnvironmentArguments(environment) {
  return Object.entries(environment).flatMap(([key, value]) =>
    SECRET_ENVIRONMENT_KEYS.has(key) ? ["--env", key] : ["--env", `${key}=${value}`],
  );
}

/**
 * Build the argument list for `playwright test` inside the e2e container.
 *
 * Two behaviours, both there to stop a filter from doing more than it says:
 *
 * 1. Chromium is injected unless the caller named projects themselves. Keying
 *    this off "no arguments at all" instead would mean `e2e:test --grep x`
 *    silently *widened* the run to firefox and webkit, which are not part of
 *    the maintained baseline. A filter should narrow a run, never broaden it.
 * 2. A leading `--` is dropped. pnpm forwards `--` literally into `process.argv`
 *    rather than consuming it, so the habitual `pnpm e2e:test -- --grep x` would
 *    otherwise reach Playwright as an end-of-options marker and turn `--grep`
 *    and its value into positional path filters — running the whole suite while
 *    looking like it filtered.
 */
export function playwrightTestArguments(argumentsList) {
  const forwarded = argumentsList[0] === "--" ? argumentsList.slice(1) : argumentsList;
  const chose = forwarded.some((argument) => argument.startsWith("--project"));
  return chose ? forwarded : ["--project=chromium", ...forwarded];
}

function e2eComposeOptions(options = {}) {
  return { ...options, profile: E2E_PROFILE };
}

/**
 * Removes the profile's containers so the next `up` re-runs every one-shot.
 *
 * Compose restarts an exited one-shot rather than recreating it, and a reset
 * that only sometimes runs is not a reset. Removing the application containers
 * first also releases their connections before `DROP DATABASE`.
 */
async function removeE2eContainers(options) {
  await run("docker", [
    ...composeArguments(e2eComposeOptions(options)),
    "rm",
    "--stop",
    "--force",
    ...E2E_SERVICES,
  ]);
}

async function startE2eStack(options) {
  await removeE2eContainers(options);
  await run("docker", [
    ...composeArguments(e2eComposeOptions(options)),
    "up",
    "--detach",
    "--build",
    ...e2eUpServices(),
  ]);
  await waitForStack(
    e2eComposeOptions(options),
    e2eReadinessServices(),
    `End-to-end stack is ready on http://localhost:${E2E_WEB_PORT} with a freshly reset "${E2E_DATABASE}" database.`,
  );
}

/**
 * Runs Playwright inside the official container, joined to `api-e2e`'s network
 * namespace. Chromium cannot launch on this host, and the namespace is what
 * makes the container-internal origins identical to the browser-facing ones.
 */
async function runE2eTests(playwrightArguments) {
  const { stdout } = await run(
    "docker",
    [...composeArguments(e2eComposeOptions()), "ps", "--quiet", "api-e2e"],
    { capture: true },
  );
  const containerId = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1);
  if (containerId === undefined) {
    throw new Error("The `e2e` profile is not running. Start it with `pnpm e2e:up`.");
  }

  const webPackageJson = JSON.parse(
    await readFile(join(workspace, "apps", "web", "package.json"), "utf8"),
  );
  const environment = playwrightEnvironment({
    webPort: E2E_WEB_PORT,
    apiPort: E2E_API_PORT,
    databaseName: E2E_DATABASE,
    postgresUser: process.env.POSTGRES_USER ?? "notted",
    postgresPassword: process.env.POSTGRES_PASSWORD ?? "notted_dev_password",
    ci: process.env.CI !== undefined,
    lightweight: process.env.PLAYWRIGHT_LIGHTWEIGHT_MODE === "true",
  });

  // Secret values are handed to the child through the inherited environment,
  // never through argv. `dockerEnvironmentArguments` emits a bare `--env KEY`
  // for these, so the value has to be here for Docker to forward.
  for (const key of SECRET_ENVIRONMENT_KEYS) {
    if (environment[key] !== undefined) process.env[key] = environment[key];
  }

  await run("docker", [
    "run",
    "--rm",
    "--network",
    `container:${containerId}`,
    "--volume",
    `${workspace}:${workspace}`,
    "--workdir",
    join(workspace, "apps", "web"),
    "--user",
    `${process.getuid()}:${process.getgid()}`,
    ...dockerEnvironmentArguments(environment),
    playwrightImageTag(webPackageJson),
    "npx",
    "playwright",
    "test",
    ...playwrightTestArguments(playwrightArguments),
  ]);
}

export async function main() {
  const command = process.argv[2];
  if (command === "e2e:test") {
    // Everything after the command is forwarded to Playwright rather than parsed
    // here, so `pnpm e2e:test --grep "note"` works without teaching this parser
    // Playwright's whole option surface. See `playwrightTestArguments` for the
    // two normalisations applied on the way.
    await runE2eTests(process.argv.slice(3));
    return;
  }
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
      await waitForStack(
        options,
        { oneShot: ONE_SHOT_SERVICES, persistent: PERSISTENT_SERVICES },
        "Development stack is ready: dependencies installed, migrations applied, all services healthy.",
      );
      break;
    case "e2e:up":
      await startE2eStack(options);
      break;
    case "e2e:down":
      await removeE2eContainers(options);
      console.log("End-to-end stack removed; the development stack is untouched.");
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
