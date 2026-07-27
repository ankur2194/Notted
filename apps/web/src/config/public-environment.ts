const PUBLIC_ENVIRONMENT_KEYS = [
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_API_URL",
  "NEXT_PUBLIC_WS_URL",
] as const;

type PublicEnvironmentKey = (typeof PUBLIC_ENVIRONMENT_KEYS)[number];

export type PublicEnvironmentInput = Readonly<
  Partial<Record<PublicEnvironmentKey, string | undefined>>
>;

export type PublicEnvironment = Readonly<Record<PublicEnvironmentKey, string>>;

type RuntimeEnvironment = "development" | "production" | "test";

const DEVELOPMENT_DEFAULTS: PublicEnvironment = Object.freeze({
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  NEXT_PUBLIC_API_URL: "http://localhost:3001",
  NEXT_PUBLIC_WS_URL: "ws://localhost:3001",
});

const ALLOWED_PROTOCOLS: Readonly<Record<PublicEnvironmentKey, readonly string[]>> = Object.freeze({
  NEXT_PUBLIC_APP_URL: Object.freeze(["http:", "https:"]),
  NEXT_PUBLIC_API_URL: Object.freeze(["http:", "https:"]),
  NEXT_PUBLIC_WS_URL: Object.freeze(["ws:", "wss:"]),
});

/**
 * Contains only environment variable names and requirements. Rejected values
 * are deliberately omitted so credentials accidentally supplied to a public
 * variable cannot be copied into build or CI logs.
 */
export class PublicEnvironmentValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid public environment configuration: ${issues.join("; ")}`);
    this.name = "PublicEnvironmentValidationError";
    this.issues = Object.freeze([...issues]);
  }
}

function resolveRuntimeEnvironment(value: string | undefined): RuntimeEnvironment {
  if (value === "production" || value === "test") {
    return value;
  }

  return "development";
}

function validateUrl(
  key: PublicEnvironmentKey,
  value: string,
  runtimeEnvironment: RuntimeEnvironment,
  issues: string[],
): void {
  if (value.length === 0 || value !== value.trim()) {
    issues.push(`${key} must be a non-empty absolute URL`);
    return;
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(value);
  } catch {
    issues.push(`${key} must be a valid absolute URL`);
    return;
  }

  if (!ALLOWED_PROTOCOLS[key].includes(parsedUrl.protocol)) {
    issues.push(`${key} must use ${ALLOWED_PROTOCOLS[key].join(" or ")}`);
  }
  if (parsedUrl.username !== "" || parsedUrl.password !== "") {
    issues.push(`${key} must not contain credentials`);
  }
  if (parsedUrl.pathname !== "/" || parsedUrl.search !== "" || parsedUrl.hash !== "") {
    issues.push(`${key} must be an origin without a path, query, or fragment`);
  }
  if (
    runtimeEnvironment === "production" &&
    ((key === "NEXT_PUBLIC_WS_URL" && parsedUrl.protocol !== "wss:") ||
      (key !== "NEXT_PUBLIC_WS_URL" && parsedUrl.protocol !== "https:"))
  ) {
    issues.push(`${key} must use a secure protocol in production`);
  }
}

/**
 * Parses the browser-visible environment allow-list.
 *
 * Development and test runs use loopback-only defaults when a variable is
 * absent. Production has no defaults: all three URLs must be supplied when the
 * web bundle is built because NEXT_PUBLIC_* values are embedded by Next.js at
 * build time. Extra properties are never copied into the returned object.
 */
export function parsePublicEnvironment(
  input: PublicEnvironmentInput,
  nodeEnvironment: string | undefined,
): PublicEnvironment {
  const runtimeEnvironment = resolveRuntimeEnvironment(nodeEnvironment);
  const values: Partial<Record<PublicEnvironmentKey, string>> = {};
  const issues: string[] = [];

  for (const key of PUBLIC_ENVIRONMENT_KEYS) {
    const suppliedValue = input[key];
    const value =
      suppliedValue ??
      (runtimeEnvironment === "production" ? undefined : DEVELOPMENT_DEFAULTS[key]);

    if (value === undefined) {
      issues.push(`${key} is required in production`);
      continue;
    }

    validateUrl(key, value, runtimeEnvironment, issues);
    values[key] = value;
  }

  if (issues.length > 0) {
    throw new PublicEnvironmentValidationError(issues);
  }

  return Object.freeze({
    NEXT_PUBLIC_APP_URL: values.NEXT_PUBLIC_APP_URL!,
    NEXT_PUBLIC_API_URL: values.NEXT_PUBLIC_API_URL!,
    NEXT_PUBLIC_WS_URL: values.NEXT_PUBLIC_WS_URL!,
  });
}

/**
 * Direct property reads are required here so Next.js can inline this public
 * allow-list. Do not replace them with dynamic process.env access.
 */
export function readPublicEnvironment(
  nodeEnvironment: string | undefined = process.env.NODE_ENV,
): PublicEnvironment {
  return parsePublicEnvironment(
    {
      NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
      NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
      NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL,
    },
    nodeEnvironment,
  );
}

export const publicEnvironment = readPublicEnvironment();
