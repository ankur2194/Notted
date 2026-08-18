import { Body, Controller, Get, HttpStatus, Param, Patch, Post, Query, Req } from "@nestjs/common";
import {
  notificationEmailPreferenceSchema,
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
  NotificationEmailPreference,
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

  // GET as well as POST: the mention email links members to a settings page,
  // and a toggle that cannot read its own state is not a control. Same
  // `WORKSPACE_READ_AUTHORIZATION` as the rest — the preference is the
  // caller's own, resolved from the authenticated id, never from the client.
  @Get("email-preference")
  @RequireAuthorization(WORKSPACE_READ_AUTHORIZATION)
  getEmailPreference(@Req() request: Request): Promise<NotificationEmailPreference> {
    return this.notifications.getEmailPreference({ recipientUserId: this.userId(request) });
  }

  @Post("email-preference")
  @RequireAuthorization(WORKSPACE_READ_AUTHORIZATION)
  setEmailPreference(
    @Req() request: Request,
    @Body() rawBody: unknown,
  ): Promise<NotificationEmailPreference> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = notificationEmailPreferenceSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.notifications.setEmailPreference({
      recipientUserId: this.userId(request),
      mentionEmail: body.data.mentionEmail,
    });
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
