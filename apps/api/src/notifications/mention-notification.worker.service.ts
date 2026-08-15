// Part 60 — consumer for the `notification.mention` intent.
//
// WHY THE ROW IS WRITTEN HERE AND NOT IN THE REQUEST TRANSACTION: a single save
// can mention up to `MENTION_NOTIFY_MAX_RECIPIENTS` people, each needing a
// membership re-check plus a display-name join, on the autosave hot path. ADR
// 0006 is explicit that the durable INTENT belongs in PostgreSQL alongside the
// business mutation and the SIDE EFFECT happens after commit — so the note
// update commits fast and the notification rows are materialised out of band.
//
// PART 61 BOUNDARY — DO NOT CROSS: this handler writes the in-app notification
// row and stops. The mention EMAIL is Part 61's concern and will be its own
// outbox intent with its own template and its own delivery record. Do not
// enqueue an email here, do not add an email/delivery column to `notifications`,
// and do not couple the two handlers: an email-provider outage must never block
// or retry the in-app notification.

import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { and, eq } from "drizzle-orm";

import { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import { AuthorizationDeniedError } from "../authorization/authorization.errors";
import { DatabaseService } from "../database/database.service";
import { notes, users } from "../database/schema";
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

        const [actor] = await this.database.db
          .select({ name: users.name })
          .from(users)
          .where(eq(users.id, actorId))
          .limit(1);
        const actorName = actor?.name.trim() ?? "";

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
