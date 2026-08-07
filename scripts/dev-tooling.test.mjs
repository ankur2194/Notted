import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  E2E_ONE_SHOT_SERVICES,
  E2E_PERSISTENT_SERVICES,
  ONE_SHOT_SERVICES,
  PERSISTENT_SERVICES,
  assertLocalDockerEndpoint,
  assertResetEnvironment,
  assertResetTarget,
  evaluateComposeReadiness,
  findLegacyVolumes,
  parseCommandOptions,
  parseComposeProcesses,
  parseEnvironment,
  playwrightEnvironment,
  playwrightImageTag,
  playwrightTestArguments,
} from "./dev-tooling.mjs";

/**
 * Reads the top-level service names straight out of `compose.yaml`.
 *
 * `services:` sits at column 0 and each service key is indented exactly two
 * spaces, so the block ends at the next column-0 key. This deliberately avoids
 * a YAML dependency for one assertion.
 */
function composeServiceNames() {
  const composeFile = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "compose.yaml");
  const lines = readFileSync(composeFile, "utf8").split(/\r?\n/u);
  const start = lines.indexOf("services:");
  assert.notEqual(start, -1, "compose.yaml must declare a top-level `services:` key");

  const names = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/u.test(line)) {
      break;
    }
    const match = /^ {2}([a-z][a-z\d-]*):\s*$/u.exec(line);
    if (match !== null) {
      names.push(match[1]);
    }
  }
  return names;
}

function readyStackProcesses() {
  return [
    ...ONE_SHOT_SERVICES.map((Service) => ({ Service, State: "exited", ExitCode: 0 })),
    ...PERSISTENT_SERVICES.map((Service) => ({
      Service,
      State: "running",
      Health: "healthy",
    })),
  ];
}

test("dotenv parsing handles quotes, comments, and escaped values", () => {
  const parsed = parseEnvironment(`
PLAIN=value
QUOTED="value with spaces # retained"
SINGLE='literal value'
COMMENTED=value # comment
`);

  assert.deepEqual(parsed, {
    PLAIN: "value",
    QUOTED: "value with spaces # retained",
    SINGLE: "literal value",
    COMMENTED: "value",
  });
});

test("development reset rejects production and ambient target overrides", () => {
  assert.throws(() => assertResetEnvironment({ NODE_ENV: "production" }), /NODE_ENV=production/u);
  assert.throws(
    () => assertResetEnvironment({ COMPOSE_PROJECT_NAME: "another-project" }),
    /Compose file\/project overrides/u,
  );
  assert.throws(
    () => assertResetEnvironment({ DOCKER_HOST: "ssh://remote.example" }),
    /Docker endpoint\/context overrides/u,
  );
  assert.throws(
    () => assertResetEnvironment({ DOCKER_CONTEXT: "remote" }),
    /Docker endpoint\/context overrides/u,
  );
  assert.doesNotThrow(() => assertResetEnvironment({ NODE_ENV: "development" }));
});

test("development reset accepts only local Docker endpoints", () => {
  assert.doesNotThrow(() => assertLocalDockerEndpoint("unix:///var/run/docker.sock"));
  assert.doesNotThrow(() => assertLocalDockerEndpoint("npipe:////./pipe/dockerDesktopLinuxEngine"));
  assert.throws(
    () => assertLocalDockerEndpoint("ssh://builder.example"),
    /verified local Docker daemon/u,
  );
  assert.throws(
    () => assertLocalDockerEndpoint("tcp://127.0.0.1:2375"),
    /verified local Docker daemon/u,
  );
});

test("development reset only ever targets the canonical project and compose file", () => {
  assert.doesNotThrow(() => assertResetTarget("notted-dev", "/home/dev/Notted/compose.yaml"));
  assert.throws(
    () => assertResetTarget("something-else", "/home/dev/Notted/compose.yaml"),
    /target verification failed/u,
  );
  assert.throws(
    () => assertResetTarget("notted-dev", "/home/dev/Notted/docker/compose.production.yml"),
    /target verification failed/u,
  );
});

test("legacy volume detection is exact and never targets current volumes", () => {
  assert.deepEqual(
    findLegacyVolumes([
      "notted-dev_notted_postgres_dev_data",
      "notted-dev_postgres-data",
      "unrelated",
    ]),
    ["notted-dev_notted_postgres_dev_data"],
  );
});

test("command options accept only the documented service-port flag", () => {
  assert.deepEqual(parseCommandOptions([]), { withServicePorts: false });
  assert.deepEqual(parseCommandOptions(["--with-service-ports"]), { withServicePorts: true });
  assert.throws(() => parseCommandOptions(["--publish-everything"]), /Unknown developer command/u);
});

test("compose process output parses both JSON array and JSON lines forms", () => {
  assert.deepEqual(parseComposeProcesses(""), []);
  assert.deepEqual(parseComposeProcesses('[{"Service":"api"}]'), [{ Service: "api" }]);
  assert.deepEqual(parseComposeProcesses('{"Service":"api"}\n{"Service":"web"}'), [
    { Service: "api" },
    { Service: "web" },
  ]);
});

test("stack readiness requires every one-shot to succeed and every service to be healthy", () => {
  assert.deepEqual(evaluateComposeReadiness(readyStackProcesses()), { ready: true, pending: [] });
  assert.deepEqual(evaluateComposeReadiness([]), {
    ready: false,
    pending: [...ONE_SHOT_SERVICES, ...PERSISTENT_SERVICES],
  });
});

