import { describe, expect, it, vi } from "vitest";

import { AuthorizationDeniedError } from "../authorization/authorization.errors";
import { emailDeliveries, jobOutbox } from "../database/schema";
import { WorkspaceEmailProducerService } from "../email/workspace-email-producer.service";
import { DOMAIN_JOB_TYPES } from "../queue/job-identifiers";
import { MENTION_NOTIFY_JOB_DEFINITION } from "../queue/job-registry";
import { TenantContextService } from "../tenant";

import { MentionNotificationWorkerService } from "./mention-notification.worker.service";

import type { NotificationService } from "./notification.service";
import type { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import type { DatabaseService, DatabaseTransaction } from "../database/database.service";
import type { QueueHandlerRegistry } from "../queue/queue-handler-registry.service";

const WORKSPACE_ID = "11111111-0000-4000-8000-000000000001";
const NOTE_ID = "22222222-0000-4000-8000-000000000002";
const ACTOR_ID = "33333333-0000-4000-8000-000000000003";
const RECIPIENT_ID = "55555555-0000-4000-8000-000000000005";
const INTENT_ID = "88888888-0000-4000-8000-000000000008";
const CORRELATION_ID = "44444444-0000-4000-8000-000000000004";

const RECIPIENT_EMAIL = "recipient@example.test";

interface InsertedRow {
  readonly table: unknown;
  readonly values: Record<string, unknown>;
}

interface Harness {
  readonly worker: MentionNotificationWorkerService;
  readonly inserts: InsertedRow[];
  readonly emit: ReturnType<typeof vi.fn>;
  readonly authorizeUserJob: ReturnType<typeof vi.fn>;
  /** Insert tables in the order they were written, for ordering assertions. */
  readonly order: string[];
}

const outboxRows = (harness: Harness, action: string): readonly InsertedRow[] =>
  harness.inserts.filter(
    (row) =>
      row.table === jobOutbox &&
      (row.values.payload as { readonly action?: string }).action === action,
  );

const emailIntents = (harness: Harness): readonly InsertedRow[] =>
  outboxRows(harness, DOMAIN_JOB_TYPES.deliverWorkspaceEmail);
const deliveryRows = (harness: Harness): readonly InsertedRow[] =>
  harness.inserts.filter((row) => row.table === emailDeliveries);

interface HarnessOptions {
  /** Rejects `authorizeUserJob` with `AuthorizationDeniedError` when false. */
  readonly authorized?: boolean;
  /** The recipient muted this template, so `queue` writes a `suppressed` row. */
  readonly suppressed?: boolean;
  /** `notifications.emit` rejects, to pin the write ordering. */
  readonly emitFails?: boolean;
  readonly noteDeleted?: boolean;
}

/**
 * Records every insert and answers the worker's two reads from fixtures. No
 * database: the worker touches nothing else on the handle it is given.
 */
function harnessFor(options: HarnessOptions = {}): Harness {
  const { authorized = true, suppressed = false, emitFails = false, noteDeleted = false } = options;
  const inserts: InsertedRow[] = [];
  const order: string[] = [];

  const recordingTx = {
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table, values });
        order.push(table === emailDeliveries ? "delivery" : "outbox");
        return {
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve([{ id: values.id }]),
            then: (resolve: (value: unknown) => unknown) => resolve(undefined),
          }),
          then: (resolve: (value: unknown) => unknown) => resolve(undefined),
        };
      },
    }),
    // The suppression probe is the only select `queue` issues.
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(suppressed ? [{ id: "sentinel" }] : []) }),
      }),
    }),
  } as unknown as DatabaseTransaction;

  // The worker reads notes first, then users. Both go through `database.db`.
  let readCount = 0;
  const db = {
    select: () => ({
      from: () => {
        readCount += 1;
        const notesRead = readCount === 1;
        const rows = notesRead
          ? [{ title: "Quarterly plan", isDeleted: noteDeleted }]
          : [{ id: RECIPIENT_ID, name: "Recipient", email: RECIPIENT_EMAIL }];
        return {
          where: () => ({
            limit: () => Promise.resolve(rows),
            then: (resolve: (value: unknown) => unknown) => resolve(rows),
          }),
        };
      },
    }),
  };

  const tenant = new TenantContextService();
  const database = {
    db,
    transaction: (work: (tx: DatabaseTransaction) => Promise<unknown>) => work(recordingTx),
  } as unknown as DatabaseService;

  const emit = vi.fn(() =>
    emitFails ? Promise.reject(new Error("notification insert failed")) : Promise.resolve(),
  );
  const authorizeUserJob = vi.fn(() =>
    authorized
      ? Promise.resolve({})
      : Promise.reject(
          new AuthorizationDeniedError({
            allowed: false,
            // Concealed, not forbidden: a note the recipient cannot read must
            // not be confirmed to exist.
            code: "authorization.concealed",
            httpStatus: 404,
            safeMessage: "The requested resource was not found.",
            audit: {} as never,
          }),
        ),
  );

  const worker = new MentionNotificationWorkerService(
    database,
    { emit } as unknown as NotificationService,
    tenant,
    { register: () => () => undefined } as unknown as QueueHandlerRegistry,
    { authorizeUserJob } as unknown as AuthorizationEntryService,
    new WorkspaceEmailProducerService(tenant),
  );

  return { worker, inserts, emit, authorizeUserJob, order };
}

