import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
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
  const classified = [...ONE_SHOT_SERVICES, ...PERSISTENT_SERVICES];

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
