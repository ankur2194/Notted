// Part 61 — the workspace email pipeline against a live, disposable PostgreSQL.
//
// Same shape as `comments.integration.test.ts`: self-provisioning (`migrate`),
// self-skipping when no reachable `DATABASE_URL` is configured, and every
// collaborator constructed BY HAND rather than through the Nest container, so
// the test exercises the real SQL and the real renderer without booting the
// application graph.
//
// NO REDIS, NO BULLMQ LOOP, NO SMTP SERVER. The producer half is proved by the
// rows it commits (`email_deliveries` + `job_outbox`); the consumer half by
// invoking `EmailDeliveryQueueHandler.handle` directly with a payload parsed
// from the committed intent. The one substituted collaborator is `SmtpService`
// — a real provider connection would add a broker and a source of flakes
// without touching a line of the behaviour under test, and the fake is what
// lets the test prove the renderer really ran.
//
// Fixtures are private to this suite (own users/workspaces with random ids)
// rather than `SEED_IDS`, so it cannot contend with the ten suites that upsert
// those rows.

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { and, eq, inArray, isNull } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthorizationEntryService } from "../src/authorization/authorization-entry.service";
import { AuthorizationPolicyService } from "../src/authorization/authorization-policy.service";
import { AuthorizationRepository } from "../src/authorization/authorization.repository";
import { DatabaseService, type DatabaseTransaction } from "../src/database/database.service";
import {
  emailDeliveries,
  jobOutbox,
  notes,
  schema,
  users,
  workspaces,
} from "../src/database/schema";
import { EmailDeliveryQueueHandler } from "../src/email/email-delivery.worker.service";
import { EmailRendererService } from "../src/email/email-renderer.service";
import {
  WorkspaceEmailProducerService,
  workspaceEmailIdempotencyKey,
  type QueueWorkspaceEmailInput,
} from "../src/email/workspace-email-producer.service";
import { WORKSPACE_EMAIL_JOB_DEFINITION } from "../src/queue/job-registry";
import { PermanentQueueJobError } from "../src/queue/queue-errors";
import { QueueHandlerRegistry } from "../src/queue/queue-handler-registry.service";
import { createTenantContext, TenantContextService } from "../src/tenant";

import type { StructuredLogger } from "../src/common/logging/structured-logger.service";
import type { AppConfig } from "../src/config/app.config";
import type { FeaturesConfig } from "../src/config/features.config";
import type {
  EmailMessage as SmtpMessage,
  SmtpService,
} from "../src/infrastructure/smtp/smtp.service";
import type { PgTransactionConfig } from "drizzle-orm/pg-core/session";

const DATABASE_URL = process.env.DATABASE_URL;
const HAS_DATABASE_URL = typeof DATABASE_URL === "string" && DATABASE_URL.trim() !== "";
const MIGRATIONS_FOLDER = resolve(process.cwd(), "src/database/migrations");

const PROVIDER_MESSAGE_ID = "<integration-provider-message-id@notted.test>";

async function reachable(url: string): Promise<boolean> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Records what the renderer handed the transport; never asserted as content. */
function fakeSmtp(): { readonly sent: SmtpMessage[]; readonly service: SmtpService } {
  const sent: SmtpMessage[] = [];
  const service = {
    send: async (message: SmtpMessage): Promise<string> => {
      sent.push(message);
      return PROVIDER_MESSAGE_ID;
    },
  };
  return { sent, service: service as unknown as SmtpService };
}

function build(db: NodePgDatabase<typeof schema>) {
  const tenant = new TenantContextService();
  const database = {
    db,
    transaction: <T>(
      work: (scope: DatabaseTransaction) => Promise<T>,
      config?: PgTransactionConfig,
    ) => db.transaction(work, config),
  } as unknown as DatabaseService;
  const logger = { info: () => undefined, warn: () => undefined } as unknown as StructuredLogger;
  const smtp = fakeSmtp();
  const handler = new EmailDeliveryQueueHandler(
    database,
    new AuthorizationEntryService(
      new AuthorizationRepository(database, tenant),
      new AuthorizationPolicyService(),
      tenant,
    ),
    // The REAL renderer: a stub would let a broken template ship green.
    new EmailRendererService(),
    smtp.service,
    logger,
    new QueueHandlerRegistry(),
    { appUrl: new URL("https://app.notted.test") } as AppConfig,
    { emailEnabled: true } as FeaturesConfig,
  );
  return { handler, producer: new WorkspaceEmailProducerService(tenant), smtp, tenant };
}

