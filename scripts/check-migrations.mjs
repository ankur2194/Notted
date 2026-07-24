import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirectories = new Set([
  ".git",
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "test-results",
]);
const migrationDirectoryNames = new Set(["drizzle", "migration", "migrations"]);
const drizzleConfigPattern = /^drizzle\.config\.(?:cjs|js|mjs|ts)$/u;
const drizzlePackages = new Set(["drizzle-kit", "drizzle-orm"]);
const findings = [];

async function inspectPackageManifest(filePath) {
  let manifest;

  try {
    manifest = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    const relativePath = path.relative(repositoryRoot, filePath);
    const message = error instanceof Error ? error.message : "unknown parse error";
    throw new Error(`Cannot inspect ${relativePath}: ${message}`);
  }

  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const dependencies = manifest[field];

    if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) {
      continue;
    }

    for (const packageName of drizzlePackages) {
      if (Object.hasOwn(dependencies, packageName)) {
        findings.push(`${path.relative(repositoryRoot, filePath)} declares ${packageName}`);
      }
    }
  }
}

async function inspectDirectory(directoryPath) {
  const entries = await readdir(directoryPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    const relativePath = path.relative(repositoryRoot, entryPath);

    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name)) {
        continue;
      }

      if (migrationDirectoryNames.has(entry.name.toLowerCase())) {
        findings.push(`${relativePath}/`);
        continue;
      }

      await inspectDirectory(entryPath);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (drizzleConfigPattern.test(entry.name)) {
      findings.push(relativePath);
    }

    if (entry.name === "package.json") {
      await inspectPackageManifest(entryPath);
    }
  }
}

await inspectDirectory(repositoryRoot);

if (findings.length > 0) {
  console.error(
    [
      "Migration consistency is not configured yet, but migration surfaces were detected:",
      ...findings.sort().map((finding) => `- ${finding}`),
      "Part 12 must replace scripts/check-migrations.mjs with real Drizzle migration consistency checks.",
    ].join("\n"),
  );
  process.exitCode = 1;
} else {
  console.log(
    "Migration sentinel passed: no Drizzle dependencies, configuration, or migration directories exist. Part 12 must replace this sentinel with real consistency checks.",
  );
}
