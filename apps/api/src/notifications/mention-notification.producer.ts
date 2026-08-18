// Part 60 — transaction-scoped producer for the `notification.mention` intent.
//
// Called from inside `NotesService.update`'s transaction, exactly like
// `NoteSearchIndexProducer.scheduleSearchSync`: ADR 0006 requires the durable
// intent to commit atomically with the note mutation, with dispatch happening
// only after commit.
//
// "Each mention generates at most one notification" is true BY CONSTRUCTION
// here, not by retry suppression:
//
// 1. The diff gate. Only ids present in the NEXT document and absent from the
//    PREVIOUS one survive. A re-save of an unchanged document yields an empty
//    set and returns before touching the database — this is the autosave hot
//    path, so the cheap in-memory guard runs first.
// 2. `job_outbox_idempotency_key_unique` + `onConflictDoNothing`. Concurrent or
//    retried transactions writing the same (workspace, note, recipient) key
//    collapse to exactly one intent, atomically with the note update.
// 3. `job_idempotency_key_unique` + `QueueOutboxRepository#claimExecution`
//    give exactly-once EXECUTION of that intent.
//
// No partial unique index on `notifications` is added: it would be a third
// layer guarding nothing the first two miss, and it would cost a migration.

import { createHash, randomUUID } from "node:crypto";

import { Injectable } from "@nestjs/common";
import { collectNoteDocumentMentionIds } from "@notted/shared-validators";
import { and, eq, inArray } from "drizzle-orm";

import { StructuredLogger } from "../common/logging/structured-logger.service";
import { jobOutbox, users, workspaceMembers, type JobOutboxPayload } from "../database/schema";
import { WorkspaceEmailProducerService } from "../email/workspace-email-producer.service";
import { DOMAIN_JOB_TYPES } from "../queue/job-identifiers";
import {
  MENTION_NOTIFY_JOB_DEFINITION,
  MENTION_NOTIFY_SOURCE_QUEUE_NAME,
} from "../queue/job-registry";
import { activeWorkspaceId, assertActiveWorkspace, TenantContextService } from "../tenant";

import type { DatabaseTransaction } from "../database/database.service";

/** Shared prefix for every mention idempotency key, for operator legibility. */
export const MENTION_NOTIFY_IDEMPOTENCY_PREFIX = "mention-notify:";

/**
 * Hard cap on recipients notified by a single save. A document that mentions
 * more people than this is either a mass ping or an abuse attempt; the overflow
 * is logged (identifiers and counts only) and dropped.
 */
export const MENTION_NOTIFY_MAX_RECIPIENTS = 20;

export interface ScheduleMentionNotificationsInput {
  readonly noteId: string;
  /** The document as it was BEFORE this update (`readRow` result). */
  readonly previousContent: unknown;
  /** The document being saved, or `undefined` for a settings-only update. */
  readonly nextContent: unknown;
  readonly actorId: string;
  readonly correlationId?: string | null;
}

/**
 * Deterministic identity of "this workspace, this note, this recipient".
 *
 * ponytail: the identity deliberately omits time, so the same actor mentioning
 * the same recipient on the same note twice (removed, then re-added months
 * later) never re-notifies while the outbox row survives retention. Upgrade
 * path: add a day/epoch bucket to the hashed object — one line, no schema
 * change.
 */
export function mentionNotifyIdempotencyKey(
  workspaceId: string,
  noteId: string,
  recipientId: string,
): string {
  return `${MENTION_NOTIFY_IDEMPOTENCY_PREFIX}${createHash("sha256")
    .update(JSON.stringify({ workspaceId, noteId, recipientId }))
    .digest("hex")}`;
}

/** Identifier-only payload; it carries a recipient, so it has its own schema. */
type MentionNotifyPayload = JobOutboxPayload & {
  readonly workspaceId: string;
  readonly noteId: string;
  readonly recipientId: string;
  readonly actorId: string;
};

