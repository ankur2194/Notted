import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import { StructuredLogger } from "../common/logging/structured-logger.service";
import { APP_CONFIG, type AppConfig } from "../config/app.config";
import { FEATURES_CONFIG, type FeaturesConfig } from "../config/features.config";
import { DatabaseService, type DatabaseTransaction } from "../database/database.service";
import { emailDeliveries, invitations, workspaces } from "../database/schema";
import { resolveBranding } from "../email/email-branding";
import { EmailRendererService } from "../email/email-renderer.service";
import { SmtpService } from "../infrastructure/smtp/smtp.service";
import { defineQueueJobRegistration, type QueueJobContext } from "../queue/job-contracts";
import { WORKSPACE_INVITATION_EMAIL_JOB_DEFINITION } from "../queue/job-registry";
import { PermanentQueueJobError } from "../queue/queue-errors";
import { QueueHandlerRegistry } from "../queue/queue-handler-registry.service";
import { TenantContextService, whereWorkspace } from "../tenant";

import { InvitationTokenService } from "./invitation-token.service";

import type { BrandingWorkspaceRow } from "../email/email-branding";

const invitationResourceIdsSchema = z.tuple([z.string().uuid(), z.string().uuid()]).readonly();

type InvitationQueueContext = QueueJobContext<
  typeof WORKSPACE_INVITATION_EMAIL_JOB_DEFINITION.jobType,
  z.output<typeof WORKSPACE_INVITATION_EMAIL_JOB_DEFINITION.payloadSchema>
>;

interface InvitationIdentifiers {
  readonly workspaceId: string;
  readonly invitationId: string;
  readonly deliveryId: string;
}

/** Tenant-scoped concrete handler on the shared default BullMQ lane. */
@Injectable()
export class InvitationEmailQueueHandler implements OnModuleInit, OnModuleDestroy {
  readonly jobType = WORKSPACE_INVITATION_EMAIL_JOB_DEFINITION.jobType;
  private unregister?: () => void;

  constructor(
    private readonly database: DatabaseService,
    private readonly authorizationEntry: AuthorizationEntryService,
    private readonly tenantContext: TenantContextService,
    private readonly tokens: InvitationTokenService,
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
      defineQueueJobRegistration({
        definition: WORKSPACE_INVITATION_EMAIL_JOB_DEFINITION,
        handler: this,
      }),
    );
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  async handle(context: InvitationQueueContext): Promise<void> {
    if (context.payload.intentId !== context.outboxIntentId) {
      throw new PermanentQueueJobError("payload_invalid");
    }
    const parsedIds = invitationResourceIdsSchema.safeParse(context.payload.resourceIds);
    if (!parsedIds.success) throw new PermanentQueueJobError("payload_invalid");
    const [invitationId, deliveryId] = parsedIds.data;
    const identifiers = { workspaceId: context.payload.workspaceId, invitationId, deliveryId };

    // Resolve the invitation and workspace relationship in one bounded query.
    // A missing row and a cross-workspace tamper share the same safe failure.
    const [resolved] = await this.database.db
      .select({ workspaceId: invitations.workspaceId })
      .from(invitations)
      .innerJoin(workspaces, eq(workspaces.id, invitations.workspaceId))
      .where(
        and(
          eq(invitations.id, identifiers.invitationId),
          eq(invitations.workspaceId, identifiers.workspaceId),
        ),
      )
      .limit(1);
    if (resolved === undefined) throw new PermanentQueueJobError("handler_failed");

    const operation = await this.authorizationEntry.authorizeSystem({
      actor: {
        kind: "system",
        authorityId: "invitation-email-queue-handler",
        workspaceId: resolved.workspaceId,
        purpose: "deliver a pending workspace invitation",
        allowedActions: ["member.invite"],
        allowedResourceKinds: ["workspace"],
      },
      action: "member.invite",
      resource: { kind: "workspace" },
      correlationId: context.correlationId,
    });

    await this.authorizationEntry.run(operation, async () => {
      const claim = await this.database.transaction((tx) => this.claim(tx, identifiers));
      if (claim === null) return;

      const token = this.tokens.derive(identifiers.invitationId);
      const actionUrl = new URL("/invitations/accept", this.appConfig.appUrl);
      actionUrl.searchParams.set("token", token);
      let providerMessageId: string;
      try {
        // Rendering shares the send's catch on purpose: a template bug must land
        // as `reconciliation_required` for an operator, exactly like an
        // ambiguous provider failure.
        const message = await this.renderer.render("invitation", {
          branding: resolveBranding(claim.workspace, this.appConfig),
          workspaceName: claim.workspaceName,
          actionUrl: actionUrl.toString(),
        });
        providerMessageId = await this.smtp.send({
          to: claim.recipient,
          subject: message.subject,
          text: message.text,
          html: message.html,
        });
      } catch {
        await this.database.db
          .update(emailDeliveries)
          .set({
            status: "reconciliation_required",
            attempts: sql`${emailDeliveries.attempts} + 1`,
            errorMessage: "Provider outcome requires reconciliation",
          })
          .where(
            and(
              eq(emailDeliveries.id, identifiers.deliveryId),
              eq(emailDeliveries.workspaceId, identifiers.workspaceId),
              eq(emailDeliveries.relatedEntityType, "invitation"),
              eq(emailDeliveries.relatedEntityId, identifiers.invitationId),
              eq(emailDeliveries.status, "processing"),
            ),
          );
        // SMTP failures are ambiguous: the provider may have accepted before
        // the connection failed. Never auto-resend this invitation.
        throw new PermanentQueueJobError("reconciliation_required");
      }
      await this.database.db
        .update(emailDeliveries)
        .set({
          status: "sent",
          attempts: sql`${emailDeliveries.attempts} + 1`,
          providerMessageId,
          sentAt: new Date(),
          errorMessage: null,
        })
        .where(
          and(
            eq(emailDeliveries.id, identifiers.deliveryId),
            eq(emailDeliveries.workspaceId, identifiers.workspaceId),
            eq(emailDeliveries.relatedEntityType, "invitation"),
            eq(emailDeliveries.relatedEntityId, identifiers.invitationId),
            eq(emailDeliveries.status, "processing"),
          ),
        );
      this.logger.info(
        {
          jobId: identifiers.invitationId,
          queue: WORKSPACE_INVITATION_EMAIL_JOB_DEFINITION.route.physicalQueueName,
          outcome: "sent",
        },
        "Invitation email delivery completed",
      );
    });
  }

