import { describe, expect, it, vi } from "vitest";

import { SENSITIVE_KEYS, StructuredLogger } from "./structured-logger.service";

import type { AppConfig } from "../../config/app.config";

describe("StructuredLogger auth redaction", () => {
  it("does not serialize token, URL, email or cookie values", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = new StructuredLogger({ nodeEnv: "test", logLevel: "info" } as AppConfig);
    logger.info(
      {
        token: "raw-token",
        actionUrl: "https://example.test/?token=raw-token",
        email: "person@example.test",
        cookie: "session-cookie",
        code: "one-time-value",
        backupCodes: "recovery-values",
        recoveryCodes: "one-time-recovery-values",
        totpURI: "authenticator-uri",
        credentialID: "credential-identifier",
        credentialId: "alternate-credential-identifier",
        publicKey: "public-key-material",
        clientSecret: "oauth-client-secret",
        accessToken: "oauth-access-token",
        refreshToken: "oauth-refresh-token",
        idToken: "oauth-id-token",
      },
      "Auth redaction probe",
    );
    const output = write.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(output).not.toContain("raw-token");
    expect(output).not.toContain("person@example.test");
    expect(output).not.toContain("session-cookie");
    expect(output).not.toContain("one-time-value");
    expect(output).not.toContain("recovery-values");
    expect(output).not.toContain("one-time-recovery-values");
    expect(output).not.toContain("authenticator-uri");
    expect(output).not.toContain("credential-identifier");
    expect(output).not.toContain("alternate-credential-identifier");
    expect(output).not.toContain("public-key-material");
    expect(output).not.toContain("oauth-client-secret");
    expect(output).not.toContain("oauth-access-token");
    expect(output).not.toContain("oauth-refresh-token");
    expect(output).not.toContain("oauth-id-token");
    write.mockRestore();
  });

  /**
   * Part 65. An API key travels as `Authorization: Bearer ntd_pk_...` and is a
   * live credential in plaintext — the one raw form of a key that exists after
   * creation. The `authorization` redaction path predates API keys, so this
   * pins that it covers them.
   */
  it("redacts a bearer API key carried on the authorization field", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = new StructuredLogger({ nodeEnv: "test", logLevel: "info" } as AppConfig);
    const secret = "ntd_pk_abcdefghijklmnopqrstuvwxyz012345";
    logger.info(
      { authorization: `Bearer ${secret}`, apiKeyId: "11111111-1111-4111-8111-111111111111" },
      "API key request",
    );
    const output = write.mock.calls.map(([chunk]) => String(chunk)).join("");

    expect(output).not.toContain(secret);
    expect(output).not.toContain("ntd_pk_");
    expect(output).toContain("[REDACTED]");
    // The non-sensitive correlation identifier still survives, so the entry
    // remains useful for tracing a key without exposing it.
    expect(output).toContain("11111111-1111-4111-8111-111111111111");
    write.mockRestore();
  });

  /**
   * Part 74. Pins the newer credential-shaped fields (both API-key spellings,
   * webhook and connection secrets, request signatures) and the nested
   * `err`/`res` shapes that HTTP client and Express logging libraries commonly
   * attach to a log record, where the sensitive material sits one level deep.
   */
  it("redacts API keys, secrets, signatures, and nested request/response objects", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = new StructuredLogger({ nodeEnv: "test", logLevel: "info" } as AppConfig);
    // `err`/`res` are nested objects, which `LogMetadata` deliberately forbids
    // (scalars only). The cast reproduces what an untyped caller — a pino
    // serializer or Nest's `LoggerService` overload — actually hands the logger.
    logger.info(
      {
        apiKey: "distinct-apiKey-value",
        api_key: "distinct-api_key-value",
        "x-api-key": "distinct-x-api-key-value",
        signature: "distinct-signature-value",
        "set-cookie": "distinct-set-cookie-value",
        privateKey: "distinct-privateKey-value",
        webhookSecret: "distinct-webhookSecret-value",
        secretKey: "distinct-secretKey-value",
        accessKey: "distinct-accessKey-value",
        connectionString: "distinct-connectionString-value",
        dsn: "distinct-dsn-value",
        err: { response: "distinct-err-response-value", config: "distinct-err-config-value" },
        res: { headers: "distinct-res-headers-value" },
      } as unknown as Parameters<StructuredLogger["info"]>[0],
      "Extended sensitive-field redaction probe",
    );
    const output = write.mock.calls.map(([chunk]) => String(chunk)).join("");

    for (const value of [
      "distinct-apiKey-value",
      "distinct-api_key-value",
      "distinct-x-api-key-value",
      "distinct-signature-value",
      "distinct-set-cookie-value",
      "distinct-privateKey-value",
      "distinct-webhookSecret-value",
      "distinct-secretKey-value",
      "distinct-accessKey-value",
      "distinct-connectionString-value",
      "distinct-dsn-value",
      "distinct-err-response-value",
      "distinct-err-config-value",
      "distinct-res-headers-value",
    ]) {
      expect(output).not.toContain(value);
    }
    write.mockRestore();
  });
});

