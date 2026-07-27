import { isIP } from "node:net";

export type Environment = Readonly<Record<string, string | undefined>>;

const INTEGER_PATTERN = /^\d+$/u;
const HOSTNAME_PATTERN =
  /^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)*[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/iu;

export function readBoolean(environment: Environment, key: string, fallback: boolean): boolean {
  const rawValue = environment[key];
  if (rawValue === undefined) {
    return fallback;
  }

  if (rawValue === "true") {
    return true;
  }
  if (rawValue === "false") {
    return false;
  }

  throw new Error(`${key} must be either true or false`);
}

export function readEnum<const T extends readonly string[]>(
  environment: Environment,
  key: string,
  allowed: T,
  fallback: T[number],
): T[number] {
  const value = environment[key] ?? fallback;
  if (!allowed.includes(value)) {
    throw new Error(`${key} must be one of: ${allowed.join(", ")}`);
  }

  return value as T[number];
}

export function readHost(
  environment: Environment,
  key: string,
  fallback: string | undefined,
): string {
  const value = readString(environment, key, fallback).trim();
  if (value === "" || value.length > 253 || (isIP(value) === 0 && !HOSTNAME_PATTERN.test(value))) {
    throw new Error(`${key} must be a valid IP address or hostname`);
  }

  return value;
}

export function readInteger(
  environment: Environment,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const rawValue = environment[key];
  if (rawValue === undefined) {
    return fallback;
  }

  if (!INTEGER_PATTERN.test(rawValue)) {
    throw new Error(`${key} must be an integer between ${minimum} and ${maximum}`);
  }

  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${key} must be an integer between ${minimum} and ${maximum}`);
  }

  return value;
}

export function readOptionalString(environment: Environment, key: string): string | undefined {
  const value = environment[key]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

export function readSecret(
  environment: Environment,
  key: string,
  options: {
    readonly fallback?: string;
    readonly minimumLength: number;
    readonly required: boolean;
  },
): string | undefined {
  const value = readOptionalString(environment, key) ?? options.fallback;
  if (value === undefined) {
    if (options.required) {
      throw new Error(`${key} is required`);
    }
    return undefined;
  }

  if (Buffer.byteLength(value, "utf8") < options.minimumLength) {
    throw new Error(`${key} must be at least ${options.minimumLength} bytes`);
  }

  return value;
}

export function readString(
  environment: Environment,
  key: string,
  fallback: string | undefined,
): string {
  const value = readOptionalString(environment, key) ?? fallback;
  if (value === undefined) {
    throw new Error(`${key} is required`);
  }
  return value;
}

export function readUrl(
  environment: Environment,
  key: string,
  options: {
    readonly allowedProtocols: readonly string[];
    readonly fallback?: string;
    readonly originOnly?: boolean;
    readonly required?: boolean;
  },
): URL {
  const rawValue = readOptionalString(environment, key) ?? options.fallback;
  if (rawValue === undefined) {
    if (options.required === true) {
      throw new Error(`${key} is required`);
    }
    throw new Error(`${key} has no configured value`);
  }

  let url: URL;
  try {
    url = new URL(rawValue);
  } catch {
    throw new Error(`${key} must be a valid absolute URL`);
  }

  if (!options.allowedProtocols.includes(url.protocol)) {
    throw new Error(`${key} must use one of: ${options.allowedProtocols.join(", ")}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`${key} must not contain credentials`);
  }
  if (
    options.originOnly === true &&
    (url.pathname !== "/" || url.search !== "" || url.hash !== "")
  ) {
    throw new Error(`${key} must be an origin without a path, query, or fragment`);
  }

  return url;
}

export function wrapConfigError(prefix: string, error: unknown): never {
  const message = error instanceof Error ? error.message : "unknown validation error";
  throw new Error(`${prefix}: ${message}`);
}
