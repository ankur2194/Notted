export interface PlaywrightDiagnostics {
  readonly htmlReport: boolean;
  readonly trace: "off" | "retain-on-failure";
  readonly screenshot: "off" | "only-on-failure";
  readonly video: "off" | "retain-on-failure";
}

/** CI always keeps diagnostics; only an explicit local opt-in disables them. */
export function playwrightDiagnostics(
  environment: Readonly<Record<string, string | undefined>>,
): PlaywrightDiagnostics {
  const lightweight =
    environment.CI === undefined && environment.PLAYWRIGHT_LIGHTWEIGHT_MODE === "true";
  return {
    htmlReport: !lightweight,
    trace: lightweight ? "off" : "retain-on-failure",
    screenshot: lightweight ? "off" : "only-on-failure",
    video: lightweight ? "off" : "retain-on-failure",
  };
}
