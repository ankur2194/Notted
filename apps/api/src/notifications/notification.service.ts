import { HttpStatus, Injectable } from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { ApiHttpException } from "../common/errors/api-http.exception";
import { DatabaseService, type DatabaseTransaction } from "../database/database.service";
import { emailDeliveries, notifications, users } from "../database/schema";
import { normalizeRecipient, UNSUBSCRIBE_RELATED_ENTITY_TYPE } from "../email/email-suppression";
import {
  activeWorkspaceId,
  assertActiveWorkspace,
  TenantContextService,
  whereWorkspace,
} from "../tenant";

import type {
  NotificationEmailPreference,
  NotificationKind,
  NotificationPage,
  NotificationReadResult,
  NotificationsMarkAllResult,
  NotificationSummary,
  NotificationTargetType,
} from "@notted/shared-types";

type NotificationRow = typeof notifications.$inferSelect;

@Injectable()
export class NotificationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Part 60 — the single write path into `notifications`. Insert only: a
   * notification is an immutable record of something that already happened, so
   * there is no update or upsert branch here (read-state changes go through
   * `setReadState`/`markAllRead`). `workspaceId` is explicit and proved against
   * the active tenant context before any SQL.
   */
  async emit(input: {
    readonly workspaceId: string;
    readonly recipientUserId: string;
    readonly actorUserId: string | null;
    readonly kind: NotificationKind;
    readonly targetType: NotificationTargetType | null;
    readonly targetId: string | null;
    readonly summary: string;
    readonly targetLabel: string | null;
  }): Promise<NotificationSummary> {
    assertActiveWorkspace(input.workspaceId, this.tenantContext, "notification.emit");
    const [created] = await this.database.db
      .insert(notifications)
      .values({
        workspaceId: input.workspaceId,
        recipientUserId: input.recipientUserId,
        actorUserId: input.actorUserId,
        kind: input.kind,
        targetType: input.targetType,
        targetId: input.targetId,
        summary: input.summary,
        targetLabel: input.targetLabel,
      })
      .returning();
    if (created === undefined) throw new Error("Notification insert returned no row");
    return this.toSummary(created);
  }

  async list(input: {
    readonly recipientUserId: string;
    readonly page: number;
    readonly limit: number;
    readonly unreadOnly: boolean;
  }): Promise<NotificationPage> {
    const offset = (input.page - 1) * input.limit;
    const scope = whereWorkspace(notifications, this.tenantContext);
    const recipient = eq(notifications.recipientUserId, input.recipientUserId);
    const filter = input.unreadOnly
      ? and(scope, recipient, isNull(notifications.readAt))
      : and(scope, recipient);

    const [rows, unreadCount] = await Promise.all([
      this.database.db
        .select()
        .from(notifications)
        .where(filter)
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(input.limit + 1)
        .offset(offset),
      this.countUnread(this.database.db, input.recipientUserId),
    ]);

    return Object.freeze({
      items: Object.freeze(rows.slice(0, input.limit).map((row) => this.toSummary(row))),
      page: input.page,
      limit: input.limit,
      hasMore: rows.length > input.limit,
      unreadCount,
    });
  }

  async setReadState(input: {
    readonly notificationId: string;
    readonly recipientUserId: string;
    readonly isRead: boolean;
  }): Promise<NotificationReadResult> {
    return this.database.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.id, input.notificationId),
            eq(notifications.recipientUserId, input.recipientUserId),
            whereWorkspace(notifications, this.tenantContext),
          ),
        )
        .limit(1);
      if (existing === undefined) this.notFound();

      const [updated] = await tx
        .update(notifications)
        .set({ readAt: input.isRead ? new Date() : null })
        .where(
          and(
            eq(notifications.id, input.notificationId),
            eq(notifications.recipientUserId, input.recipientUserId),
            whereWorkspace(notifications, this.tenantContext),
          ),
        )
        .returning();
      if (updated === undefined) this.notFound();

      return Object.freeze({
        notification: this.toSummary(updated),
        unreadCount: await this.countUnread(tx, input.recipientUserId),
      });
    });
  }

  async markAllRead(recipientUserId: string): Promise<NotificationsMarkAllResult> {
    return this.database.transaction(async (tx) => {
      const updated = await tx
        .update(notifications)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(notifications.recipientUserId, recipientUserId),
            isNull(notifications.readAt),
            whereWorkspace(notifications, this.tenantContext),
          ),
        )
        .returning({ id: notifications.id });
      return Object.freeze({ updatedCount: updated.length, unreadCount: 0 as const });
    });
  }

  /**
   * Switch mention email on or off for the caller in the ACTIVE workspace.
   *
   * The address is resolved from `users` by the authenticated id — a
   * client-supplied address would let anyone mute anyone else's mail.
   */
  async setEmailPreference(input: {
    readonly recipientUserId: string;
    readonly mentionEmail: boolean;
  }): Promise<NotificationEmailPreference> {
    const workspaceId = activeWorkspaceId(this.tenantContext);
    return this.database.transaction(async (tx) => {
      const [user] = await tx
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, input.recipientUserId))
        .limit(1);
      if (user === undefined) this.notFound();
      const recipient = normalizeRecipient(user.email);

      // ponytail: suppression is a sentinel email_deliveries row, not a preference table. Upgrade path: an email_preferences table when Part 72 adds real per-user settings.
      const sentinel = this.mentionSuppressionSentinel(
        workspaceId,
        recipient,
        input.recipientUserId,
      );

      if (input.mentionEmail) {
        await tx.delete(emailDeliveries).where(sentinel);
        return Object.freeze({ mentionEmail: true });
      }

      // Insert only when absent so repeated "off" calls never pile up rows.
      const [existing] = await tx
        .select({ id: emailDeliveries.id })
        .from(emailDeliveries)
        .where(sentinel)
        .limit(1);
      if (existing === undefined) {
        await tx.insert(emailDeliveries).values({
          workspaceId,
          recipient,
          templateKey: "mention",
          status: "suppressed",
          errorMessage: "Recipient disabled this template",
          relatedEntityType: UNSUBSCRIBE_RELATED_ENTITY_TYPE,
          relatedEntityId: input.recipientUserId,
        });
      }
      return Object.freeze({ mentionEmail: false });
    });
  }

  /**
   * Read the caller's mention-email preference in the ACTIVE workspace.
   *
   * The write path shipped without a read path, which left the preference
   * unrenderable: a toggle cannot show its own state, and the mention email
   * links to a settings page. Same address resolution as `setEmailPreference`
   * — from `users` by authenticated id, never from the client.
   */
  async getEmailPreference(input: {
    readonly recipientUserId: string;
  }): Promise<NotificationEmailPreference> {
    const workspaceId = activeWorkspaceId(this.tenantContext);
    const [user] = await this.database.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, input.recipientUserId))
      .limit(1);
    if (user === undefined) this.notFound();

    const [existing] = await this.database.db
      .select({ id: emailDeliveries.id })
      .from(emailDeliveries)
      .where(
        this.mentionSuppressionSentinel(
          workspaceId,
          normalizeRecipient(user.email),
          input.recipientUserId,
        ),
      )
      .limit(1);
    // Absent sentinel means mail is ON. Opt-out, not opt-in: a member who has
    // never touched the toggle still gets mentioned-in-a-note email.
    return Object.freeze({ mentionEmail: existing === undefined });
  }

  /**
   * The ONE definition of "this user has muted mention email here".
   *
   * Shared by the read and the write so they can never drift apart — a reader
   * matching a different row set than the writer deletes is exactly how a user
   * ends up unable to re-subscribe.
   */
  private mentionSuppressionSentinel(
    workspaceId: string,
    normalizedRecipient: string,
    recipientUserId: string,
  ) {
    return and(
      eq(emailDeliveries.workspaceId, workspaceId),
      // `lower(...)` on BOTH sides, matching `isSuppressed` in
      // `email/email-suppression.ts` exactly. A raw `eq` here would read one
      // set of rows and delete another: a mixed-case row written before
      // `normalizeRecipient` existed would still suppress mail while being
      // invisible to "turn mention email back on", stranding that user
      // unsubscribed with no way back.
      sql`lower(${emailDeliveries.recipient}) = ${normalizedRecipient}`,
      eq(emailDeliveries.templateKey, "mention"),
      eq(emailDeliveries.status, "suppressed"),
      eq(emailDeliveries.relatedEntityType, UNSUBSCRIBE_RELATED_ENTITY_TYPE),
      eq(emailDeliveries.relatedEntityId, recipientUserId),
    );
  }

  private async countUnread(
    db: Pick<DatabaseTransaction, "select"> | DatabaseService["db"],
    recipientUserId: string,
  ): Promise<number> {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(notifications)
      .where(
        and(
          eq(notifications.recipientUserId, recipientUserId),
          isNull(notifications.readAt),
          whereWorkspace(notifications, this.tenantContext),
        ),
      );
    return row?.count ?? 0;
  }

  private toSummary(row: NotificationRow): NotificationSummary {
    return Object.freeze({
      id: row.id,
      workspaceId: row.workspaceId,
      kind: row.kind,
      actorId: row.actorUserId,
      targetType: row.targetType,
      targetId: row.targetId,
      summary: row.summary,
      targetLabel: row.targetLabel,
      createdAt: row.createdAt.toISOString(),
      readAt: row.readAt?.toISOString() ?? null,
    });
  }

  private notFound(): never {
    throw new ApiHttpException(HttpStatus.NOT_FOUND, {
      code: "NOT_FOUND",
      message: "The requested resource was not found.",
    });
  }
}
