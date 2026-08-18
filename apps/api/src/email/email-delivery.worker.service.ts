// Part 61 — consumer for the `email.deliver` intent.
//
// The payload carries IDENTIFIERS ONLY. Every human-readable string in the
// rendered message (workspace name, note title, actor name, recipient name) is
// re-read from PostgreSQL here, so a tampered or stale payload can never inject
// content into a mailbox, and nothing content-shaped is ever persisted in Redis.

import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";

import { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import { StructuredLogger } from "../common/logging/structured-logger.service";
import { APP_CONFIG, type AppConfig } from "../config/app.config";
import { FEATURES_CONFIG, type FeaturesConfig } from "../config/features.config";
import { DatabaseService } from "../database/database.service";
import { emailDeliveries, exportJobs, notes, users, workspaces } from "../database/schema";
import { SmtpService } from "../infrastructure/smtp/smtp.service";
import { defineQueueJobRegistration, type QueueJobContext } from "../queue/job-contracts";
import { WORKSPACE_EMAIL_JOB_DEFINITION } from "../queue/job-registry";
import { PermanentQueueJobError } from "../queue/queue-errors";
import { QueueHandlerRegistry } from "../queue/queue-handler-registry.service";

import { resolveBranding, type EmailBranding } from "./email-branding";
import { EmailRendererService } from "./email-renderer.service";
import { type EmailMessage } from "./email-templates";

import type { z } from "zod";

/** Shown when a note has never been given a title. */
const UNTITLED_NOTE = "Untitled";

/** Templates this generic pipeline owns end to end. */
type RoutedTemplateKey = "welcome" | "mention" | "export_ready";

/**
 * Templates this generic pipeline delivers, resolved BEFORE the row is claimed
 * so an unroutable delivery never moves to `processing` and never lands in
 * reconciliation — it is a permanent routing error, not an ambiguous send.
 */
function routedTemplateKey(templateKey: string): RoutedTemplateKey {
  switch (templateKey) {
    case "welcome":
    case "mention":
    case "export_ready":
      return templateKey;
    default:
      // `invitation` and the five auth keys are NOT routed here: they keep
      // their own dedicated pipelines (`WORKSPACE_INVITATION_EMAIL_JOB_DEFINITION`
      // / `AUTH_EMAIL_JOB_DEFINITION`) with their own tokens, claim rules and
      // delivery rows. Accepting one here would send it a second time.
      throw new PermanentQueueJobError("payload_invalid");
  }
}

type WorkspaceEmailContext = QueueJobContext<
  typeof WORKSPACE_EMAIL_JOB_DEFINITION.jobType,
  z.output<typeof WORKSPACE_EMAIL_JOB_DEFINITION.payloadSchema>
>;

interface DeliveryRow {
  readonly recipient: string;
  readonly templateKey: string;
  readonly status: string;
  readonly relatedEntityType: string | null;
  readonly relatedEntityId: string | null;
}

@Injectable()
export class EmailDeliveryQueueHandler implements OnModuleInit, OnModuleDestroy {
  readonly jobType = WORKSPACE_EMAIL_JOB_DEFINITION.jobType;
  private unregister?: () => void;

  constructor(
    private readonly database: DatabaseService,
    private readonly authorizationEntry: AuthorizationEntryService,
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
      defineQueueJobRegistration({ definition: WORKSPACE_EMAIL_JOB_DEFINITION, handler: this }),
    );
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  async handle(context: WorkspaceEmailContext): Promise<void> {
    if (context.payload.intentId !== context.outboxIntentId) {
      throw new PermanentQueueJobError("payload_invalid");
    }
    const { deliveryId, workspaceId } = context.payload;
    // MANDATORY workspace predicate: a tampered cross-tenant `deliveryId` must
    // resolve to zero rows rather than mutate another workspace's record.
    const scope = this.deliveryScope(deliveryId, workspaceId);

    const [row] = await this.database.db
      .select({
        recipient: emailDeliveries.recipient,
        templateKey: emailDeliveries.templateKey,
        status: emailDeliveries.status,
        relatedEntityType: emailDeliveries.relatedEntityType,
        relatedEntityId: emailDeliveries.relatedEntityId,
      })
      .from(emailDeliveries)
      .where(scope)
      .limit(1);
    if (row === undefined) throw new PermanentQueueJobError("handler_failed");
    const templateKey = routedTemplateKey(row.templateKey);

    if (workspaceId === null) {
      // Workspace-less system mail (`welcome`) has no tenant to authorize
      // against; there is no workspace-owned data in the message.
      await this.deliver(context, row, templateKey, scope, null);
      return;
    }

    const operation = await this.authorizationEntry.authorizeSystem({
      actor: {
        kind: "system",
        authorityId: "email-delivery-queue-handler",
        workspaceId,
        purpose: "deliver a queued workspace email",
        allowedActions: ["workspace.read"],
        allowedResourceKinds: ["workspace"],
      },
      action: "workspace.read",
      resource: { kind: "workspace" },
      correlationId: context.correlationId,
    });
    await this.authorizationEntry.run(operation, () =>
      this.deliver(context, row, templateKey, scope, workspaceId),
    );
  }

  /** `id = ? AND workspace_id <is null | = ?>`; reused by every statement. */
  private deliveryScope(deliveryId: string, workspaceId: string | null): SQL {
    const predicate = and(
      eq(emailDeliveries.id, deliveryId),
      workspaceId === null
        ? isNull(emailDeliveries.workspaceId)
        : eq(emailDeliveries.workspaceId, workspaceId),
    );
    // `and(...)` with two concrete predicates is never undefined.
    return predicate as SQL;
  }

  private async deliver(
    context: WorkspaceEmailContext,
    row: DeliveryRow,
    templateKey: RoutedTemplateKey,
    scope: SQL,
    workspaceId: string | null,
  ): Promise<void> {
    const claimed = await this.database.db
      .update(emailDeliveries)
      .set({ status: "processing", errorMessage: null })
      .where(and(scope, eq(emailDeliveries.status, "queued")))
      .returning({ id: emailDeliveries.id });
    if (claimed.length === 0) {
      if (row.status === "processing") {
        // A previous attempt started a send and the process died: the provider
        // may or may not have accepted it, so an operator decides, not a retry.
        await this.database.db
          .update(emailDeliveries)
          .set({
            status: "reconciliation_required",
            errorMessage: "Interrupted delivery requires reconciliation",
          })
          // Status guard: `row.status` was read before the claim attempt, so a
          // concurrent worker may have settled the row in between. Without it a
          // stale read could overwrite a `sent` row with a reconciliation flag.
          .where(and(scope, eq(emailDeliveries.status, "processing")));
        throw new PermanentQueueJobError("reconciliation_required");
      }
      // Terminal row (sent/failed/suppressed/reconciliation_required): this is a
      // replay of an already-settled delivery, not a failure.
      return;
    }

    const workspace = workspaceId === null ? null : await this.loadBrandingWorkspace(workspaceId);
    const branding = resolveBranding(workspace, this.appConfig);

    let providerMessageId: string;
    try {
      // Props building and rendering share the send's catch on purpose: a
      // template bug must land as `reconciliation_required` for an operator
      // rather than as a generic retry that re-enters the claim.
      const message = await this.render(
        templateKey,
        row,
        branding,
        workspaceId,
        context.payload.actorId,
      );
      providerMessageId = await this.smtp.send({
        to: row.recipient,
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
        .where(and(scope, eq(emailDeliveries.status, "processing")));
      // SMTP failures are ambiguous: the provider may have accepted before the
      // connection failed. Never auto-resend this message.
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
      .where(and(scope, eq(emailDeliveries.status, "processing")));
    this.logger.info(
      {
        jobId: context.payload.deliveryId,
        queue: WORKSPACE_EMAIL_JOB_DEFINITION.route.physicalQueueName,
        outcome: "sent",
      },
      "Workspace email delivery completed",
    );
  }

  private async loadBrandingWorkspace(
    workspaceId: string,
  ): Promise<{ name: string; logoUrl: string | null; settings: unknown } | null> {
    const [workspace] = await this.database.db
      .select({
        name: workspaces.name,
        logoUrl: workspaces.logoUrl,
        settings: workspaces.settings,
      })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    return workspace ?? null;
  }

  /**
   * Re-read the subject entity from PostgreSQL and render.
   *
   * `email_deliveries.related_entity_type`/`related_entity_id` are the
   * authoritative subject reference — the payload deliberately carries none.
   */
  private async render(
    templateKey: RoutedTemplateKey,
    row: DeliveryRow,
    branding: EmailBranding,
    workspaceId: string | null,
    actorId: string | undefined,
  ): Promise<EmailMessage> {
    const subjectId = row.relatedEntityId;
    if (subjectId === null) throw new PermanentQueueJobError("payload_invalid");

    switch (templateKey) {
      case "welcome": {
        if (row.relatedEntityType !== "user") {
          throw new PermanentQueueJobError("payload_invalid");
        }
        const [user] = await this.database.db
          .select({ name: users.name })
          .from(users)
          .where(eq(users.id, subjectId))
          .limit(1);
        const name = user?.name.trim() ?? "";
        return this.renderer.render("welcome", {
          branding,
          recipientName: name === "" ? null : name,
        });
      }
      case "mention": {
        if (row.relatedEntityType !== "note" || workspaceId === null || actorId === undefined) {
          throw new PermanentQueueJobError("payload_invalid");
        }
        const [note] = await this.database.db
          .select({ title: notes.title })
          .from(notes)
          .where(and(eq(notes.workspaceId, workspaceId), eq(notes.id, subjectId)))
          .limit(1);
        if (note === undefined) throw new PermanentQueueJobError("payload_invalid");
        const [actor] = await this.database.db
          .select({ name: users.name })
          .from(users)
          .where(eq(users.id, actorId))
          .limit(1);
        const title = note.title.trim();
        return this.renderer.render("mention", {
          branding,
          actorName: actor?.name.trim() ?? "",
          noteTitle: title === "" ? UNTITLED_NOTE : title,
          noteUrl: new URL(
            `/workspaces/${workspaceId}/notes/${subjectId}`,
            this.appConfig.appUrl,
          ).toString(),
          preferenceUrl: new URL(
            `/workspaces/${workspaceId}/settings`,
            this.appConfig.appUrl,
          ).toString(),
        });
      }
      case "export_ready": {
        if (row.relatedEntityType !== "export" || workspaceId === null) {
          throw new PermanentQueueJobError("payload_invalid");
        }
        const [exportRow] = await this.database.db
          .select({
            format: exportJobs.format,
            status: exportJobs.status,
            sourceId: exportJobs.sourceId,
            signedUrlExpiresAt: exportJobs.signedUrlExpiresAt,
          })
          .from(exportJobs)
          .where(and(eq(exportJobs.workspaceId, workspaceId), eq(exportJobs.id, subjectId)))
          .limit(1);
        if (exportRow === undefined) throw new PermanentQueueJobError("payload_invalid");
        // A MAILBOX IS PERSISTENCE — DO NOT EMAIL A DEAD LINK.
        //
        // The export was cancelled, failed, or expired between the producer
        // committing the intent and this worker draining it. Sending anyway
        // would put a permanent pointer to a non-existent artefact in someone's
        // inbox, where it outlives every retention policy we control.
        //
        // PERMANENT, not retryable: `status` never returns to `ready` (the
        // state machine has no edge back), so a retry can only fail again. The
        // delivery row lands in `reconciliation_required`, which is exactly
        // where an operator can see that a notice was deliberately withheld.
        // The same reasoning covers an elapsed download grant on an otherwise
        // `ready` row — the cleanup job simply has not flipped it yet.
        if (
          exportRow.status !== "ready" ||
          (exportRow.signedUrlExpiresAt !== null && exportRow.signedUrlExpiresAt <= new Date())
        ) {
          throw new PermanentQueueJobError("payload_invalid");
        }
        // The source note is re-read workspace-scoped like every other subject;
        // when it is gone (or the export had no note source) the workspace name
        // is the honest generic label rather than a fabricated title.
        let subjectLabel = branding.name;
        if (exportRow.sourceId !== null) {
          const [note] = await this.database.db
            .select({ title: notes.title })
            .from(notes)
            .where(and(eq(notes.workspaceId, workspaceId), eq(notes.id, exportRow.sourceId)))
            .limit(1);
          if (note !== undefined) {
            const title = note.title.trim();
            subjectLabel = title === "" ? UNTITLED_NOTE : title;
          }
        }
        return this.renderer.render("export_ready", {
          branding,
          format: exportRow.format.toUpperCase(),
          // A LOGIN-GATED APP PAGE, NEVER A SIGNED URL AND NEVER THE
          // `/api/v1/.../download` ROUTE. ADR 0005 keeps signed URLs out of
          // persistence, and a mailbox is persistence: anyone who later reads
          // the message — a forwarded copy, a shared inbox, a breached
          // archive — must still have to authenticate to get the bytes.
          //
          // ponytail: the `apps/web` route for a single export lands in a later
          // part, so today this resolves to the app shell rather than a
          // dedicated page. Ceiling: one extra click for the recipient.
          // Upgrade path: build the page, the URL shape does not change.
          exportUrl: new URL(
            `/workspaces/${workspaceId}/exports/${subjectId}`,
            this.appConfig.appUrl,
          ).toString(),
          subjectLabel,
        });
      }
    }
  }
}
