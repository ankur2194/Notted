import assert from "node:assert/strict";
import test from "node:test";

import {
  assertLocalDockerEndpoint,
  assertResetEnvironment,
  findLegacyVolumes,
  parseEnvironment,
} from "./dev-tooling.mjs";

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

test("legacy volume detection is exact and never targets current volumes", () => {
  assert.deepEqual(
    findLegacyVolumes([
      "notted-dev_notted_postgres_dev_data",
      "notted-dev-f80448ec7cf5_postgres-data",
      "unrelated",
    ]),
    ["notted-dev_notted_postgres_dev_data"],
  );
});
