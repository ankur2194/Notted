export const READINESS_INDICATORS = Symbol("READINESS_INDICATORS");

export interface ReadinessCheckResult {
  readonly name: string;
  readonly status: "down" | "up";
  readonly message?: string;
}

export interface ReadinessIndicator {
  readonly name: string;
  check(): Promise<ReadinessCheckResult>;
}
