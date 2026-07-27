import { resolve } from "node:path";

import {
  environmentForValidation,
  validateApiEnvironment,
} from "../src/config/validate-api-environment";

const argumentsSet = new Set(process.argv.slice(2).filter((value) => value !== "--"));
const production = argumentsSet.delete("--production");
if (argumentsSet.size > 0) {
  throw new Error("Unsupported API environment validation option");
}
if (!production) {
  process.loadEnvFile(resolve(__dirname, "../.env"));
}

validateApiEnvironment(environmentForValidation(process.env, production));
