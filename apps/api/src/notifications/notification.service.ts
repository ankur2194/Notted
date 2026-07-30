import { HttpStatus, Injectable } from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { ApiHttpException } from "../common/errors/api-http.exception";
import { DatabaseService, type DatabaseTransaction } from "../database/database.service";
import { notifications } from "../database/schema";
import { TenantContextService, whereWorkspace } from "../tenant";

import type {
  NotificationPage,
  NotificationReadResult,
  NotificationsMarkAllResult,
  NotificationSummary,
} from "@notted/shared-types";

type NotificationRow = typeof notifications.$inferSelect;

@Injectable()
export class NotificationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly tenantContext: TenantContextService,
  ) {}

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
