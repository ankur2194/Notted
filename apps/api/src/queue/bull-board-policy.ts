import { DEAD_LETTER_QUEUE_NAME, PHYSICAL_QUEUE_NAMES } from "./queue-names";

export const BULL_BOARD_PATH = "/admin/queues" as const;

const QUEUES = Object.freeze([...Object.values(PHYSICAL_QUEUE_NAMES), DEAD_LETTER_QUEUE_NAME]);
const RETRY_QUEUES = Object.freeze([...Object.values(PHYSICAL_QUEUE_NAMES)]);
const QUEUE_PATTERN = QUEUES.join("|");
const RETRY_QUEUE_PATTERN = RETRY_QUEUES.join("|");
const JOB_ID_PATTERN = "[A-Za-z0-9_-]{1,128}";

export type BullBoardAuditAction = "queue.retry";

export interface BullBoardMutation {
  readonly action: BullBoardAuditAction;
  readonly queueName: string;
  readonly jobId?: string;
}

export type BullBoardRequestPolicy =
  { readonly kind: "read" } | { readonly kind: "mutation"; readonly audit: BullBoardMutation };

/** Exact allow-list for the intentionally exposed subset of Bull Board 6.14.2. */
export function bullBoardRequestPolicy(
  method: string,
  path: string,
): BullBoardRequestPolicy | null {
  if (method === "GET" || method === "HEAD") {
    if (safeReadPath(path)) return { kind: "read" };
    return null;
  }
  if (method !== "PUT") return null;

  const retryJob = match(
    path,
    `^/api/queues/(${RETRY_QUEUE_PATTERN})/(${JOB_ID_PATTERN})/retry/failed$`,
  );
  if (retryJob !== null) return mutation("queue.retry", retryJob[1], retryJob[2]);
  return null;
}

export function hasSafeBullBoardQuery(query: Readonly<Record<string, unknown>>): boolean {
  const keys = Object.keys(query);
  if (keys.some((key) => !["activeQueue", "jobsPerPage", "page", "status"].includes(key)))
    return false;
  if (query.activeQueue !== undefined && !isQueue(query.activeQueue)) return false;
  if (query.status !== undefined && !isStatus(query.status)) return false;
  if (query.jobsPerPage !== undefined && !boundedInteger(query.jobsPerPage, 1, 100)) return false;
  if (query.page !== undefined && !boundedInteger(query.page, 1, 10_000)) return false;
  return true;
}

function safeReadPath(path: string): boolean {
  if (path === "/" || path === "") return true;
  if (/^\/static\/[A-Za-z0-9_./-]+$/u.test(path) && !path.includes("..")) return true;
  if (path === "/api/queues") return true;
  return (
    new RegExp(`^/queue/(${QUEUE_PATTERN})(?:/(${JOB_ID_PATTERN}))?$`, "u").test(path) ||
    new RegExp(`^/api/queues/(${QUEUE_PATTERN})/(${JOB_ID_PATTERN})(?:/logs)?$`, "u").test(path)
  );
}

function match(path: string, pattern: string): RegExpMatchArray | null {
  return path.match(new RegExp(pattern, "u"));
}

function mutation(
  action: BullBoardAuditAction,
  queueName?: string,
  jobId?: string,
): BullBoardRequestPolicy | null {
  if (queueName === undefined) return null;
  return {
    kind: "mutation",
    audit: { action, queueName, ...(jobId === undefined ? {} : { jobId }) },
  };
}

function isQueue(value: unknown): value is string {
  return typeof value === "string" && QUEUES.includes(value as (typeof QUEUES)[number]);
}

function isStatus(value: unknown): boolean {
  return (
    typeof value === "string" &&
    ["active", "completed", "delayed", "failed", "latest", "prioritized", "waiting"].includes(value)
  );
}

function boundedInteger(value: unknown, minimum: number, maximum: number): boolean {
  if (typeof value !== "string" || !/^[0-9]{1,5}$/u.test(value)) return false;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum;
}