function contextFor(): Parameters<MentionNotificationWorkerService["handle"]>[0] {
  return {
    outboxIntentId: INTENT_ID,
    jobType: MENTION_NOTIFY_JOB_DEFINITION.jobType,
    idempotencyKey: `mention-notify:${WORKSPACE_ID}:${NOTE_ID}:${RECIPIENT_ID}`,
    correlationId: CORRELATION_ID,
    payload: {
      action: DOMAIN_JOB_TYPES.mentionNotify,
      intentId: INTENT_ID,
      workspaceId: WORKSPACE_ID,
      noteId: NOTE_ID,
      recipientId: RECIPIENT_ID,
      actorId: ACTOR_ID,
    },
    signal: new AbortController().signal,
    attempt: 1,
    maximumAttempts: 3,
  } as unknown as Parameters<MentionNotificationWorkerService["handle"]>[0];
}

describe("MentionNotificationWorkerService", () => {
  /*
   * THE DEFECT THIS FILE EXISTS FOR.
   *
   * The mention email used to be queued by `MentionNotificationProducer`, which
   * runs inside `NotesService.update`'s transaction and can only see workspace
   * membership. For a note in a restricted project that is not what `note.read`
   * means: a member with no project grant was correctly denied the in-app
   * notification here, and received an email carrying the note's title and a
   * deep link anyway — into a mailbox, where it cannot be recalled.
   */
  it("queues no email when the recipient cannot read the note", async () => {
    const harness = harnessFor({ authorized: false });
    await expect(harness.worker.handle(contextFor())).resolves.toBeUndefined();

    expect(harness.authorizeUserJob).toHaveBeenCalledWith(
      expect.objectContaining({ userId: RECIPIENT_ID, action: "note.read" }),
    );
    expect(emailIntents(harness)).toHaveLength(0);
    // Not even a `suppressed` row: a denial must leave no trace naming the note.
    expect(deliveryRows(harness)).toHaveLength(0);
    expect(harness.emit).not.toHaveBeenCalled();
  });

  it("queues exactly one email intent for a recipient who can read the note", async () => {
    const harness = harnessFor();
    await harness.worker.handle(contextFor());

    expect(emailIntents(harness)).toHaveLength(1);
    expect(deliveryRows(harness)).toHaveLength(1);

    const delivery = deliveryRows(harness)[0]!.values;
    expect(delivery.templateKey).toBe("mention");
    expect(delivery.status).toBe("queued");
    expect(delivery.workspaceId).toBe(WORKSPACE_ID);
    expect(delivery.recipient).toBe(RECIPIENT_EMAIL);
    expect(delivery.relatedEntityType).toBe("note");
    expect(delivery.relatedEntityId).toBe(NOTE_ID);

    // Identifiers only: no recipient address and no note content in Redis.
    const payload = emailIntents(harness)[0]!.values.payload as Record<string, unknown>;
    expect(payload.actorId).toBe(ACTOR_ID);
    expect(payload.deliveryId).toBe(delivery.id);
    expect(payload).not.toHaveProperty("recipient");

    expect(harness.emit).toHaveBeenCalledTimes(1);
  });

  it("still emits the in-app notification when the recipient muted mention email", async () => {
    const harness = harnessFor({ suppressed: true });
    await harness.worker.handle(contextFor());

    // No outbox intent means nothing can ever send it; the `suppressed` delivery
    // row is the durable record that it was withheld on purpose.
    expect(emailIntents(harness)).toHaveLength(0);
    expect(deliveryRows(harness)).toHaveLength(1);
    expect(deliveryRows(harness)[0]!.values.status).toBe("suppressed");
    expect(harness.emit).toHaveBeenCalledTimes(1);
  });

  it("queues no email for a note deleted between the save and delivery", async () => {
    const harness = harnessFor({ noteDeleted: true });
    await expect(harness.worker.handle(contextFor())).resolves.toBeUndefined();

    expect(emailIntents(harness)).toHaveLength(0);
    expect(deliveryRows(harness)).toHaveLength(0);
    expect(harness.emit).not.toHaveBeenCalled();
  });

  /*
   * `queue` is idempotent on the business key and ends in `onConflictDoNothing`;
   * `NotificationService.emit` is a bare insert with no upsert. `releaseExecution`
   * genuinely re-runs a job, so the idempotent write has to happen first — the
   * other order turns every retry into a duplicate notification row.
   */
  it("writes the email intent before the notification row", async () => {
    const harness = harnessFor({ emitFails: true });
    await expect(harness.worker.handle(contextFor())).rejects.toThrow("notification insert failed");

    expect(emailIntents(harness)).toHaveLength(1);
  });
});
