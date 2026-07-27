import { describe, expect, it } from "vitest";

import { parseAppConfig } from "./app.config";

describe("parseAppConfig", () => {
  it("provides bounded development defaults", () => {
    const config = parseAppConfig({});

    expect(config).toMatchObject({
      nodeEnv: "development",
      apiHost: "127.0.0.1",
      apiPort: 3001,
      logLevel: "info",
      trustProxyHops: 0,
      requestBodyLimitBytes: 1_048_576,
      unauthenticatedRateLimitPerMinute: 60,
      authenticatedRateLimitPerMinute: 1_000,
      sensitiveRateLimitPerMinute: 10,
    });
    expect(config.appUrl.href).toBe("http://localhost:3000/");
    expect(config.apiUrl.href).toBe("http://localhost:3001/");
    expect(config.websocketUrl.href).toBe("ws://localhost:3001/");
  });

  it("parses every supported setting", () => {
    const config = parseAppConfig({
      NODE_ENV: "test",
      API_HOST: "0.0.0.0",
      API_PORT: "4321",
      APP_URL: "https://notted.example",
      API_URL: "https://api.notted.example",
      WS_URL: "wss://api.notted.example",
      LOG_LEVEL: "debug",
      TRUST_PROXY_HOPS: "2",
      REQUEST_BODY_LIMIT_BYTES: "2048",
      RATE_LIMIT_UNAUTHENTICATED_PER_MINUTE: "10",
      RATE_LIMIT_AUTHENTICATED_PER_MINUTE: "200",
      RATE_LIMIT_SENSITIVE_PER_MINUTE: "5",
    });

    expect(config.apiHost).toBe("0.0.0.0");
    expect(config.apiPort).toBe(4321);
    expect(config.appUrl.origin).toBe("https://notted.example");
    expect(config.apiUrl.origin).toBe("https://api.notted.example");
    expect(config.websocketUrl.origin).toBe("wss://api.notted.example");
    expect(config.logLevel).toBe("debug");
    expect(config.trustProxyHops).toBe(2);
    expect(config.requestBodyLimitBytes).toBe(2048);
    expect(config.unauthenticatedRateLimitPerMinute).toBe(10);
    expect(config.authenticatedRateLimitPerMinute).toBe(200);
    expect(config.sensitiveRateLimitPerMinute).toBe(5);
  });

  it.each([
    [{ NODE_ENV: "production" }, "API_HOST is required"],
    [{ NODE_ENV: "production", API_HOST: "0.0.0.0" }, "APP_URL is required"],
    [{ NODE_ENV: "preview" }, "NODE_ENV must be one of"],
    [{ API_HOST: "https://localhost" }, "API_HOST must be a valid"],
    [{ API_PORT: "0" }, "API_PORT must be an integer"],
    [{ TRUST_PROXY_HOPS: "-1" }, "TRUST_PROXY_HOPS must be an integer"],
    [{ APP_URL: "file:///tmp/notted" }, "APP_URL must use one of"],
    [{ APP_URL: "https://user:password@example.com" }, "must not contain credentials"],
    [{ APP_URL: "https://example.com/path" }, "must be an origin"],
    [{ API_URL: "https://example.com/api" }, "API_URL must be an origin"],
    [{ WS_URL: "https://example.com" }, "WS_URL must use one of"],
  ])("rejects invalid environment values", (environment, expectedMessage) => {
    expect(() => parseAppConfig(environment)).toThrowError(expectedMessage);
  });
});
