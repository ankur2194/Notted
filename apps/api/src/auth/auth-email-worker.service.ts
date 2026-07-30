import { createHash } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";

import { StructuredLogger } from "../common/logging/structured-logger.service";
import {
  AUTH_EMAIL_QUEUE_CONFIG,
  type AuthEmailQueueConfig,
} from "../config/auth-email-queue.config";
import { DatabaseService } from "../database/database.service";
import {
  authEmailIntents,
  emailDeliveries,
  jobIdempotency,
  jobOutbox,
  type AuthEmailPurpose,
} from "../database/schema";
import { SmtpService } from "../infrastructure/smtp/smtp.service";

import { AuthEmailEncryptionService } from "./auth-email-encryption.service";

function renderAuthEmail(
  purpose: AuthEmailPurpose,
  actionUrl: string | undefined,
): { readonly subject: string; readonly text: string; readonly html: string } {
  const labels: Record<AuthEmailPurpose, string> = {
    registration_verification: "Verify your Notted email",
    verification_resend: "Verify your Notted email",
    magic_link: "Your Notted magic link",
    password_reset_request: "Reset your Notted password",
    password_reset_confirmation: "Your Notted password was reset",
  };
  const subject = labels[purpose];
  if (actionUrl === undefined) {
    const text = "Your Notted password was reset. If this was not you, contact your administrator.";
    return { subject, text, html: `<p>${text}</p>` };
  }
  const text = `${subject}: ${actionUrl}\n\nThis link is single-use and expires soon.`;
  const escapedUrl = actionUrl
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return {
    subject,
    text,
    html: `<p>${subject}</p><p><a href="${escapedUrl}">Continue to Notted</a></p><p>This link is single-use and expires soon.</p>`,
  };
}

@Injectable()
export class AuthEmailWorkerService {
  constructor(
    private readonly database: DatabaseService,
    private readonly encryption: AuthEmailEncryptionService,
    private readonly smtp: SmtpService,
    private readonly logger: StructuredLogger,
    @Inject(AUTH_EMAIL_QUEUE_CONFIG) private readonly config: AuthEmailQueueConfig,
  ) {}