/*
 * The nested spellings are DERIVED from `SENSITIVE_KEYS` rather than written
 * out a second time, and this is what proves the derivation reaches every key
 * in both positions. The two halves used to be two hand-written lists with
 * nothing comparing them, so a key added to one and forgotten in the other
 * would have been redacted at the top level and leaked one object deep.
 *
 * Driven off the exported list, so a 34th key is covered the day it is added,
 * including the two written in pino's bracket notation.
 */
describe("StructuredLogger redaction path derivation", () => {
  /** `'["x-api-key"]'` is a pino path; the property it addresses is `x-api-key`. */
  const propertyName = (key: string): string => (key.startsWith("[") ? key.slice(2, -2) : key);

  it.each(SENSITIVE_KEYS.map((key) => [key]))(
    "redacts %s at the top level and one object deep",
    (key) => {
      const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const property = propertyName(key);
      const logger = new StructuredLogger({ nodeEnv: "test", logLevel: "info" } as AppConfig);
      logger.info(
        {
          [property]: `bare-${property}-secret`,
          detail: { [property]: `nested-${property}-secret` },
        } as unknown as Parameters<StructuredLogger["info"]>[0],
        "Derived redaction probe",
      );
      const output = write.mock.calls.map(([chunk]) => String(chunk)).join("");
      write.mockRestore();

      expect(output).not.toContain(`bare-${property}-secret`);
      expect(output).not.toContain(`nested-${property}-secret`);
    },
  );
});

/**
 * Nest calls the `LoggerService` methods with whatever the framework or a
 * third-party module happens to pass — an Error, a number, a plain object — and
 * treats a trailing string argument as the context. None of that is validated
 * before it reaches us, so the coercion has to hold for every shape rather than
 * throwing inside the logger and losing the event.
 */
describe("StructuredLogger LoggerService surface", () => {
  function capture(run: (logger: StructuredLogger) => void): string {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      run(new StructuredLogger({ nodeEnv: "test", logLevel: "trace" } as AppConfig));
      return write.mock.calls.map(([chunk]) => String(chunk)).join("");
    } finally {
      write.mockRestore();
    }
  }

  it.each([
    ["log", 30],
    ["warn", 40],
    ["error", 50],
    ["debug", 20],
    ["verbose", 10],
    ["fatal", 60],
  ] as const)("emits %s at the matching pino level", (method, level) => {
    const output = capture((logger) => {
      logger[method]("Level probe");
    });

    expect(JSON.parse(output)).toMatchObject({
      level,
      msg: "Level probe",
      service: "notted-api",
      environment: "test",
    });
  });

  it("keeps a trailing string argument as the log context", () => {
    const output = capture((logger) => {
      logger.log("Nest bootstrap", "NestApplication");
    });

    expect(JSON.parse(output)).toMatchObject({ msg: "Nest bootstrap", context: "NestApplication" });
  });

  it("omits context when no trailing string argument is supplied", () => {
    const output = capture((logger) => {
      logger.log("No context", { detail: true });
    });

    expect(JSON.parse(output)).not.toHaveProperty("context");
  });

  it("omits context when called with no optional arguments at all", () => {
    const output = capture((logger) => {
      logger.log("Bare message");
    });

    expect(JSON.parse(output)).not.toHaveProperty("context");
  });

  it.each([
    [42, "42"],
    [true, "true"],
  ])("coerces the primitive message %s", (message, expected) => {
    const output = capture((logger) => {
      logger.log(message);
    });

    expect(JSON.parse(output).msg).toBe(expected);
  });

  /**
   * An Error is reduced to its name. The message and stack frequently carry
   * connection strings, signed URLs, or user content, and the redaction paths
   * cannot reach inside a free-text string.
   */
  it("reduces an Error message to its name", () => {
    const output = capture((logger) => {
      logger.error(new TypeError("postgres://user:hunter2@db.internal/app unreachable"));
    });

    const entry = JSON.parse(output);
    expect(entry.msg).toBe("TypeError");
    expect(output).not.toContain("hunter2");
  });

  it("falls back to a fixed label for a message that is neither primitive nor Error", () => {
    const output = capture((logger) => {
      logger.warn({ password: "hunter2" });
    });

    expect(JSON.parse(output).msg).toBe("Structured log event");
    expect(output).not.toContain("hunter2");
  });

  it("routes warning() to warn level with its metadata intact", () => {
    // The whole reason this method exists: calling the `LoggerService` `warn`
    // with a metadata object first silently dropped every field and logged the
    // literal "Structured log event" — see the case directly above.
    const output = capture((logger) => {
      logger.warning(
        { noteId: "note-1", reason: "tenant.workspace_mismatch" },
        "Projection failed",
      );
    });

    expect(JSON.parse(output)).toMatchObject({
      level: 40,
      msg: "Projection failed",
      noteId: "note-1",
      reason: "tenant.workspace_mismatch",
    });
  });

  it("routes failure() to error level with its metadata intact", () => {
    const output = capture((logger) => {
      logger.failure({ requestId: "request-1", attempt: 2 }, "Delivery failed");
    });

    expect(JSON.parse(output)).toMatchObject({
      level: 50,
      msg: "Delivery failed",
      requestId: "request-1",
      attempt: 2,
    });
  });
});
