import { defineConfig } from "drizzle-kit";

// Drizzle Kit configuration for the Notted API.
// `generate` works offline and only needs the schema path.
// `dbCredentials.url` is required by `push`, `migrate`, and `studio`, which read
// DATABASE_URL from the host environment. An empty-string default keeps `generate`
// from crashing when the variable is unset.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/database/schema/**.ts",
  out: "./src/database/migrations",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
  verbose: true,
  strict: true,
});
