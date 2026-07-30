import { describe, expect, it, vi } from "vitest";

import { StructuredLogger } from "./structured-logger.service";

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
});