test("stack readiness waits for a starting service instead of declaring success", () => {
  const processes = readyStackProcesses().map((entry) =>
    entry.Service === "api" ? { ...entry, Health: "starting" } : entry,
  );

  assert.deepEqual(evaluateComposeReadiness(processes), { ready: false, pending: ["api"] });
});

test("stack readiness fails fast and names a one-shot service that exited non-zero", () => {
  const processes = readyStackProcesses().map((entry) =>
    entry.Service === "db-init" ? { ...entry, ExitCode: 1 } : entry,
  );

  assert.throws(() => evaluateComposeReadiness(processes), /"db-init" exited with code 1/u);
});

test("the readiness service lists cover exactly the services compose.yaml declares", () => {
  const declared = composeServiceNames();
  const classified = [
    ...ONE_SHOT_SERVICES,
    ...PERSISTENT_SERVICES,
    ...E2E_ONE_SHOT_SERVICES,
    ...E2E_PERSISTENT_SERVICES,
  ];

  assert.deepEqual(
    declared.filter((name) => !classified.includes(name)),
    [],
    "every compose service must be classified, or `pnpm infra:up` reports ready while it is still starting",
  );
  assert.deepEqual(
    classified.filter((name) => !declared.includes(name)),
    [],
    "a classified service that compose.yaml no longer declares would block the readiness wait forever",
  );
  assert.deepEqual(
    classified.filter((name, index) => classified.indexOf(name) !== index),
    [],
    "a service must be classified as either one-shot or persistent, never both",
  );
});

test("the e2e profile is classified separately so `pnpm infra:up` never waits for it", () => {
  const development = [...ONE_SHOT_SERVICES, ...PERSISTENT_SERVICES];

  assert.deepEqual(
    [...E2E_ONE_SHOT_SERVICES, ...E2E_PERSISTENT_SERVICES].filter((name) =>
      development.includes(name),
    ),
    [],
    "an e2e service in a development list would make `pnpm infra:up` wait for a profile it never started",
  );
  assert.deepEqual(evaluateComposeReadiness(readyStackProcesses()), { ready: true, pending: [] });
});

test("readiness can be evaluated against an explicit service list", () => {
  assert.deepEqual(
    evaluateComposeReadiness(
      [
        { Service: "db-reset-e2e", State: "exited", ExitCode: 0 },
        { Service: "api-e2e", State: "running", Health: "healthy" },
      ],
      { oneShot: ["db-reset-e2e"], persistent: ["api-e2e"] },
    ),
    { ready: true, pending: [] },
  );
  assert.throws(
    () =>
      evaluateComposeReadiness([{ Service: "db-reset-e2e", State: "exited", ExitCode: 1 }], {
        oneShot: ["db-reset-e2e"],
        persistent: [],
      }),
    /"db-reset-e2e" exited with code 1/u,
  );
});

test("the Playwright image tag follows the pinned runner version", () => {
  assert.equal(
    playwrightImageTag({ devDependencies: { "@playwright/test": "1.62.0" } }),
    "mcr.microsoft.com/playwright:v1.62.0-noble",
  );
  assert.throws(
    () => playwrightImageTag({ devDependencies: { "@playwright/test": "^1.62.0" } }),
    /exact @playwright\/test version/u,
  );
});

test("Playwright inside the api-e2e namespace addresses dependencies by Compose DNS", () => {
  const environment = playwrightEnvironment({
    webPort: "3010",
    apiPort: "3011",
    databaseName: "notted_e2e_test",
    postgresUser: "notted",
    postgresPassword: "secret",
  });

  assert.equal(environment.PLAYWRIGHT_APP_URL, "http://localhost:3010");
  assert.equal(environment.PLAYWRIGHT_API_URL, "http://localhost:3011");
  // 127.0.0.1 is the API container in that namespace, so anything else must be
  // reached by service name.
  assert.equal(environment.PLAYWRIGHT_MAILPIT_URL, "http://mailpit:8025");
  assert.match(environment.DATABASE_URL, /@postgres:5432\/notted_e2e_test$/u);
  assert.equal(environment.PLAYWRIGHT_DISPOSABLE_TEST_RUN, "true");
});

test("a Playwright filter narrows the run without widening it to other browsers", () => {
  // No arguments: the maintained baseline.
  assert.deepEqual(playwrightTestArguments([]), ["--project=chromium"]);
  // A filter must not silently add firefox and webkit, which are not part of
  // that baseline. This is the regression the exported helper exists for.
  assert.deepEqual(playwrightTestArguments(["--grep", "note"]), [
    "--project=chromium",
    "--grep",
    "note",
  ]);
  // An explicit project choice wins, in either spelling.
  assert.deepEqual(playwrightTestArguments(["--project=firefox"]), ["--project=firefox"]);
  assert.deepEqual(playwrightTestArguments(["--project", "webkit"]), ["--project", "webkit"]);
});

test("a leading `--` is dropped, because pnpm forwards it instead of consuming it", () => {
  // `pnpm e2e:test -- --grep note` would otherwise reach Playwright with `--`
  // as an end-of-options marker, turning `--grep` and `note` into positional
  // path filters: the whole suite would run while appearing to be filtered.
  assert.deepEqual(playwrightTestArguments(["--", "--grep", "note"]), [
    "--project=chromium",
    "--grep",
    "note",
  ]);
  // Only a *leading* separator is meaningful; a later one is Playwright's.
  assert.deepEqual(playwrightTestArguments(["--grep", "--"]), [
    "--project=chromium",
    "--grep",
    "--",
  ]);
});
