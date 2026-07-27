import { resolve } from "node:path";

import { loadEnvConfig } from "@next/env";

async function validateEnvironment(): Promise<void> {
  const argumentsSet = new Set(process.argv.slice(2).filter((value) => value !== "--"));
  const productionRequested = argumentsSet.delete("--production");

  if (argumentsSet.size > 0) {
    throw new Error("Unsupported public environment validation option");
  }

  const projectDirectory = resolve(__dirname, "..");
  const nodeEnvironment = productionRequested ? "production" : process.env.NODE_ENV;
  const developmentMode = nodeEnvironment === undefined || nodeEnvironment === "development";

  // Match Next.js precedence for .env*, including .env.local and the active
  // development/test/production variant. The loader reports filenames, not values.
  loadEnvConfig(projectDirectory, developmentMode);

  const { readPublicEnvironment } = await import("../src/config/public-environment");

  readPublicEnvironment(nodeEnvironment);
}

void validateEnvironment();
