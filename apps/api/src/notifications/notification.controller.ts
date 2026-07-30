import { Body, Controller, Get, HttpStatus, Param, Patch, Post, Query, Req } from "@nestjs/common";
import {
  notificationListQuerySchema,
  notificationReadStateSchema,
  uuidSchema,
} from "@notted/shared-validators";

import { getAuthPrincipal } from "../auth/auth-principal";
import { AuthService } from "../auth/auth.service";
import { RequireAuthorization } from "../authorization/authorization-http.decorator";
import { ApiHttpException } from "../common/errors/api-http.exception";

import { NotificationService } from "./notification.service";

import type {
  NotificationPage,
  NotificationReadResult,
  NotificationsMarkAllResult,
} from "@notted/shared-types";
import type { Request } from "express";

function validatedWorkspaceId(request: Request): string {
  return uuidSchema.parse(request.params.workspaceId);
}

const WORKSPACE_READ_AUTHORIZATION = {
  action: "workspace.read" as const,
  workspaceId: validatedWorkspaceId,
  resource: () => ({ kind: "workspace" as const }),
};

@Controller("workspaces/:workspaceId/notifications")
export class NotificationController {
  constructor(
    private readonly notifications: NotificationService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  @RequireAuthorization(WORKSPACE_READ_AUTHORIZATION)
  list(@Req() request: Request, @Query() rawQuery: unknown): Promise<NotificationPage> {
    const query = notificationListQuerySchema.safeParse(rawQuery);
    if (!query.success) this.invalid();
    return this.notifications.list({
      recipientUserId: this.userId(request),
      page: query.data.page,
      limit: query.data.limit,
      unreadOnly: query.data.unreadOnly,
    });
  }

  @Post("read-all")
  @RequireAuthorization(WORKSPACE_READ_AUTHORIZATION)
  markAllRead(@Req() request: Request): Promise<NotificationsMarkAllResult> {
    this.auth.assertTrustedMutationOrigin(request);
    return this.notifications.markAllRead(this.userId(request));
  }

  @Patch(":notificationId")
  @RequireAuthorization(WORKSPACE_READ_AUTHORIZATION)
  setReadState(
    @Req() request: Request,
    @Param("notificationId") rawNotificationId: string,
    @Body() rawBody: unknown,
  ): Promise<NotificationReadResult> {
    this.auth.assertTrustedMutationOrigin(request);
    const notificationId = uuidSchema.safeParse(rawNotificationId);
    const body = notificationReadStateSchema.safeParse(rawBody);
    if (!notificationId.success || !body.success) this.invalid();
    return this.notifications.setReadState({
      notificationId: notificationId.data,
      recipientUserId: this.userId(request),
      isRead: body.data.isRead,
    });
  }

  private userId(request: Request): string {
    const principal = getAuthPrincipal(request);
    if (principal === undefined) throw new Error("Authorization guard did not attach a principal");
    return principal.userId;
  }

  private invalid(): never {
    throw new ApiHttpException(HttpStatus.BAD_REQUEST, {
      code: "VALIDATION_ERROR",
      message: "The request is invalid.",
    });
  }
}
