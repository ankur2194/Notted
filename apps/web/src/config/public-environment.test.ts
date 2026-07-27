import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  parsePublicEnvironment,
  publicEnvironment,
  PublicEnvironmentValidationError,
  type PublicEnvironmentInput,
} from "./public-environment";

const VALID_ENVIRONMENT: Required<PublicEnvironmentInput> = {
  NEXT_PUBLIC_APP_URL: "https://notted.example.com",
  NEXT_PUBLIC_API_URL: "https://api.notted.example.com",
  NEXT_PUBLIC_WS_URL: "wss://api.notted.example.com",
};

const PUBLIC_KEYS = ["NEXT_PUBLIC_API_URL", "NEXT_PUBLIC_APP_URL", "NEXT_PUBLIC_WS_URL"] as const;

describe("parsePublicEnvironment", () => {
  it.each(["development", "test", undefined])(
    "uses loopback-only defaults in %s",
    (nodeEnvironment) => {
      expect(parsePublicEnvironment({}, nodeEnvironment)).toEqual({
        NEXT_PUBLIC_APP_URL: "http://localhost:3000",
        NEXT_PUBLIC_API_URL: "http://localhost:3001",
        NEXT_PUBLIC_WS_URL: "ws://localhost:3001",
      });
    },
  );

  it("accepts the secure production protocol variants", () => {
    expect(parsePublicEnvironment(VALID_ENVIRONMENT, "production")).toEqual(VALID_ENVIRONMENT);
  });

  it.each(PUBLIC_KEYS)("rejects a malformed %s URL", (key) => {
    expect(() =>
      parsePublicEnvironment(
        {
          ...VALID_ENVIRONMENT,
          [key]: "definitely not a URL",
        },
        "production",
      ),
    ).toThrow(`${key} must be a valid absolute URL`);
  });

  it.each([
    ["NEXT_PUBLIC_APP_URL", "ftp://notted.example.com", "http: or https:"],
    ["NEXT_PUBLIC_API_URL", "ws://api.notted.example.com", "http: or https:"],
    ["NEXT_PUBLIC_WS_URL", "https://api.notted.example.com", "ws: or wss:"],
  ] as const)("rejects a disallowed protocol for %s", (key, value, allowedProtocols) => {
    expect(() =>
      parsePublicEnvironment(
        {
          ...VALID_ENVIRONMENT,
          [key]: value,
        },
        "production",
      ),
    ).toThrow(`${key} must use ${allowedProtocols}`);
  });

  it.each(PUBLIC_KEYS)("requires %s in production", (missingKey) => {
    const input: PublicEnvironmentInput = {
      ...VALID_ENVIRONMENT,
      [missingKey]: undefined,
    };

    expect(() => parsePublicEnvironment(input, "production")).toThrow(
      `${missingKey} is required in production`,
    );
  });

  it.each([
    ["NEXT_PUBLIC_APP_URL", "http://notted.example.com"],
    ["NEXT_PUBLIC_API_URL", "http://api.notted.example.com"],
    ["NEXT_PUBLIC_WS_URL", "ws://api.notted.example.com"],
  ] as const)("requires a secure production %s", (key, value) => {
    expect(() =>
      parsePublicEnvironment({ ...VALID_ENVIRONMENT, [key]: value }, "production"),
    ).toThrow(`${key} must use a secure protocol in production`);
  });

  it.each([
    "https://user:password@notted.example.com",
    "https://notted.example.com/path?query=yes#fragment",
  ])("rejects a public URL that is not a credential-free origin", (value) => {
    expect(() =>
      parsePublicEnvironment({ ...VALID_ENVIRONMENT, NEXT_PUBLIC_APP_URL: value }, "production"),
    ).toThrow(PublicEnvironmentValidationError);
  });

  it("reports every missing production variable in one safe error", () => {
    expect.assertions(5);

    try {
      parsePublicEnvironment({}, "production");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(PublicEnvironmentValidationError);
      expect(error).toHaveProperty("issues", [
        "NEXT_PUBLIC_APP_URL is required in production",
        "NEXT_PUBLIC_API_URL is required in production",
        "NEXT_PUBLIC_WS_URL is required in production",
      ]);
      expect(String(error)).toContain("NEXT_PUBLIC_APP_URL");
      expect(String(error)).toContain("NEXT_PUBLIC_API_URL");
      expect(String(error)).toContain("NEXT_PUBLIC_WS_URL");
    }
  });

  it.each(PUBLIC_KEYS)("rejects an empty or whitespace-padded %s", (key) => {
    expect(() =>
      parsePublicEnvironment(
        {
          ...VALID_ENVIRONMENT,
          [key]: " ",
        },
        "development",
      ),
    ).toThrow(`${key} must be a non-empty absolute URL`);
  });

  it("copies only the public allow-list and never server secrets", () => {
    const input = {
      ...VALID_ENVIRONMENT,
      DATABASE_URL: "postgres://server-secret",
      BETTER_AUTH_SECRET: "server-secret",
    };

    expect(parsePublicEnvironment(input, "production")).toEqual(VALID_ENVIRONMENT);
    expect(Object.keys(parsePublicEnvironment(input, "production")).sort()).toEqual(PUBLIC_KEYS);
  });

  it("redacts rejected values from errors", () => {
    const rejectedValue = "server-secret-that-must-not-be-logged";

    expect(() =>
      parsePublicEnvironment(
        {
          ...VALID_ENVIRONMENT,
          NEXT_PUBLIC_API_URL: rejectedValue,
        },
        "production",
      ),
    ).toThrow(PublicEnvironmentValidationError);

    try {
      parsePublicEnvironment(
        {
          ...VALID_ENVIRONMENT,
          NEXT_PUBLIC_API_URL: rejectedValue,
        },
        "production",
      );
    } catch (error: unknown) {
      expect(String(error)).not.toContain(rejectedValue);
    }
  });

  it("returns a runtime-frozen, typed snapshot", () => {
    const parsedEnvironment = parsePublicEnvironment(VALID_ENVIRONMENT, "production");

    expect(Object.isFrozen(parsedEnvironment)).toBe(true);
    expect(() => {
      Object.assign(parsedEnvironment, {
        NEXT_PUBLIC_APP_URL: "https://changed.example.com",
      });
    }).toThrow(TypeError);
    expect(parsedEnvironment.NEXT_PUBLIC_APP_URL).toBe(VALID_ENVIRONMENT.NEXT_PUBLIC_APP_URL);
  });
});

