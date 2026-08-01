import { createHash } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gt, isNull, sql } from "drizzle-orm";

import { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import { StructuredLogger } from "../common/logging/structured-logger.service";
import { APP_CONFIG, type AppConfig } from "../config/app.config";
import {
  AUTH_EMAIL_QUEUE_CONFIG,
  type AuthEmailQueueConfig,
} from "../config/auth-email-queue.config";
import { DatabaseService, type DatabaseTransaction } from "../database/database.service";
import {
  emailDeliveries,
  invitations,
  jobIdempotency,
  jobOutbox,
  workspaces,
} from "../database/schema";
import { SmtpService } from "../infrastructure/smtp/smtp.service";
import { TenantContextService, whereWorkspace } from "../tenant";

import { InvitationTokenService } from "./invitation-token.service";
import {
  INVITATION_EMAIL_IDEMPOTENCY_PREFIX,
  INVITATION_EMAIL_QUEUE_NAME,
} from "./memberships.constants";

import type { InvitationEmailJobPayload } from "./invitation-email.types";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

@Injectable()
export class InvitationEmailWorkerService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorizationEntry: AuthorizationEntryService,
    private readonly tenantContext: TenantContextService,
    private readonly tokens: InvitationTokenService,
    private readonly smtp: SmtpService,
    private readonly logger: StructuredLogger,
    @Inject(APP_CONFIG) private readonly appConfig: AppConfig,
    @Inject(AUTH_EMAIL_QUEUE_CONFIG) private readonly config: AuthEmailQueueConfig,
  ) {}

  async process(payload: InvitationEmailJobPayload, finalAttempt: boolean): Promise<void> {
    const [resolved] = await this.database.db
      .select({ workspaceId: invitations.workspaceId })
      .from(invitations)
      .where(eq(invitations.id, payload.invitationId))
      .limit(1);
    if (resolved === undefined) {
      await this.cancel(payload, "INVITATION_NOT_FOUND");
      return;
    }

    const operation = await this.authorizationEntry.authorizeSystem({
      actor: {
        kind: "system",
        authorityId: "invitation-email-worker",
        workspaceId: resolved.workspaceId,
        purpose: "deliver a pending workspace invitation",
        allowedActions: ["member.invite"],
        allowedResourceKinds: ["workspace"],
      },
      action: "member.invite",
      resource: { kind: "workspace" },
      correlationId: payload.deliveryId,
    });
    return this.authorizationEntry.run(operation, async () => {
      const claim = await this.database.transaction((tx) => this.claim(tx, payload));
      if (claim === null) return;

      const token = this.tokens.derive(payload.invitationId);
      const actionUrl = new URL("/invitations/accept", this.appConfig.appUrl);
      actionUrl.searchParams.set("token", token);
      const workspaceName = escapeHtml(claim.workspaceName);
      const escapedUrl = escapeHtml(actionUrl.toString());
      try {
        const providerMessageId = await this.smtp.send({
          to: claim.recipient,
          subject: `Join ${claim.workspaceName} on Notted`,
          text: `You were invited to join ${claim.workspaceName} on Notted: ${actionUrl.toString()}\n\nThis link is single-use and expires in seven days.`,
          html: `<p>You were invited to join <strong>${workspaceName}</strong> on Notted.</p><p><a href="${escapedUrl}">Accept workspace invitation</a></p><p>This link is single-use and expires in seven days.</p>`,
        });
        const now = new Date();
        await this.database.transaction(async (tx) => {
          await tx
            .update(emailDeliveries)
            .set({
              status: "sent",
              attempts: sql`${emailDeliveries.attempts} + 1`,
              providerMessageId,
              sentAt: now,
              errorMessage: null,
            })
            .where(eq(emailDeliveries.id, payload.deliveryId));
          await tx
            .update(jobIdempotency)
            .set({ status: "completed", result: { outcome: "sent" }, updatedAt: now })
            .where(eq(jobIdempotency.key, this.idempotencyKey(payload.invitationId)));
          await tx
            .update(jobOutbox)
            .set({ status: "completed", completedAt: now, updatedAt: now })
            .where(eq(jobOutbox.idempotencyKey, this.idempotencyKey(payload.invitationId)));
        });
        this.logger.info(
          { jobId: payload.invitationId, queue: INVITATION_EMAIL_QUEUE_NAME, outcome: "sent" },
          "Invitation email delivery completed",
        );
      } catch {
        const now = new Date();
        await this.database.transaction(async (tx) => {
          await tx
            .update(emailDeliveries)
            .set({
              status: finalAttempt ? "failed" : "queued",
              attempts: sql`${emailDeliveries.attempts} + 1`,
              errorMessage: finalAttempt ? "Delivery attempts exhausted" : null,
            })
            .where(eq(emailDeliveries.id, payload.deliveryId));
          if (finalAttempt) {
            await tx
              .update(jobIdempotency)
              .set({
                status: "failed",
                errorMessage: "Delivery attempts exhausted",
                updatedAt: now,
              })
              .where(eq(jobIdempotency.key, this.idempotencyKey(payload.invitationId)));
            await tx
              .update(jobOutbox)
              .set({ status: "failed", lastErrorCode: "DELIVERY_FAILED", updatedAt: now })
              .where(eq(jobOutbox.idempotencyKey, this.idempotencyKey(payload.invitationId)));
          }
        });
        throw new Error("Invitation email delivery failed");
      }
    });
  }

  private async claim(
    tx: DatabaseTransaction,
    payload: InvitationEmailJobPayload,
  ): Promise<{ readonly recipient: string; readonly workspaceName: string } | null> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`invitation-id:${payload.invitationId}`}, 0))`,
    );
    const [row] = await tx
      .select({
        recipient: emailDeliveries.recipient,
        deliveryStatus: emailDeliveries.status,
        workspaceName: workspaces.name,
      })
      .from(invitations)
      .innerJoin(workspaces, eq(workspaces.id, invitations.workspaceId))
      .innerJoin(
        emailDeliveries,
        and(
          eq(emailDeliveries.id, payload.deliveryId),
          eq(emailDeliveries.relatedEntityType, "invitation"),
          eq(emailDeliveries.relatedEntityId, invitations.id),
        ),
      )
      .where(
        and(
          eq(invitations.id, payload.invitationId),
          whereWorkspace(invitations, this.tenantContext),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          gt(invitations.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (row === undefined || row.deliveryStatus !== "queued") {
      await this.cancelInTransaction(tx, payload, "INVITATION_NOT_PENDING");
      return null;
    }

    const key = this.idempotencyKey(payload.invitationId);
    const payloadHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const [existing] = await tx
      .select({ status: jobIdempotency.status, payloadHash: jobIdempotency.payloadHash })
      .from(jobIdempotency)
      .where(eq(jobIdempotency.key, key))
      .limit(1);
    if (existing?.status === "completed") return null;
    if (existing !== undefined && existing.payloadHash !== payloadHash) {
      await this.cancelInTransaction(tx, payload, "IDEMPOTENCY_PAYLOAD_MISMATCH");
      return null;
    }
    if (existing === undefined) {
      await tx.insert(jobIdempotency).values({
        key,
        queueName: INVITATION_EMAIL_QUEUE_NAME,
        payloadHash,
        expiresAt: new Date(
          Date.now() + this.config.idempotencyRetentionDays * 24 * 60 * 60 * 1_000,
        ),
      });
    }
    return Object.freeze({ recipient: row.recipient, workspaceName: row.workspaceName });
  }

  private async cancel(payload: InvitationEmailJobPayload, errorCode: string): Promise<void> {
    await this.database.transaction((tx) => this.cancelInTransaction(tx, payload, errorCode));
  }

  private async cancelInTransaction(
    tx: DatabaseTransaction,
    payload: InvitationEmailJobPayload,
    errorCode: string,
  ): Promise<void> {
    const now = new Date();
    await tx
      .update(emailDeliveries)
      .set({ status: "failed", errorMessage: "Invitation is no longer pending" })
      .where(and(eq(emailDeliveries.id, payload.deliveryId), eq(emailDeliveries.status, "queued")));
    await tx
      .update(jobOutbox)
      .set({ status: "cancelled", lastErrorCode: errorCode, updatedAt: now })
      .where(eq(jobOutbox.idempotencyKey, this.idempotencyKey(payload.invitationId)));
  }

  private idempotencyKey(invitationId: string): string {
    return `${INVITATION_EMAIL_IDEMPOTENCY_PREFIX}${invitationId}`;
  }
}