@Injectable()
export class MentionNotificationProducer {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly logger: StructuredLogger,
    // Part 61 — REQUIRED, deliberately. An optional dependency here would let a
    // broken `NotificationModule` -> `EmailModule` import silently stop every
    // mention email while the in-app intent kept working, which is exactly the
    // regression nobody notices. Nest fails to boot instead.
    private readonly emailProducer: WorkspaceEmailProducerService,
  ) {}

  /**
   * Schedule one `notification.mention` intent per newly mentioned workspace
   * member inside `tx`. Never throws for an unknown or foreign mention id — a
   * forged `attrs.id` simply matches no membership row and is dropped, which is
   * both deny-by-default and free of any cross-workspace existence leak.
   */
  async scheduleMentionNotifications(
    tx: DatabaseTransaction,
    workspaceId: string,
    input: ScheduleMentionNotificationsInput,
  ): Promise<void> {
    // Settings-only updates carry no document, so nothing can be newly mentioned.
    if (input.nextContent === undefined) return;

    const previous = new Set(collectNoteDocumentMentionIds(input.previousContent));
    const added = collectNoteDocumentMentionIds(input.nextContent).filter(
      (id) => !previous.has(id) && id !== input.actorId,
    );
    // The autosave hot path exits here: an unchanged document adds nothing, so
    // no SQL is issued at all.
    if (added.length === 0) return;

    assertActiveWorkspace(workspaceId, this.tenantContext, "notification.mention");

    // Anti-forging gate: exactly one membership lookup. Ids naming a user
    // outside this workspace return zero rows.
    const memberRows = await tx
      .select({ userId: workspaceMembers.userId, email: users.email })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          inArray(workspaceMembers.userId, [...added]),
        ),
      );
    const members = new Map(memberRows.map((row) => [row.userId, row.email]));
    // Preserve first-seen document order so the capped set is deterministic.
    const recipients = added.filter((id) => members.has(id));
    if (recipients.length === 0) return;

    const notified = recipients.slice(0, MENTION_NOTIFY_MAX_RECIPIENTS);
    if (recipients.length > notified.length) {
      this.logger.info(
        {
          workspaceId,
          noteId: input.noteId,
          jobType: DOMAIN_JOB_TYPES.mentionNotify,
          outcome: "recipients_capped",
          requested: recipients.length,
          notified: notified.length,
        },
        "Mention notification recipients capped",
      );
    }

    for (const recipientId of notified) {
      const intentId = randomUUID();
      const payload: MentionNotifyPayload = Object.freeze({
        action: DOMAIN_JOB_TYPES.mentionNotify,
        intentId,
        workspaceId,
        noteId: input.noteId,
        recipientId,
        actorId: input.actorId,
      });
      await tx
        .insert(jobOutbox)
        .values({
          id: intentId,
          workspaceId: activeWorkspaceId(this.tenantContext),
          queueName: MENTION_NOTIFY_SOURCE_QUEUE_NAME,
          jobType: DOMAIN_JOB_TYPES.mentionNotify,
          payloadVersion: MENTION_NOTIFY_JOB_DEFINITION.payloadVersion,
          payload,
          payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
          idempotencyKey: mentionNotifyIdempotencyKey(workspaceId, input.noteId, recipientId),
          correlationId: input.correlationId ?? null,
        })
        // The globally unique idempotency index turns a concurrent or retried
        // duplicate into a silent no-op instead of aborting the note update.
        .onConflictDoNothing();

      // Part 61 — a SECOND, independent intent for the email. Two intents, two
      // handlers, two failure domains: an SMTP outage can never block, retry or
      // fail the in-app notification above. The producer runs its own
      // suppression check, so a recipient who muted mention email still gets the
      // in-app row and simply no email intent.
      const recipientEmail = members.get(recipientId);
      if (recipientEmail !== undefined) {
        await this.emailProducer.queue(tx, {
          templateKey: "mention",
          recipient: recipientEmail,
          workspaceId,
          relatedEntityType: "note",
          relatedEntityId: input.noteId,
          actorId: input.actorId,
          correlationId: input.correlationId,
        });
      }
    }
  }
}
