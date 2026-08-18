import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { StructuredLogger } from "../common/logging/structured-logger.service";
import { emailDeliveries, jobOutbox } from "../database/schema";
import { WorkspaceEmailProducerService } from "../email/workspace-email-producer.service";
import { DOMAIN_JOB_TYPES } from "../queue/job-identifiers";
import {
  MENTION_NOTIFY_JOB_DEFINITION,
  MENTION_NOTIFY_SOURCE_QUEUE_NAME,
} from "../queue/job-registry";
import { createTenantContext, TenantContextService } from "../tenant";

import {
  MENTION_NOTIFY_IDEMPOTENCY_PREFIX,
  MentionNotificationProducer,
  mentionNotifyIdempotencyKey,
} from "./mention-notification.producer";

import type { DatabaseTransaction } from "../database/database.service";

const WORKSPACE_ID = "11111111-0000-4000-8000-000000000001";
const NOTE_ID = "22222222-0000-4000-8000-000000000002";
const ACTOR_ID = "33333333-0000-4000-8000-000000000003";
const REQUEST_ID = "44444444-0000-4000-8000-000000000004";
const MEMBER_A = "55555555-0000-4000-8000-000000000005";
const MEMBER_B = "66666666-0000-4000-8000-000000000006";
const OUTSIDER = "77777777-0000-4000-8000-000000000007";

/** A minimal ProseMirror document mentioning `userIds`, in order. */
function documentMentioning(...userIds: readonly string[]): unknown {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: userIds.map((id) => ({
          type: "mention",
          attrs: { id, label: `User ${id.slice(0, 4)}` },
        })),
      },
    ],
  };
}

const EMPTY_DOCUMENT = { type: "doc", content: [{ type: "paragraph" }] };

interface InsertedRow {
  readonly table: unknown;
  readonly values: Record<string, unknown>;
  /** Set by the fake when `.onConflictDoNothing()` was chained. */
  conflictDoNothing: boolean;
}

interface FakeTx {
  readonly tx: DatabaseTransaction;
  readonly inserts: InsertedRow[];
  /** Every membership lookup the producer issued; must stay at 0 on the hot path. */
  readonly selects: { readonly ids: readonly string[] }[];
}

/**
 * Records `insert(...).values(...).onConflictDoNothing()` and answers the single
 * membership `select(...)` from a fixed member set. No database involved; the
 * producer touches nothing else on the transaction.
 */
/** One save now writes TWO independent kinds of outbox intent; split them. */
function outboxRows(fake: FakeTx, action: string): readonly InsertedRow[] {
  return fake.inserts.filter(
    (row) =>
      row.table === jobOutbox &&
      (row.values.payload as { readonly action?: string }).action === action,
  );
}

const mentionRows = (fake: FakeTx): readonly InsertedRow[] =>
  outboxRows(fake, DOMAIN_JOB_TYPES.mentionNotify);
const emailRows = (fake: FakeTx): readonly InsertedRow[] =>
  outboxRows(fake, DOMAIN_JOB_TYPES.deliverWorkspaceEmail);
const deliveryRows = (fake: FakeTx): readonly InsertedRow[] =>
  fake.inserts.filter((row) => row.table === emailDeliveries);

/** `<id>@example.test`, so a recipient address is derivable from its id. */
function emailFor(userId: string): string {
  return `${userId}@example.test`;
}

function fakeTx(members: readonly string[], suppressed = false): FakeTx {
  const inserts: InsertedRow[] = [];
  const selects: { readonly ids: readonly string[] }[] = [];
  const memberSet = new Set(members);
  // The fake cannot parse Drizzle SQL, so it records the call and returns every
  // known member; the producer intersects the result with its own candidate
  // list, which is exactly the behaviour under test.
  const tx = {
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        const row: InsertedRow = { table, values, conflictDoNothing: false };
        inserts.push(row);
        return {
          onConflictDoNothing: () => {
            row.conflictDoNothing = true;
            return {
              // `WorkspaceEmailProducerService` needs the surviving outbox row;
              // `MentionNotificationProducer` just awaits the statement.
              returning: () => Promise.resolve([{ id: values.id }]),
              then: (resolve: (value: unknown) => unknown) => resolve(undefined),
            };
          },
          then: (resolve: (value: unknown) => unknown) => resolve(undefined),
        };
      },
    }),
    select: () => ({
      from: (table: unknown) => {
        // The suppression lookup reads `email_deliveries`; every other select
        // here is the single membership lookup.
        if (table === emailDeliveries) {
          return {
            where: () => ({ limit: () => Promise.resolve(suppressed ? [{ id: "sentinel" }] : []) }),
          };
        }
        const answer = () => {
          selects.push({ ids: [...memberSet] });
          return Promise.resolve(
            [...memberSet].map((userId) => ({ userId, email: emailFor(userId) })),
          );
        };
        return { innerJoin: () => ({ where: answer }), where: answer };
      },
    }),
  };
  return { tx: tx as unknown as DatabaseTransaction, inserts, selects };
}