  private async claim(
    tx: DatabaseTransaction,
    identifiers: InvitationIdentifiers,
  ): Promise<{
    readonly recipient: string;
    readonly workspaceName: string;
    /** Branding columns from the workspace join this query already performs. */
    readonly workspace: BrandingWorkspaceRow;
  } | null> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`invitation-id:${identifiers.invitationId}`}, 0))`,
    );
    const [row] = await tx
      .select({
        recipient: emailDeliveries.recipient,
        deliveryStatus: emailDeliveries.status,
        workspaceName: workspaces.name,
        workspaceLogoUrl: workspaces.logoUrl,
        workspaceSettings: workspaces.settings,
      })
      .from(invitations)
      .innerJoin(workspaces, eq(workspaces.id, invitations.workspaceId))
      .innerJoin(
        emailDeliveries,
        and(
          eq(emailDeliveries.id, identifiers.deliveryId),
          eq(emailDeliveries.workspaceId, identifiers.workspaceId),
          eq(emailDeliveries.relatedEntityType, "invitation"),
          eq(emailDeliveries.relatedEntityId, invitations.id),
        ),
      )
      .where(
        and(
          eq(invitations.id, identifiers.invitationId),
          eq(invitations.workspaceId, identifiers.workspaceId),
          whereWorkspace(invitations, this.tenantContext),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          gt(invitations.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (row === undefined) {
      // Relationship predicates prevent a tampered delivery identifier from
      // mutating another invitation or tenant. Active-state failures converge
      // the authoritative delivery to a safe terminal state.
      await tx
        .update(emailDeliveries)
        .set({ status: "failed", errorMessage: "Invitation is no longer pending" })
        .where(
          and(
            eq(emailDeliveries.id, identifiers.deliveryId),
            eq(emailDeliveries.workspaceId, identifiers.workspaceId),
            eq(emailDeliveries.relatedEntityType, "invitation"),
            eq(emailDeliveries.relatedEntityId, identifiers.invitationId),
            eq(emailDeliveries.status, "queued"),
          ),
        );
      return null;
    }
    if (row.deliveryStatus === "processing") {
      await tx
        .update(emailDeliveries)
        .set({
          status: "reconciliation_required",
          errorMessage: "Interrupted delivery requires reconciliation",
        })
        .where(eq(emailDeliveries.id, identifiers.deliveryId));
      return null;
    }
    if (row.deliveryStatus !== "queued") return null;
    await tx
      .update(emailDeliveries)
      .set({ status: "processing", errorMessage: null })
      .where(
        and(
          eq(emailDeliveries.id, identifiers.deliveryId),
          eq(emailDeliveries.workspaceId, identifiers.workspaceId),
          eq(emailDeliveries.status, "queued"),
        ),
      );
    return Object.freeze({
      recipient: row.recipient,
      workspaceName: row.workspaceName,
      workspace: Object.freeze({
        name: row.workspaceName,
        logoUrl: row.workspaceLogoUrl,
        settings: row.workspaceSettings,
      }),
    });
  }
}
