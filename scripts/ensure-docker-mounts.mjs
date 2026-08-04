import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mountPoints = [
  "node_modules",
  "apps/api/node_modules",
  "apps/web/node_modules",
  "packages/shared-types/node_modules",
  "packages/shared-validators/node_modules",
  "apps/api/dist",
  "apps/web/.next",
  "packages/shared-types/dist",
  "packages/shared-validators/dist",
];
const placeholder = "# Required mount point for Docker Compose's writable development volume.\n";

await Promise.all(
  mountPoints.map(async (directory) => {
    const path = join(workspace, directory);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, ".docker-mount"), placeholder);
  }),
);
