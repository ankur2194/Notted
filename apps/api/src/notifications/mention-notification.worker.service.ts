// Part 60 — consumer for the `notification.mention` intent.
//
// WHY THE ROW IS WRITTEN HERE AND NOT IN THE REQUEST TRANSACTION: a single save
// can mention up to `MENTION_NOTIFY_MAX_RECIPIENTS` people, each needing a
// membership re-check plus a display-name join, on the autosave hot path. ADR
// 0006 is explicit that the durable INTENT belongs in PostgreSQL alongside the
// business mutation and the SIDE EFFECT happens after commit — so the note
// update commits fast and the notification rows are materialised out of band.
//
// PART 61 BOUNDARY — WHAT IT ACTUALLY FORBIDS. This handler writes the in-app
// notification row AND queues the mention email intent. It must never speak to
// the email TRANSPORT: `email.deliver` stays its own outbox intent, with its
// own template, its own delivery record and its own handler, so a provider
// outage can never block or retry the in-app notification. Do not call SMTP
// from here, and do not add an email/delivery column to `notifications`.
//
// The email intent is queued here rather than in the producer because this is
// the only place that re-authorizes `note.read` for the recipient. The producer
// runs inside `NotesService.update`'s transaction and can see workspace
// membership only — which is not what `note.read` means for a note in a
// restricted project. See `mention-notification.producer.ts` for the full
// reasoning and for why the check cannot move the other way.

import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";

import { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import { AuthorizationDeniedError } from "../authorization/authorization.errors";
import { DatabaseService } from "../database/database.service";
import { notes, users } from "../database/schema";
import { WorkspaceEmailProducerService } from "../email/workspace-email-producer.service";
import { defineQueueJobRegistration, type QueueJobContext } from "../queue/job-contracts";
import { MENTION_NOTIFY_JOB_DEFINITION } from "../queue/job-registry";
import { PermanentQueueJobError } from "../queue/queue-errors";
import { QueueHandlerRegistry } from "../queue/queue-handler-registry.service";
import { createTenantContext, TenantContextService } from "../tenant";

import { NotificationService } from "./notification.service";

import type { z } from "zod";

/** `notifications.summary` / `notifications.target_label` column widths. */
const SUMMARY_MAX_LENGTH = 160;
const TARGET_LABEL_MAX_LENGTH = 120;

/** Used when the actor row is gone or has a blank name. */
const ANONYMOUS_MENTION_SUMMARY = "You were mentioned in a note";

type MentionNotifyContext = QueueJobContext<
  typeof MENTION_NOTIFY_JOB_DEFINITION.jobType,
  z.output<typeof MENTION_NOTIFY_JOB_DEFINITION.payloadSchema>
>;

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : value.slice(0, max);

@Injectable()
export class MentionNotificationWorkerService implements OnModuleInit, OnModuleDestroy {
  readonly jobType = MENTION_NOTIFY_JOB_DEFINITION.jobType;
  private unregister?: () => void;

  constructor(
    private readonly database: DatabaseService,
    private readonly notifications: NotificationService,
    private readonly tenantContext: TenantContextService,
    private readonly registry: QueueHandlerRegistry,
    private readonly authorization: AuthorizationEntryService,
    // REQUIRED, deliberately. An optional dependency here would let a broken
    // `NotificationModule` -> `EmailModule` import silently stop every mention
    // email while the in-app intent kept working, which is exactly the
    // regression nobody notices. Nest fails to boot instead.
    private readonly emailProducer: WorkspaceEmailProducerService,
  ) {}

  onModuleInit(): void {
    this.unregister = this.registry.register(
      defineQueueJobRegistration({ definition: MENTION_NOTIFY_JOB_DEFINITION, handler: this }),
    );
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  async handle(context: MentionNotifyContext): Promise<void> {
    if (context.payload.intentId !== context.outboxIntentId) {
      throw new PermanentQueueJobError("payload_invalid");
    }
    const { workspaceId, noteId, recipientId, actorId } = context.payload;

    await this.tenantContext.run(
      createTenantContext({ workspaceId, userId: null, requestId: context.correlationId }),
      async () => {
        // RE-AUTHORIZE THE RECIPIENT, NOT JUST THEIR MEMBERSHIP.
        //
        // A workspace membership check is NOT what `note.read` means. Notes in
        // a `restricted` project are readable only by members of that project
        // (`projectCanRead` in the policy), so a membership-only re-check let
        // any editor mention a workspace member with no project access and hand
        // them the note's title, id and existence in a notification — a
        // disclosure the note itself would have refused.
        //
        // `authorizeUserJob` is the existing identifier-only job seam: it
        // reloads live membership AND live resource facts for this recipient
        // and runs the same policy the socket and HTTP transports run, so there
        // is exactly one authorization implementation. It subsumes the
        // membership lookup this replaced — a recipient who left the workspace
        // has no membership row and is denied here.
        //
        // A denial is not an error, it is "nothing to deliver": the mention was
        // legitimately produced, this recipient simply cannot see the target.
        try {
          await this.authorization.authorizeUserJob({
            userId: recipientId,
            workspaceId,
            action: "note.read",
            resource: { kind: "note", id: noteId },
            correlationId: context.correlationId,
          });
        } catch (error: unknown) {
          if (error instanceof AuthorizationDeniedError) return;
          throw error;
        }

        // Re-read authoritative state rather than carrying it in the payload:
        // the intent is identifier-only, and the title may have changed.
        const [note] = await this.database.db
          .select({ title: notes.title, isDeleted: notes.isDeleted })
          .from(notes)
          .where(and(eq(notes.workspaceId, workspaceId), eq(notes.id, noteId)))
          .limit(1);
        if (note === undefined || note.isDeleted) return;

        // One lookup for both people. This used to fetch the actor alone; the
        // recipient's address rides along at no extra query cost.
        const userRows = await this.database.db
          .select({ id: users.id, name: users.name, email: users.email })
          .from(users)
          .where(inArray(users.id, [recipientId, actorId]));
        const actorName = userRows.find((row) => row.id === actorId)?.name.trim() ?? "";
        const recipientEmail = userRows.find((row) => row.id === recipientId)?.email;

        // PART 61 BOUNDARY, RESTATED — the reason survives, the location moved.
        //
        // The mention EMAIL is queued HERE and nowhere else, because this is the
        // only place that re-authorizes `note.read` for the recipient. It used
        // to be queued by `MentionNotificationProducer`, which can only see
        // workspace membership — so a member with no grant on a restricted
        // project got no in-app row and an email anyway.
        //
        // WHAT THE BOUNDARY PROTECTS IS INTACT: this writes a durable intent
        // row and never speaks to SMTP. `email.deliver` is still its own job
        // type, its own queue and its own handler, so a provider outage still
        // cannot block, retry or fail the in-app notification below. Never call
        // the transport from here.
        //
        // BEFORE `emit`, deliberately. `queue` is idempotent on the business key
        // and ends in `onConflictDoNothing`; `NotificationService.emit` is a
        // bare insert with no upsert. `releaseExecution` genuinely re-runs a
        // job, so the idempotent write has to come first — the other order
        // turns every retry into a duplicate notification row.
        if (recipientEmail !== undefined) {
          await this.database.transaction((tx) =>
            this.emailProducer.queue(tx, {
              templateKey: "mention",
              recipient: recipientEmail,
              workspaceId,
              relatedEntityType: "note",
              relatedEntityId: noteId,
              actorId,
              correlationId: context.correlationId,
            }),
          );
        }

        await this.notifications.emit({
          workspaceId,
          recipientUserId: recipientId,
          actorUserId: actorId,
          kind: "mention",
          targetType: "note",
          targetId: noteId,
          summary: truncate(
            actorName.length === 0 ? ANONYMOUS_MENTION_SUMMARY : `${actorName} mentioned you`,
            SUMMARY_MAX_LENGTH,
          ),
          targetLabel: truncate(note.title, TARGET_LABEL_MAX_LENGTH),
        });
      },
    );
  }
}
