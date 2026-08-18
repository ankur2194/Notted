import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";

import { StructuredLogger } from "../common/logging/structured-logger.service";
import { APP_CONFIG, type AppConfig } from "../config/app.config";
import { FEATURES_CONFIG, type FeaturesConfig } from "../config/features.config";
import { DatabaseService } from "../database/database.service";
import { authEmailIntents, emailDeliveries, type AuthEmailPurpose } from "../database/schema";
import { resolveBranding } from "../email/email-branding";
import { EmailRendererService } from "../email/email-renderer.service";
import { SmtpService } from "../infrastructure/smtp/smtp.service";
import { defineQueueJobRegistration, type QueueJobContext } from "../queue/job-contracts";
import { AUTH_EMAIL_JOB_DEFINITION } from "../queue/job-registry";
import { PermanentQueueJobError } from "../queue/queue-errors";
import { QueueHandlerRegistry } from "../queue/queue-handler-registry.service";

import { AuthEmailEncryptionService } from "./auth-email-encryption.service";

import type { EmailMessage } from "../email/email-templates";
import type { z } from "zod";

type AuthEmailJobContext = QueueJobContext<
  typeof AUTH_EMAIL_JOB_DEFINITION.jobType,
  z.output<typeof AUTH_EMAIL_JOB_DEFINITION.payloadSchema>
>;

/** Concrete shared-runtime handler for encrypted authentication email intent. */
@Injectable()
export class AuthEmailQueueHandler implements OnModuleInit, OnModuleDestroy {
  private unregister?: () => void;

  constructor(
    private readonly database: DatabaseService,
    private readonly encryption: AuthEmailEncryptionService,
    private readonly renderer: EmailRendererService,
    private readonly smtp: SmtpService,
    private readonly logger: StructuredLogger,
    private readonly registry: QueueHandlerRegistry,
    @Inject(APP_CONFIG) private readonly appConfig: AppConfig,
    @Inject(FEATURES_CONFIG) private readonly features: FeaturesConfig,
  ) {}

  onModuleInit(): void {
    if (!this.features.emailEnabled) return;
    this.unregister = this.registry.register(
      defineQueueJobRegistration({ definition: AUTH_EMAIL_JOB_DEFINITION, handler: this }),
    );
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  readonly jobType = AUTH_EMAIL_JOB_DEFINITION.jobType;

  async handle(context: AuthEmailJobContext): Promise<void> {
    const intentId = context.payload.intentId;
    const rows = await this.database.db
      .select({ intent: authEmailIntents, delivery: emailDeliveries })
      .from(authEmailIntents)
      .innerJoin(emailDeliveries, eq(authEmailIntents.deliveryId, emailDeliveries.id))
      .where(eq(authEmailIntents.id, intentId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) throw new Error("Auth email intent is unavailable");
    if (
      row.intent.status === "sent" ||
      row.intent.status === "cancelled" ||
      row.intent.status === "expired"
    ) {
      return;
    }
    if (row.intent.status === "processing") {
      // SMTP may have accepted a previous attempt before its promise rejected or
      // the process died. Never replay across that ambiguous acceptance boundary.
      await this.markReconciliationRequired(row.intent.id, row.delivery.id);
      throw new PermanentQueueJobError("reconciliation_required");
    }
    if (row.intent.status === "failed") return;
    if (row.intent.expiresAt.getTime() <= Date.now()) {
      await this.markExpired(row.intent.id, row.delivery.id);
      return;
    }

    const claimed = await this.database.db
      .update(authEmailIntents)
      .set({ status: "processing", updatedAt: new Date() })
      .where(and(eq(authEmailIntents.id, intentId), eq(authEmailIntents.status, "pending")))
      .returning({ id: authEmailIntents.id });
    if (claimed.length === 0) return;

    const decrypted = this.encryption.decrypt(
      {
        encryptedContext: row.intent.encryptedContext,
        encryptionKeyVersion: row.intent.encryptionKeyVersion,
        nonce: row.intent.nonce,
        authenticationTag: row.intent.authenticationTag,
      },
      { intentId: row.intent.id, purpose: row.intent.purpose, expiresAt: row.intent.expiresAt },
    );

    let message: EmailMessage;
    try {
      message = await this.renderMessage(row.intent.purpose, decrypted.actionUrl);
    } catch {
      // Nothing was handed to the provider, so no attempt is counted. A template
      // bug is still permanent business state an operator resolves, never a
      // retry that could re-enter the claim.
      await this.markReconciliationRequired(row.intent.id, row.delivery.id);
      throw new PermanentQueueJobError("reconciliation_required");
    }

    try {
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
          .where(
            and(eq(emailDeliveries.id, row.delivery.id), eq(emailDeliveries.status, "queued")),
          );
      });
      this.logger.info(
        {
          jobId: intentId,
          queue: AUTH_EMAIL_JOB_DEFINITION.route.physicalQueueName,
          outcome: "sent",
        },
        "Auth email delivery completed",
      );
    } catch {
      // Keep `processing`: provider acceptance is ambiguous after send starts.
      // Generic retry/DLQ owns execution failure; an operator reconciles this
      // business state rather than risking a duplicate credential email.
      await this.markReconciliationRequired(row.intent.id, row.delivery.id, true);
      throw new PermanentQueueJobError("reconciliation_required");
    }
  }

  /**
   * The five `AuthEmailPurpose` values ARE the template keys, so the purpose
   * indexes straight into the renderer. Auth mail is workspace-less: it always
   * carries platform branding.
   */
  private renderMessage(
    purpose: AuthEmailPurpose,
    actionUrl: string | undefined,
  ): Promise<EmailMessage> {
    const branding = resolveBranding(null, this.appConfig);
    if (purpose === "password_reset_confirmation") {
      return this.renderer.render("password_reset_confirmation", { branding });
    }
    // The remaining four purposes are action mail by definition; a missing URL
    // is a corrupt intent, not a renderable message.
    if (actionUrl === undefined) throw new Error("Auth email action URL is missing");
    return this.renderer.render(purpose, { branding, actionUrl });
  }

  private async markReconciliationRequired(
    intentId: string,
    deliveryId: string,
    incrementAttempt = false,
  ): Promise<void> {
    const now = new Date();
    await this.database.transaction(async (tx) => {
      await tx
        .update(authEmailIntents)
        .set({
          status: "failed",
          terminalAt: now,
          lastErrorCode: "RECONCILIATION_REQUIRED",
          updatedAt: now,
        })
        .where(and(eq(authEmailIntents.id, intentId), eq(authEmailIntents.status, "processing")));
      await tx
        .update(emailDeliveries)
        .set({
          status: "reconciliation_required",
          errorMessage: "Delivery outcome requires reconciliation",
          ...(incrementAttempt ? { attempts: sql`${emailDeliveries.attempts} + 1` } : {}),
        })
        .where(and(eq(emailDeliveries.id, deliveryId), eq(emailDeliveries.status, "queued")));
    });
  }

  private async markExpired(intentId: string, deliveryId: string): Promise<void> {
    const now = new Date();
    await this.database.transaction(async (tx) => {
      await tx
        .update(authEmailIntents)
        .set({ status: "expired", terminalAt: now, lastErrorCode: "EXPIRED", updatedAt: now })
        .where(and(eq(authEmailIntents.id, intentId), eq(authEmailIntents.status, "pending")));
      await tx
        .update(emailDeliveries)
        .set({ status: "failed", errorMessage: "Delivery expired" })
        .where(and(eq(emailDeliveries.id, deliveryId), eq(emailDeliveries.status, "queued")));
    });
  }
}
