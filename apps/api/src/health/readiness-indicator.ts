export const READINESS_INDICATORS = Symbol("READINESS_INDICATORS");

export interface ReadinessCheckResult {
  readonly name: string;
  readonly status: "disabled" | "down" | "up";
  readonly durationMs?: number;
  readonly message?: string;
}

export interface ReadinessIndicator {
  readonly name: string;
  check(): Promise<ReadinessCheckResult>;
}