  async process(intentId: string, finalAttempt: boolean): Promise<void> {
    const rows = await this.database.db
      .select({ intent: authEmailIntents, delivery: emailDeliveries })
      .from(authEmailIntents)
      .innerJoin(emailDeliveries, eq(authEmailIntents.deliveryId, emailDeliveries.id))
      .where(eq(authEmailIntents.id, intentId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new Error("Auth email intent was not found");
    }
    if (row.intent.status === "sent" || row.intent.status === "cancelled") {
      return;
    }
    if (row.intent.status === "processing") {
      // A prior process may have crossed the SMTP acceptance boundary. Do not
      // replay automatically: duplicate prevention takes precedence and an
      // operator can reconcile this rare ambiguous state.
      throw new Error("Auth email intent requires reconciliation");
    }
    if (row.intent.expiresAt.getTime() <= Date.now()) {
      await this.markExpired(row.intent.id, row.delivery.id);
      return;
    }

    const claimed = await this.database.db
      .update(authEmailIntents)
      .set({ status: "processing", updatedAt: new Date() })
      .where(and(eq(authEmailIntents.id, intentId), eq(authEmailIntents.status, "pending")))
      .returning({ id: authEmailIntents.id });
    if (claimed.length === 0) {
      return;
    }

    const idempotencyKey = `auth-email:${intentId}`;
    const payloadHash = createHash("sha256").update(JSON.stringify({ intentId })).digest("hex");
    const expiresAt = new Date(
      Date.now() + this.config.idempotencyRetentionDays * 24 * 60 * 60 * 1_000,
    );
    await this.database.db
      .insert(jobIdempotency)
      .values({ key: idempotencyKey, queueName: this.config.queueName, payloadHash, expiresAt })
      .onConflictDoNothing({ target: jobIdempotency.key });

    try {
      const context = this.encryption.decrypt(
        {
          encryptedContext: row.intent.encryptedContext,
          encryptionKeyVersion: row.intent.encryptionKeyVersion,
          nonce: row.intent.nonce,
          authenticationTag: row.intent.authenticationTag,
        },
        {
          intentId: row.intent.id,
          purpose: row.intent.purpose,
          expiresAt: row.intent.expiresAt,
        },
      );
      const message = renderAuthEmail(row.intent.purpose, context.actionUrl);
      const providerMessageId = await this.smtp.send({
        to: row.delivery.recipient,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
      const now = new Date();
      await this.database.transaction(async (tx) => {
        await tx
          .update(authEmailIntents)
          .set({ status: "sent", consumedAt: now, terminalAt: now, updatedAt: now })
          .where(and(eq(authEmailIntents.id, intentId), eq(authEmailIntents.status, "processing")));
        await tx
          .update(emailDeliveries)
          .set({
            status: "sent",
            attempts: sql`${emailDeliveries.attempts} + 1`,
            providerMessageId,
            sentAt: now,
            errorMessage: null,
          })
          .where(eq(emailDeliveries.id, row.delivery.id));
        await tx
          .update(jobIdempotency)
          .set({ status: "completed", result: { outcome: "sent" }, updatedAt: now })
          .where(eq(jobIdempotency.key, idempotencyKey));
        await tx
          .update(jobOutbox)
          .set({ status: "completed", completedAt: now, updatedAt: now })
          .where(eq(jobOutbox.idempotencyKey, idempotencyKey));
      });
      this.logger.info(
        { jobId: intentId, queue: this.config.queueName, outcome: "sent" },
        "Auth email delivery completed",
      );
    } catch {
      const now = new Date();
      await this.database.transaction(async (tx) => {
        await tx
          .update(authEmailIntents)
          .set(
            finalAttempt
              ? {
                  status: "failed",
                  terminalAt: now,
                  lastErrorCode: "DELIVERY_FAILED",
                  updatedAt: now,
                }
              : { status: "pending", lastErrorCode: "DELIVERY_RETRY", updatedAt: now },
          )
          .where(and(eq(authEmailIntents.id, intentId), eq(authEmailIntents.status, "processing")));
        await tx
          .update(emailDeliveries)
          .set({
            status: finalAttempt ? "failed" : "queued",
            attempts: sql`${emailDeliveries.attempts} + 1`,
            errorMessage: finalAttempt ? "Delivery attempts exhausted" : null,
          })
          .where(eq(emailDeliveries.id, row.delivery.id));
        if (finalAttempt) {
          await tx
            .update(jobIdempotency)
            .set({ status: "failed", errorMessage: "Delivery attempts exhausted", updatedAt: now })
            .where(eq(jobIdempotency.key, idempotencyKey));
          await tx
            .update(jobOutbox)
            .set({ status: "failed", lastErrorCode: "DELIVERY_FAILED", updatedAt: now })
            .where(eq(jobOutbox.idempotencyKey, idempotencyKey));
        }
      });
      throw new Error("Auth email delivery failed");
    }
  }

  private async markExpired(intentId: string, deliveryId: string): Promise<void> {
    const now = new Date();
    await this.database.transaction(async (tx) => {
      await tx
        .update(authEmailIntents)
        .set({ status: "expired", terminalAt: now, lastErrorCode: "EXPIRED", updatedAt: now })
        .where(eq(authEmailIntents.id, intentId));
      await tx
        .update(emailDeliveries)
        .set({ status: "failed", errorMessage: "Delivery expired" })
        .where(eq(emailDeliveries.id, deliveryId));
      await tx
        .update(jobOutbox)
        .set({ status: "cancelled", lastErrorCode: "EXPIRED", updatedAt: now })
        .where(eq(jobOutbox.idempotencyKey, `auth-email:${intentId}`));
    });
  }
}