/** The committed intent, re-parsed through the registered contract. */
function jobContext(
  intent: { readonly id: string; readonly idempotencyKey: string; readonly payload: unknown },
  overrides: { readonly workspaceId?: string | null } = {},
) {
  const payload = WORKSPACE_EMAIL_JOB_DEFINITION.payloadSchema.parse(intent.payload);
  return {
    outboxIntentId: intent.id,
    jobType: WORKSPACE_EMAIL_JOB_DEFINITION.jobType,
    idempotencyKey: intent.idempotencyKey,
    signal: new AbortController().signal,
    payload:
      overrides.workspaceId === undefined
        ? payload
        : { ...payload, workspaceId: overrides.workspaceId },
  };
}

describe.skipIf(!HAS_DATABASE_URL)("Part 61 email delivery (live PostgreSQL)", () => {
  let pool: Pool | undefined;
  let db: NodePgDatabase<typeof schema> | undefined;
  let databaseReachable = false;

  const userId = randomUUID();
  const workspaceAId = randomUUID();
  const workspaceBId = randomUUID();
  const noteId = randomUUID();
  /** Every address this suite writes, so `afterAll` can find its rows. */
  const recipients: string[] = [];
  /** Every outbox key this suite writes; workspace-less intents have no other
   * handle to clean them up by. */
  const idempotencyKeys: string[] = [];

  function recipient(label: string): string {
    const address = `part61-${label}-${randomUUID()}@example.invalid`;
    recipients.push(address);
    return address;
  }

  /** The key `job_outbox_idempotency_key_unique` enforces for this event. */
  function idempotencyKeyFor(input: QueueWorkspaceEmailInput): string {
    const key = workspaceEmailIdempotencyKey({
      templateKey: input.templateKey,
      // Every address this suite generates is already lower-case, so it matches
      // what `normalizeRecipient` wrote.
      recipient: input.recipient,
      relatedEntityType: input.relatedEntityType,
      relatedEntityId: input.relatedEntityId,
    });
    idempotencyKeys.push(key);
    return key;
  }

  beforeAll(async () => {
    databaseReachable = await reachable(DATABASE_URL as string);
    if (!databaseReachable) return;
    pool = new Pool({ connectionString: DATABASE_URL as string, max: 8 });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    await db.insert(users).values({
      id: userId,
      email: `part61-fixture-${userId}@example.invalid`,
      name: "Ada Lovelace",
    });
    await db.insert(workspaces).values([
      {
        id: workspaceAId,
        name: "Part 61 alpha",
        slug: `part61-a-${workspaceAId}`,
        createdById: userId,
      },
      {
        id: workspaceBId,
        name: "Part 61 beta",
        slug: `part61-b-${workspaceBId}`,
        createdById: userId,
      },
    ]);
    await db.insert(notes).values({
      id: noteId,
      workspaceId: workspaceAId,
      title: "Part 61 mention host",
      createdById: userId,
      updatedById: userId,
    });
  });

  afterAll(async () => {
    if (db !== undefined) {
      if (recipients.length > 0) {
        await db.delete(emailDeliveries).where(inArray(emailDeliveries.recipient, recipients));
      }
      await db.delete(notes).where(eq(notes.id, noteId));
      // By key, not by workspace: `welcome` intents are workspace-less, and
      // `job_outbox.workspace_id` is ON DELETE SET NULL anyway, so a workspace
      // delete would strip the only other handle on the scoped rows.
      if (idempotencyKeys.length > 0) {
        await db.delete(jobOutbox).where(inArray(jobOutbox.idempotencyKey, idempotencyKeys));
      }
      await db.delete(workspaces).where(inArray(workspaces.id, [workspaceAId, workspaceBId]));
      await db.delete(users).where(eq(users.id, userId));
    }
    await pool?.end();
  });

  it("carries a queued intent through the renderer to a sent delivery", async ({ skip }) => {
    if (!databaseReachable || db === undefined) return skip("no reachable disposable PostgreSQL");
    const { handler, producer, smtp } = build(db);
    const address = recipient("welcome");
    const input: QueueWorkspaceEmailInput = {
      templateKey: "welcome",
      recipient: address,
      // `welcome` is workspace-less system mail: no tenant to assert against.
      workspaceId: null,
      relatedEntityType: "user",
      relatedEntityId: userId,
    };

    const queued = await db.transaction(async (tx) => producer.queue(tx, input));
    expect(queued.outcome).toBe("queued");

    const [pending] = await db
      .select()
      .from(emailDeliveries)
      .where(eq(emailDeliveries.recipient, address));
    expect(pending?.status).toBe("queued");
    expect(pending?.attempts).toBe(0);
    expect(pending?.sentAt).toBeNull();

    const intents = await db
      .select()
      .from(jobOutbox)
      .where(eq(jobOutbox.idempotencyKey, idempotencyKeyFor(input)));
    expect(intents).toHaveLength(1);

    // Drive the consumer directly — no Redis, no BullMQ loop (see file header).
    await handler.handle(jobContext(intents[0]!));

    const [settled] = await db
      .select()
      .from(emailDeliveries)
      .where(eq(emailDeliveries.id, queued.deliveryId as string));
    expect(settled?.status).toBe("sent");
    expect(settled?.attempts).toBe(1);
    expect(settled?.providerMessageId).toBe(PROVIDER_MESSAGE_ID);
    expect(settled?.sentAt).not.toBeNull();
    expect(settled?.errorMessage).toBeNull();

    // The renderer really ran: a stubbed one would have handed over blanks.
    // Only emptiness is asserted — bodies are deliberately never persisted and
    // the copy changes without changing the pipeline.
    expect(smtp.sent).toHaveLength(1);
    const message = smtp.sent[0]!;
    expect(message.to).toBe(address);
    expect(message.subject.length).toBeGreaterThan(0);
    expect((message.html ?? "").length).toBeGreaterThan(0);
    expect((message.text ?? "").length).toBeGreaterThan(0);
  });

  it("collapses a replayed business event to exactly one delivery", async ({ skip }) => {
    if (!databaseReachable || db === undefined) return skip("no reachable disposable PostgreSQL");
    const { producer } = build(db);
    const address = recipient("duplicate");
    const input: QueueWorkspaceEmailInput = {
      templateKey: "welcome",
      recipient: address,
      workspaceId: null,
      relatedEntityType: "user",
      relatedEntityId: userId,
    };

    // Two separate COMMITTED transactions: the second loses the unique index on
    // `job_outbox.idempotency_key`, exactly like a retried business request.
    const first = await db.transaction(async (tx) => producer.queue(tx, input));
    const second = await db.transaction(async (tx) => producer.queue(tx, input));

    expect(first.outcome).toBe("queued");
    expect(second).toEqual({ deliveryId: null, outcome: "duplicate" });

    const delivered = await db
      .select()
      .from(emailDeliveries)
      .where(eq(emailDeliveries.recipient, address));
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.id).toBe(first.deliveryId);

    const intents = await db
      .select()
      .from(jobOutbox)
      .where(eq(jobOutbox.idempotencyKey, idempotencyKeyFor(input)));
    expect(intents).toHaveLength(1);
  });

  it("refuses a foreign workspace id and leaves the owning workspace's row untouched", async ({
    skip,
  }) => {
    if (!databaseReachable || db === undefined) return skip("no reachable disposable PostgreSQL");
    const { handler, producer, smtp, tenant } = build(db);
    const address = recipient("mention");
    const input: QueueWorkspaceEmailInput = {
      templateKey: "mention",
      recipient: address,
      workspaceId: workspaceAId,
      relatedEntityType: "note",
      relatedEntityId: noteId,
      actorId: userId,
    };

    const queued = await tenant.run(
      createTenantContext({ workspaceId: workspaceAId, userId }),
      async () => db!.transaction(async (tx) => producer.queue(tx, input)),
    );
    expect(queued.outcome).toBe("queued");
    const deliveryId = queued.deliveryId as string;

    const [intent] = await db
      .select()
      .from(jobOutbox)
      .where(eq(jobOutbox.idempotencyKey, idempotencyKeyFor(input)));

    // Workspace A's delivery id, carried on a payload claiming workspace B. The
    // mandatory workspace predicate must resolve it to zero rows.
    await expect(
      handler.handle(jobContext(intent!, { workspaceId: workspaceBId })),
    ).rejects.toBeInstanceOf(PermanentQueueJobError);

    // Re-read from PostgreSQL: an in-memory copy would prove nothing about what
    // the handler's UPDATE statements did or did not touch.
    const [owned] = await db
      .select()
      .from(emailDeliveries)
      .where(
        and(eq(emailDeliveries.id, deliveryId), eq(emailDeliveries.workspaceId, workspaceAId)),
      );
    expect(owned?.status).toBe("queued");
    expect(owned?.attempts).toBe(0);
    expect(owned?.providerMessageId).toBeNull();
    expect(owned?.sentAt).toBeNull();
    expect(owned?.errorMessage).toBeNull();
    expect(smtp.sent).toHaveLength(0);

    // Nothing was invented under workspace B either.
    const forged = await db
      .select()
      .from(emailDeliveries)
      .where(eq(emailDeliveries.workspaceId, workspaceBId));
    expect(forged).toHaveLength(0);
    // ...and no workspace-less row was created as a side effect.
    const orphaned = await db
      .select()
      .from(emailDeliveries)
      .where(and(eq(emailDeliveries.recipient, address), isNull(emailDeliveries.workspaceId)));
    expect(orphaned).toHaveLength(0);
  });
});