function producerFor(): {
  readonly producer: MentionNotificationProducer;
  readonly tenant: TenantContextService;
} {
  const tenant = new TenantContextService();
  const logger = { info: () => undefined } as unknown as StructuredLogger;
  return {
    // The real email producer: its suppression check and its two writes are
    // exactly what this integration point has to get right.
    producer: new MentionNotificationProducer(
      tenant,
      logger,
      new WorkspaceEmailProducerService(tenant),
    ),
    tenant,
  };
}

async function runInTenant<T>(
  tenant: TenantContextService,
  workspaceId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return tenant.run(createTenantContext({ workspaceId, userId: null }), fn);
}

describe("MentionNotificationProducer", () => {
  it("re-saving an unchanged document inserts nothing and never queries", async () => {
    const { producer, tenant } = producerFor();
    const fake = fakeTx([MEMBER_A]);
    const document = documentMentioning(MEMBER_A);
    await runInTenant(tenant, WORKSPACE_ID, () =>
      producer.scheduleMentionNotifications(fake.tx, WORKSPACE_ID, {
        noteId: NOTE_ID,
        previousContent: document,
        nextContent: document,
        actorId: ACTOR_ID,
        correlationId: REQUEST_ID,
      }),
    );
    expect(fake.inserts).toHaveLength(0);
    // The cheap diff gate runs BEFORE any SQL — this is the autosave hot path.
    expect(fake.selects).toHaveLength(0);
  });

  it("is a no-op for a settings-only update (no next document)", async () => {
    const { producer, tenant } = producerFor();
    const fake = fakeTx([MEMBER_A]);
    await runInTenant(tenant, WORKSPACE_ID, () =>
      producer.scheduleMentionNotifications(fake.tx, WORKSPACE_ID, {
        noteId: NOTE_ID,
        previousContent: EMPTY_DOCUMENT,
        nextContent: undefined,
        actorId: ACTOR_ID,
      }),
    );
    expect(fake.inserts).toHaveLength(0);
    expect(fake.selects).toHaveLength(0);
  });

  it("emits one intent per newly added mention and skips the pre-existing one", async () => {
    const { producer, tenant } = producerFor();
    const fake = fakeTx([MEMBER_A, MEMBER_B]);
    await runInTenant(tenant, WORKSPACE_ID, () =>
      producer.scheduleMentionNotifications(fake.tx, WORKSPACE_ID, {
        noteId: NOTE_ID,
        previousContent: documentMentioning(MEMBER_A),
        nextContent: documentMentioning(MEMBER_A, MEMBER_B),
        actorId: ACTOR_ID,
        correlationId: REQUEST_ID,
      }),
    );
    expect(mentionRows(fake)).toHaveLength(1);
    const row = mentionRows(fake)[0]!;
    expect(row.table).toBe(jobOutbox);
    expect(row.values.queueName).toBe(MENTION_NOTIFY_SOURCE_QUEUE_NAME);
    expect(row.values.jobType).toBe(DOMAIN_JOB_TYPES.mentionNotify);
    expect(row.values.payloadVersion).toBe(MENTION_NOTIFY_JOB_DEFINITION.payloadVersion);
    expect(row.values.correlationId).toBe(REQUEST_ID);

    const payload = row.values.payload as Record<string, unknown>;
    expect(payload.recipientId).toBe(MEMBER_B);
    expect(payload.actorId).toBe(ACTOR_ID);
    expect(payload.noteId).toBe(NOTE_ID);
    expect(row.values.id).toBe(payload.intentId);
    // The registered schema must accept exactly what the producer writes, and
    // reject any leaked content field.
    expect(MENTION_NOTIFY_JOB_DEFINITION.payloadSchema.safeParse(payload).success).toBe(true);
    expect(
      MENTION_NOTIFY_JOB_DEFINITION.payloadSchema.safeParse({ ...payload, label: "Ada" }).success,
    ).toBe(false);
    expect(row.values.payloadHash).toBe(
      createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
    );
  });

  it("excludes the actor's own id (no self-notification)", async () => {
    const { producer, tenant } = producerFor();
    const fake = fakeTx([ACTOR_ID, MEMBER_A]);
    await runInTenant(tenant, WORKSPACE_ID, () =>
      producer.scheduleMentionNotifications(fake.tx, WORKSPACE_ID, {
        noteId: NOTE_ID,
        previousContent: EMPTY_DOCUMENT,
        nextContent: documentMentioning(ACTOR_ID, MEMBER_A),
        actorId: ACTOR_ID,
      }),
    );
    const recipients = mentionRows(fake).map(
      (row) => (row.values.payload as { readonly recipientId: string }).recipientId,
    );
    expect(recipients).toEqual([MEMBER_A]);
  });

  it("is a no-op when the ONLY new mention is the actor (never queries)", async () => {
    const { producer, tenant } = producerFor();
    const fake = fakeTx([ACTOR_ID]);
    await runInTenant(tenant, WORKSPACE_ID, () =>
      producer.scheduleMentionNotifications(fake.tx, WORKSPACE_ID, {
        noteId: NOTE_ID,
        previousContent: EMPTY_DOCUMENT,
        nextContent: documentMentioning(ACTOR_ID),
        actorId: ACTOR_ID,
      }),
    );
    expect(fake.inserts).toHaveLength(0);
    expect(fake.selects).toHaveLength(0);
  });

  it("drops a mention id that is not a workspace member, without throwing", async () => {
    const { producer, tenant } = producerFor();
    // OUTSIDER is deliberately absent from the member set: a forged attrs.id.
    const fake = fakeTx([MEMBER_A]);
    await runInTenant(tenant, WORKSPACE_ID, () =>
      producer.scheduleMentionNotifications(fake.tx, WORKSPACE_ID, {
        noteId: NOTE_ID,
        previousContent: EMPTY_DOCUMENT,
        nextContent: documentMentioning(OUTSIDER, MEMBER_A),
        actorId: ACTOR_ID,
      }),
    );
    // Exactly one membership lookup for the whole fan-out.
    expect(fake.selects).toHaveLength(1);
    const recipients = mentionRows(fake).map(
      (row) => (row.values.payload as { readonly recipientId: string }).recipientId,
    );
    expect(recipients).toEqual([MEMBER_A]);
  });

  it("inserts nothing when every new mention is a non-member (no existence leak)", async () => {
    const { producer, tenant } = producerFor();
    const fake = fakeTx([]);
    await expect(
      runInTenant(tenant, WORKSPACE_ID, () =>
        producer.scheduleMentionNotifications(fake.tx, WORKSPACE_ID, {
          noteId: NOTE_ID,
          previousContent: EMPTY_DOCUMENT,
          nextContent: documentMentioning(OUTSIDER),
          actorId: ACTOR_ID,
        }),
      ),
    ).resolves.toBeUndefined();
    expect(fake.inserts).toHaveLength(0);
  });

  it("skips a malformed mention node (no usable user id)", async () => {
    const { producer, tenant } = producerFor();
    const fake = fakeTx([MEMBER_A]);
    await runInTenant(tenant, WORKSPACE_ID, () =>
      producer.scheduleMentionNotifications(fake.tx, WORKSPACE_ID, {
        noteId: NOTE_ID,
        previousContent: EMPTY_DOCUMENT,
        nextContent: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "mention", attrs: { id: "not-a-uuid", label: "Ada" } }],
            },
          ],
        },
        actorId: ACTOR_ID,
      }),
    );
    expect(fake.inserts).toHaveLength(0);
    expect(fake.selects).toHaveLength(0);
  });

  it("issues every insert with the ON CONFLICT DO NOTHING clause", async () => {
    const { producer, tenant } = producerFor();
    const fake = fakeTx([MEMBER_A, MEMBER_B]);
    await runInTenant(tenant, WORKSPACE_ID, () =>
      producer.scheduleMentionNotifications(fake.tx, WORKSPACE_ID, {
        noteId: NOTE_ID,
        previousContent: EMPTY_DOCUMENT,
        nextContent: documentMentioning(MEMBER_A, MEMBER_B),
        actorId: ACTOR_ID,
      }),
    );
    expect(mentionRows(fake)).toHaveLength(2);
    // The unique index collapses a duplicate to a no-op only because the insert
    // carries this clause; without it a retry would abort the note update.
    expect(mentionRows(fake).every((row) => row.conflictDoNothing)).toBe(true);
  });

  it("emits an independent email intent alongside each in-app mention intent", async () => {
    const { producer, tenant } = producerFor();
    const fake = fakeTx([MEMBER_A]);
    await runInTenant(tenant, WORKSPACE_ID, () =>
      producer.scheduleMentionNotifications(fake.tx, WORKSPACE_ID, {
        noteId: NOTE_ID,
        previousContent: EMPTY_DOCUMENT,
        nextContent: documentMentioning(MEMBER_A),
        actorId: ACTOR_ID,
        correlationId: REQUEST_ID,
      }),
    );
    // Two intents, two handlers, two failure domains — plus exactly one
    // authoritative `email_deliveries` row for the message.
    expect(mentionRows(fake)).toHaveLength(1);
    expect(emailRows(fake)).toHaveLength(1);
    expect(deliveryRows(fake)).toHaveLength(1);

    const delivery = deliveryRows(fake)[0]!.values;
    expect(delivery.templateKey).toBe("mention");
    expect(delivery.status).toBe("queued");
    expect(delivery.workspaceId).toBe(WORKSPACE_ID);
    expect(delivery.recipient).toBe(emailFor(MEMBER_A));
    expect(delivery.relatedEntityType).toBe("note");
    expect(delivery.relatedEntityId).toBe(NOTE_ID);

    const emailPayload = emailRows(fake)[0]!.values.payload as Record<string, unknown>;
    expect(emailPayload.actorId).toBe(ACTOR_ID);
    expect(emailPayload.deliveryId).toBe(delivery.id);
    // Identifiers only: no recipient address and no note content in Redis.
    expect(emailPayload).not.toHaveProperty("recipient");
    expect(emailRows(fake)[0]!.values.correlationId).toBe(REQUEST_ID);
  });

  it("keeps the in-app mention intent when the recipient suppressed mention email", async () => {
    const { producer, tenant } = producerFor();
    const fake = fakeTx([MEMBER_A], true);
    await runInTenant(tenant, WORKSPACE_ID, () =>
      producer.scheduleMentionNotifications(fake.tx, WORKSPACE_ID, {
        noteId: NOTE_ID,
        previousContent: EMPTY_DOCUMENT,
        nextContent: documentMentioning(MEMBER_A),
        actorId: ACTOR_ID,
      }),
    );
    expect(mentionRows(fake)).toHaveLength(1);
    // No outbox intent means nothing can ever send it; the `suppressed` delivery
    // row is the durable record that it was withheld on purpose.
    expect(emailRows(fake)).toHaveLength(0);
    expect(deliveryRows(fake)).toHaveLength(1);
    expect(deliveryRows(fake)[0]!.values.status).toBe("suppressed");
  });
});