describe("web public environment boundary", () => {
  it("initializes a frozen test snapshot without a React provider", () => {
    expect(Object.isFrozen(publicEnvironment)).toBe(true);
    expect(Object.keys(publicEnvironment).sort()).toEqual(PUBLIC_KEYS);
  });

  it("uses direct Next.js-replaceable reads and names no server secret", () => {
    const source = readFileSync(resolve(process.cwd(), "src/config/public-environment.ts"), "utf8");

    for (const key of PUBLIC_KEYS) {
      expect(source).toContain(`process.env.${key}`);
    }

    expect(source).not.toContain("process.env[");
    expect(source).not.toContain("DATABASE_URL");
    expect(source).not.toContain("BETTER_AUTH_SECRET");
    expect(source).not.toContain("createContext");
  });

  it("keeps the example file limited to the three public variables", () => {
    const lines = readFileSync(resolve(process.cwd(), ".env.example"), "utf8").trim().split("\n");

    expect(lines.map((line) => line.split("=")[0]).sort()).toEqual(PUBLIC_KEYS);
    expect(lines).toHaveLength(3);
  });

  it("wires Next env loading through exact direct tooling dependencies", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
    ) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const validationScript = readFileSync(
      resolve(process.cwd(), "scripts/validate-env.ts"),
      "utf8",
    );

    expect(packageJson.devDependencies["@next/env"]).toBe("16.2.11");
    expect(packageJson.devDependencies.tsx).toBe("4.23.1");
    expect(packageJson.scripts["env:validate"]).toBe("tsx scripts/validate-env.ts");
    expect(packageJson.scripts.build).toContain("env:validate --production");
    expect(validationScript).toContain('from "@next/env"');
    expect(validationScript).toContain("loadEnvConfig");
  });
});
