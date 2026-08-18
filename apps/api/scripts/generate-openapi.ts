import "reflect-metadata";

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { buildOpenApiDocument } from "../src/openapi/openapi.builder";

// apps/api/scripts -> repository root.
const target = resolve(__dirname, "../../../docs/openapi.json");

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`, "utf8");

process.stdout.write(`Wrote ${target}\n`);