describe("mentionNotifyIdempotencyKey", () => {
  it("is deterministic for the same workspace/note/recipient triple", () => {
    expect(mentionNotifyIdempotencyKey(WORKSPACE_ID, NOTE_ID, MEMBER_A)).toBe(
      mentionNotifyIdempotencyKey(WORKSPACE_ID, NOTE_ID, MEMBER_A),
    );
    expect(mentionNotifyIdempotencyKey(WORKSPACE_ID, NOTE_ID, MEMBER_A)).toBe(
      `${MENTION_NOTIFY_IDEMPOTENCY_PREFIX}${createHash("sha256")
        .update(
          JSON.stringify({ workspaceId: WORKSPACE_ID, noteId: NOTE_ID, recipientId: MEMBER_A }),
        )
        .digest("hex")}`,
    );
  });

  it("differs across recipients and across notes", () => {
    const base = mentionNotifyIdempotencyKey(WORKSPACE_ID, NOTE_ID, MEMBER_A);
    expect(mentionNotifyIdempotencyKey(WORKSPACE_ID, NOTE_ID, MEMBER_B)).not.toBe(base);
    expect(mentionNotifyIdempotencyKey(WORKSPACE_ID, ACTOR_ID, MEMBER_A)).not.toBe(base);
    expect(mentionNotifyIdempotencyKey(ACTOR_ID, NOTE_ID, MEMBER_A)).not.toBe(base);
  });

  it("makes a repeated schedule of the same mention collapse to one intent", async () => {
    // The producer's diff gate already prevents the second call, but if two
    // concurrent transactions BOTH see the mention as new, the unique index on
    // job_outbox.idempotency_key is what collapses them — and it can only do
    // that because both compute the identical key.
    const { producer, tenant } = producerFor();
    const first = fakeTx([MEMBER_A]);
    const second = fakeTx([MEMBER_A]);
    const schedule = (fake: ReturnType<typeof fakeTx>): Promise<void> =>
      producer.scheduleMentionNotifications(fake.tx, WORKSPACE_ID, {
        noteId: NOTE_ID,
        previousContent: EMPTY_DOCUMENT,
        nextContent: documentMentioning(MEMBER_A),
        actorId: ACTOR_ID,
      });
    await runInTenant(tenant, WORKSPACE_ID, async () => {
      await schedule(first);
      await schedule(second);
    });
    expect(first.inserts[0]!.values.idempotencyKey).toBe(second.inserts[0]!.values.idempotencyKey);
    // Fresh intent ids, identical dedup identity: the second row loses the
    // conflict and disappears.
    expect(first.inserts[0]!.values.id).not.toBe(second.inserts[0]!.values.id);
  });
});
