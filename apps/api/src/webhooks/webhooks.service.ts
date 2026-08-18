// Part 66 — outbound webhooks: the application service.
//
// TENANT SCOPE. `webhooks` is workspace-owned, so every statement here carries
// `whereWorkspace(webhooks, tenantContext)` and every single-row statement also
// pins the id (ADR 0009). A foreign id is a 404, never a 403: existence itself
// must not leak across workspaces. `webhook_deliveries` carries no
// `workspace_id` of its own, so it is scoped through its endpoint.
//
// THE SECRET. `encryptedSecret` is never selected into a DTO, never audited and
// never logged. The safe projection is built BY CONSTRUCTION — an explicit
// `select({...})` that simply has no such key — rather than by deleting a field
// after the fact, which is one refactor away from leaking. The raw secret
// exists in exactly two places in the whole system: the value returned by
// `create` and the value returned by `rotateSecret`.
//
// THE URL VERDICT IS ALWAYS SERVER-SIDE. `webhookUrlSchema` is syntax only; it
// cannot see DNS, the deployment environment, or our own hostnames. Every write
// path that accepts a URL re-runs `inspectWebhookUrl` + `resolveWebhookHost`
// here, and a client's opinion is never an input to that decision.

import { createHash, randomBytes, randomUUID } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import {
  WEBHOOK_DELIVERY_ERROR_CODES,
  WEBHOOK_ENDPOINT_LIMIT,
  WEBHOOK_EVENTS,
  WEBHOOK_VERIFICATION_EVENT,
  type AuthenticatedPrincipal,
  type WebhookCreateResult,
  type WebhookDelivery,
  type WebhookDeleteResult,
  type WebhookDeliveryErrorCode,
  type WebhookDeliveryPage,
  type WebhookDeliveryStatus,
  type WebhookEndpoint,
  type WebhookEndpointPage,
  type WebhookEvent,
  type WebhookRetryResult,
  type WebhookSecretRotationResult,
  type WebhookVerificationResult,
} from "@notted/shared-types";
import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";

import { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import { ApiHttpException } from "../common/errors/api-http.exception";
import { APP_CONFIG, type AppConfig } from "../config/app.config";
import { SECURITY_CONFIG, type SecurityConfig } from "../config/security.config";
import { DatabaseService, type DatabaseTransaction } from "../database/database.service";
import { auditLogs, jobOutbox, webhookDeliveries, webhooks } from "../database/schema";
import { DOMAIN_JOB_TYPES } from "../queue/job-identifiers";
import { WEBHOOK_DELIVER_JOB_DEFINITION } from "../queue/job-registry";
import {
  activeWorkspaceId,
  assertWorkspaceInsertValues,
  TenantContextService,
  whereWorkspace,
} from "../tenant";

import { WebhookDeliveryProducer, type WebhookDeliverPayload } from "./webhook-delivery.producer";
import { WebhookSecretService } from "./webhook-secret.service";
import { sendWebhook } from "./webhook-sender";
import { signatureHeader, webhookBody } from "./webhook-signature";
import { inspectWebhookUrl, resolveWebhookHost } from "./webhook-url-guard";
import {
  WEBHOOK_AUDIT_ACTIONS,
  WEBHOOK_AUDIT_ENTITY_TYPE,
  WEBHOOK_USER_AGENT,
  WEBHOOK_VERIFY_TIMEOUT_MS,
} from "./webhooks.constants";

import type { WebhookUrlGuardOptions } from "./webhook-url-guard";

/**
 * The one place the guard's options are assembled, so the verification probe
 * and the delivery worker can never disagree about what counts as a legal
 * destination. `selfHostnames` is what stops an endpoint pointing back at us
 * and turning the API into its own confused deputy.
 *
 * Exported (rather than duplicated in the worker) because "one of the two
 * outbound paths quietly relaxed its guard" is exactly the regression this
 * module cannot afford.
 */
export function webhookGuardOptions(
  appConfig: AppConfig,
  securityConfig: SecurityConfig,
): WebhookUrlGuardOptions {
  return {
    allowInsecureUrls: securityConfig.webhookAllowInsecureUrls,
    selfHostnames: [appConfig.appUrl.hostname, appConfig.apiUrl.hostname].map((host) =>
      host.toLowerCase(),
    ),
  };
}

const DELIVERY_ERROR_CODES = new Set<string>(WEBHOOK_DELIVERY_ERROR_CODES);
const SUBSCRIBABLE_EVENTS = new Set<string>(WEBHOOK_EVENTS);

/** 32 bytes -> 43 base64url characters, the same entropy as the signing secret. */
const CHALLENGE_BYTES = 32;

interface ScopedInput {
  readonly principal: AuthenticatedPrincipal;
  readonly workspaceId: string;
  readonly requestId?: string | null;
}

/** The safe projection. `encryptedSecret` is absent by construction. */
interface WebhookRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly url: string;
  readonly events: string[];
  readonly isEnabled: boolean;
  readonly isVerified: boolean;
  readonly createdById: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface DeliveryRow {
  readonly id: string;
  readonly webhookId: string;
  readonly eventId: string;
  readonly event: string;
  readonly status: WebhookDeliveryStatus;
  readonly attempt: number;
  readonly responseStatus: number | null;
  readonly responseBodySnippet: string | null;
  readonly errorMessage: string | null;
  readonly payloadHash: string | null;
  readonly deliveredAt: Date | null;
  readonly createdAt: Date;
}

export interface ListWebhooksServiceInput extends ScopedInput {
  readonly page: number;
  readonly limit: number;
}

export interface CreateWebhookServiceInput extends ScopedInput {
  readonly url: string;
  readonly events: readonly WebhookEvent[];
}

export interface UpdateWebhookServiceInput extends ScopedInput {
  readonly webhookId: string;
  readonly url?: string;
  readonly events?: readonly WebhookEvent[];
  readonly isEnabled?: boolean;
}

export interface WebhookIdServiceInput extends ScopedInput {
  readonly webhookId: string;
}

export interface ListDeliveriesServiceInput extends WebhookIdServiceInput {
  readonly page: number;
  readonly limit: number;
  readonly status?: WebhookDeliveryStatus;
}

export interface RetryDeliveryServiceInput extends WebhookIdServiceInput {
  readonly deliveryId: string;
}

@Injectable()
export class WebhooksService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorizationEntry: AuthorizationEntryService,
    private readonly tenantContext: TenantContextService,
    private readonly secrets: WebhookSecretService,
    private readonly producer: WebhookDeliveryProducer,
    @Inject(APP_CONFIG) private readonly appConfig: AppConfig,
    @Inject(SECURITY_CONFIG) private readonly securityConfig: SecurityConfig,
  ) {}

  async list(input: ListWebhooksServiceInput): Promise<WebhookEndpointPage> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "webhook.list",
      resource: { kind: "workspace" },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      const rows = await this.database.db
        .select(this.webhookSelection())
        .from(webhooks)
        .where(whereWorkspace(webhooks, this.tenantContext))
        // Deterministic tiebreak so page N+1 cannot repeat or skip a row.
        .orderBy(desc(webhooks.createdAt), asc(webhooks.id))
        .limit(input.limit + 1)
        .offset((input.page - 1) * input.limit);
      return Object.freeze({
        items: Object.freeze(rows.slice(0, input.limit).map((row) => this.toEndpoint(row))),
        page: input.page,
        limit: input.limit,
        hasMore: rows.length > input.limit,
      });
    });
  }

  async create(input: CreateWebhookServiceInput): Promise<WebhookCreateResult> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "webhook.create",
      resource: { kind: "workspace" },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      await this.assertDeliverableUrl(input.url);
      // MINTED BEFORE THE INSERT, deliberately: the id is an input to the
      // secret's encryption AAD, so it cannot be read back from a DEFAULT.
      const webhookId = randomUUID();
      const secret = this.secrets.generate();
      const encrypted = this.secrets.encrypt(webhookId, secret);

      const row = await this.database.transaction(async (tx) => {
        // BEST-EFFORT UNDER CONCURRENCY, and deliberately so. This runs at READ
        // COMMITTED, so two concurrent creates CAN both count nine and both
        // commit a tenth. The cap is a fair-use guard on an admin-only action,
        // not an invariant: one extra endpoint costs nothing, while a
        // serializable transaction or a workspace-wide lock would put retry
        // handling and a contention point on every create to prevent it. If it
        // ever must be exact, add a counter column with a CHECK constraint
        // rather than widening the isolation level.
        const [existing] = await tx
          // `cast(... as integer)`: PostgreSQL `count(*)` is `bigint`, which the
          // driver hands back as a string.
          .select({ total: sql<number>`cast(count(*) as integer)` })
          .from(webhooks)
          .where(whereWorkspace(webhooks, this.tenantContext));
        if ((existing?.total ?? 0) >= WEBHOOK_ENDPOINT_LIMIT) {
          throw new ApiHttpException(HttpStatus.CONFLICT, {
            code: "CONFLICT",
            message: "This workspace already has the maximum number of webhook endpoints.",
          });
        }
        await tx.insert(webhooks).values(
          assertWorkspaceInsertValues(
            {
              id: webhookId,
              workspaceId: activeWorkspaceId(this.tenantContext),
              createdById: input.principal.userId,
              url: input.url,
              events: [...input.events],
              encryptedSecret: encrypted.encryptedSecret,
              encryptionKeyVersion: encrypted.encryptionKeyVersion,
              // A NEW ENDPOINT IS DISABLED AND UNVERIFIED. It has to echo a
              // signed challenge before it can be enabled, so a typo'd or
              // hostile URL never receives a single real event.
              isEnabled: false,
              isVerified: false,
            },
            this.tenantContext,
            "webhook.create",
          ),
        );
        await this.recordAudit(tx, WEBHOOK_AUDIT_ACTIONS.created, webhookId, input, {
          host: hostOf(input.url),
          events: [...input.events],
        });
        return this.readRow(tx, webhookId);
      });

      // One of the only two moments the raw secret ever leaves this process.
      return Object.freeze({ webhook: this.toEndpoint(row), secret });
    });
  }

  async update(input: UpdateWebhookServiceInput): Promise<WebhookEndpoint> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "webhook.update",
      resource: { kind: "webhook", id: input.webhookId },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      if (input.url !== undefined) await this.assertDeliverableUrl(input.url);
      const row = await this.database.transaction(async (tx) => {
        const current = await this.readRow(tx, input.webhookId);
        const urlChanged = input.url !== undefined && input.url !== current.url;
        // A MOVED ENDPOINT IS A NEW ENDPOINT. Verification proved that THAT
        // host controls the secret; it proves nothing about the next one.
        if (input.isEnabled === true && (urlChanged || !current.isVerified)) {
          throw new ApiHttpException(HttpStatus.CONFLICT, {
            code: "WEBHOOK_NOT_VERIFIED",
            message: "Verify this endpoint before enabling it.",
          });
        }
        const [updated] = await tx
          .update(webhooks)
          .set({
            ...(input.url === undefined ? {} : { url: input.url }),
            ...(input.events === undefined ? {} : { events: [...input.events] }),
            ...(input.isEnabled === undefined ? {} : { isEnabled: input.isEnabled }),
            // The reset rides in the SAME statement, after the caller's own
            // fields, so there is no window in which a moved endpoint is both
            // re-pointed and still marked verified.
            ...(urlChanged ? { isVerified: false, isEnabled: false } : {}),
            updatedAt: new Date(),
          })
          .where(
            and(eq(webhooks.id, input.webhookId), whereWorkspace(webhooks, this.tenantContext)),
          )
          .returning(this.webhookSelection());
        if (updated === undefined) this.notFound();
        await this.recordAudit(tx, WEBHOOK_AUDIT_ACTIONS.updated, updated.id, input, {
          host: hostOf(updated.url),
          events: [...updated.events],
          isEnabled: updated.isEnabled,
          isVerified: updated.isVerified,
        });
        return updated;
      });
      return this.toEndpoint(row);
    });
  }

  async remove(input: WebhookIdServiceInput): Promise<WebhookDeleteResult> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "webhook.delete",
      resource: { kind: "webhook", id: input.webhookId },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () =>
      this.database.transaction(async (tx) => {
        const [deleted] = await tx
          .delete(webhooks)
          .where(
            and(eq(webhooks.id, input.webhookId), whereWorkspace(webhooks, this.tenantContext)),
          )
          .returning({ id: webhooks.id, url: webhooks.url });
        if (deleted === undefined) this.notFound();
        // The delivery history cascades with the endpoint (schema `onDelete`),
        // so the audit row is the only trace that survives.
        await this.recordAudit(tx, WEBHOOK_AUDIT_ACTIONS.deleted, deleted.id, input, {
          host: hostOf(deleted.url),
        });
        return Object.freeze({ webhookId: deleted.id, deleted: true as const });
      }),
    );
  }

  /**
   * Rotates the signing secret in place.
   *
   * ponytail: an ALREADY-QUEUED retry will sign with the NEW secret, because
   * the worker decrypts at send time. That is accepted and documented in
   * `docs/API.md` rather than solved — carrying a per-attempt key version
   * through the queue would mean keeping the old secret decryptable, which is
   * most of the reason to rotate in the first place. Receivers are told to
   * accept both secrets during a rotation window.
   */
  async rotateSecret(input: WebhookIdServiceInput): Promise<WebhookSecretRotationResult> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "webhook.update",
      resource: { kind: "webhook", id: input.webhookId },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      const secret = this.secrets.generate();
      // Re-encrypted with the ACTIVE key version, so a rotation also migrates
      // the row onto the current key.
      const encrypted = this.secrets.encrypt(input.webhookId, secret);
      const row = await this.database.transaction(async (tx) => {
        const [updated] = await tx
          .update(webhooks)
          .set({
            encryptedSecret: encrypted.encryptedSecret,
            encryptionKeyVersion: encrypted.encryptionKeyVersion,
            updatedAt: new Date(),
          })
          .where(
            and(eq(webhooks.id, input.webhookId), whereWorkspace(webhooks, this.tenantContext)),
          )
          .returning(this.webhookSelection());
        if (updated === undefined) this.notFound();
        await this.recordAudit(tx, WEBHOOK_AUDIT_ACTIONS.secretRotated, updated.id, input, {
          host: hostOf(updated.url),
          encryptionKeyVersion: encrypted.encryptionKeyVersion,
        });
        return updated;
      });
      // The other of the two moments the raw secret leaves this process.
      return Object.freeze({ webhook: this.toEndpoint(row), secret });
    });
  }

  /**
   * The verification challenge: one signed probe the endpoint must echo.
   *
   * `webhook.verification` is NOT in `WEBHOOK_EVENTS`, so it can never be
   * subscribed to and can never be fanned out — it exists only on this route.
   * EVERY attempt writes a `webhook_deliveries` row (with a fresh `event_id`)
   * BEFORE the 422 is raised, so a failing verification appears in the delivery
   * history where an admin will actually look for it.
   */
  async verify(input: WebhookIdServiceInput): Promise<WebhookVerificationResult> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "webhook.update",
      resource: { kind: "webhook", id: input.webhookId },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      const [endpoint] = await this.database.db
        .select({
          id: webhooks.id,
          url: webhooks.url,
          encryptedSecret: webhooks.encryptedSecret,
          encryptionKeyVersion: webhooks.encryptionKeyVersion,
        })
        .from(webhooks)
        .where(and(eq(webhooks.id, input.webhookId), whereWorkspace(webhooks, this.tenantContext)))
        .limit(1);
      if (endpoint === undefined) this.notFound();

      const eventId = randomUUID();
      // Minted once and used BOTH as the `x-notted-delivery-id` header and as
      // the stored row id, so an admin can match the log line their receiver
      // wrote to the attempt row we wrote.
      const deliveryId = randomUUID();
      const challenge = randomBytes(CHALLENGE_BYTES).toString("base64url");

      let secret: string;
      try {
        secret = this.secrets.decrypt(
          endpoint.id,
          endpoint.encryptedSecret,
          endpoint.encryptionKeyVersion,
        );
      } catch {
        await this.recordDelivery(endpoint.id, eventId, deliveryId, {
          status: "failed",
          errorCode: "secret_unavailable",
        });
        this.verificationFailed();
      }

      const body = webhookBody({
        id: eventId,
        event: WEBHOOK_VERIFICATION_EVENT,
        occurredAt: new Date().toISOString(),
        workspaceId: input.workspaceId,
        actorId: input.principal.userId,
        data: { challenge },
      });
      const timestampSeconds = Math.floor(Date.now() / 1_000);
      const result = await sendWebhook({
        url: endpoint.url,
        body,
        headers: {
          "content-type": "application/json",
          "user-agent": WEBHOOK_USER_AGENT,
          "x-notted-event": WEBHOOK_VERIFICATION_EVENT,
          "x-notted-event-id": eventId,
          "x-notted-delivery-id": deliveryId,
          "x-notted-timestamp": timestampSeconds.toString(),
          "x-notted-signature": signatureHeader(secret, timestampSeconds, body),
        },
        // Its own tighter budget, and NO retry: this is the only outbound call
        // in the product that happens on a request thread.
        timeoutMs: WEBHOOK_VERIFY_TIMEOUT_MS,
        guard: webhookGuardOptions(this.appConfig, this.securityConfig),
      });

      // The snippet the sender captured is the bounded, sanitized prefix of the
      // response body. A raw echo and a `{"challenge":"…"}` echo both contain
      // the token verbatim, so one substring test covers both shapes.
      //
      // TWO LIMITS RECEIVERS MUST KNOW (and `docs/API.md` states): the snippet
      // is the first `WEBHOOK_SNIPPET_MAX_LENGTH` characters, and it is only
      // captured for a TEXTUAL content type. A receiver that echoes the
      // challenge as `application/octet-stream`, or buries it past the cap,
      // fails verification. Echo it as the whole body, or as JSON.
      const echoed = result.outcome === "response" ? (result.snippet ?? "") : "";
      const verified =
        result.outcome === "response" &&
        result.status >= 200 &&
        result.status < 300 &&
        echoed.includes(challenge);

      const delivery = await this.recordDelivery(endpoint.id, eventId, deliveryId, {
        status: verified ? "success" : "failed",
        errorCode: verified ? null : result.outcome === "error" ? result.errorCode : "http_error",
        responseStatus: result.outcome === "response" ? result.status : null,
        responseBodySnippet: result.outcome === "response" ? result.snippet : null,
        payloadHash: createHash("sha256").update(body).digest("hex"),
        delivered: true,
      });
      if (!verified) this.verificationFailed();

      const row = await this.database.transaction(async (tx) => {
        // Conditional on the prior state, so an endpoint that is already
        // verified is not written again and `updated_at` does not move.
        //
        // THE AUDIT ROW IS WRITTEN EITHER WAY, including when this UPDATE
        // matches zero rows because the endpoint was already verified. A
        // re-verification is a real admin action — it made us send a live
        // challenge to the endpoint and read its answer — so it belongs in the
        // audit trail. The audit records "an admin verified this endpoint",
        // not "the verified flag changed".
        await tx
          .update(webhooks)
          .set({ isVerified: true, updatedAt: new Date() })
          .where(
            and(
              eq(webhooks.id, endpoint.id),
              whereWorkspace(webhooks, this.tenantContext),
              eq(webhooks.isVerified, false),
            ),
          );
        await this.recordAudit(tx, WEBHOOK_AUDIT_ACTIONS.verified, endpoint.id, input, {
          host: hostOf(endpoint.url),
        });
        return this.readRow(tx, endpoint.id);
      });

      return Object.freeze({ webhook: this.toEndpoint(row), isVerified: true, delivery });
    });
  }

  async listDeliveries(input: ListDeliveriesServiceInput): Promise<WebhookDeliveryPage> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "webhook.list",
      resource: { kind: "workspace" },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      // `webhook_deliveries` carries no `workspace_id`, so the tenant boundary
      // is this scoped ownership probe: a foreign endpoint id is a 404 here and
      // the delivery query below can then key on `webhook_id` alone.
      await this.assertOwnedEndpoint(input.webhookId);
      const conditions: SQL[] = [eq(webhookDeliveries.webhookId, input.webhookId)];
      if (input.status !== undefined) {
        conditions.push(eq(webhookDeliveries.status, input.status));
      }
      const rows = await this.database.db
        .select(this.deliverySelection())
        .from(webhookDeliveries)
        .where(and(...conditions))
        .orderBy(desc(webhookDeliveries.createdAt), asc(webhookDeliveries.id))
        .limit(input.limit + 1)
        .offset((input.page - 1) * input.limit);
      return Object.freeze({
        items: Object.freeze(rows.slice(0, input.limit).map((row) => this.toDelivery(row))),
        page: input.page,
        limit: input.limit,
        hasMore: rows.length > input.limit,
      });
    });
  }

  /**
   * Replays one already-recorded event.
   *
   * The body is NEVER rebuilt from the delivery row — no payload body is
   * durable there — but from the ORIGINAL intent in `job_outbox`, re-validated
   * against the registry's schema. Outbox rows are prunable, so "this delivery
   * can no longer be replayed" is a normal, expected answer rather than an
   * error, and it is a clean 409 instead of an invented payload.
   */
  async retryDelivery(input: RetryDeliveryServiceInput): Promise<WebhookRetryResult> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "webhook.redeliver",
      resource: { kind: "webhook", id: input.webhookId },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      const [delivery] = await this.database.db
        .select({ eventId: webhookDeliveries.eventId })
        .from(webhookDeliveries)
        .innerJoin(webhooks, eq(webhooks.id, webhookDeliveries.webhookId))
        .where(
          and(
            eq(webhookDeliveries.id, input.deliveryId),
            eq(webhookDeliveries.webhookId, input.webhookId),
            whereWorkspace(webhooks, this.tenantContext),
          ),
        )
        .limit(1);
      if (delivery === undefined) this.notFound();

      const [intent] = await this.database.db
        .select({ payload: jobOutbox.payload })
        .from(jobOutbox)
        .where(
          and(
            eq(jobOutbox.id, delivery.eventId),
            eq(jobOutbox.workspaceId, activeWorkspaceId(this.tenantContext)),
          ),
        )
        .limit(1);
      const parsed =
        intent === undefined
          ? undefined
          : WEBHOOK_DELIVER_JOB_DEFINITION.payloadSchema.safeParse(intent.payload);
      if (parsed === undefined || !parsed.success || parsed.data.webhookId !== input.webhookId) {
        throw new ApiHttpException(HttpStatus.CONFLICT, {
          code: "CONFLICT",
          message: "This delivery can no longer be replayed.",
        });
      }
      // Rebuilt field by field rather than passed through: the key order of the
      // stored jsonb is not guaranteed, and this literal re-establishes the
      // canonical order the producer hashes.
      const payload: WebhookDeliverPayload = {
        action: DOMAIN_JOB_TYPES.webhookDeliver,
        intentId: parsed.data.intentId,
        workspaceId: parsed.data.workspaceId,
        webhookId: parsed.data.webhookId,
        eventId: parsed.data.eventId,
        event: parsed.data.event,
        resourceId: parsed.data.resourceId,
        actorId: parsed.data.actorId,
        occurredAt: parsed.data.occurredAt,
      };

      const scheduled = await this.database.transaction(async (tx) => {
        const written = await this.producer.scheduleWebhookReplay(tx, {
          webhookId: input.webhookId,
          eventId: delivery.eventId,
          payload,
          correlationId: input.requestId ?? null,
        });
        await this.recordAudit(tx, WEBHOOK_AUDIT_ACTIONS.redelivered, input.webhookId, input, {
          eventId: delivery.eventId,
          deliveryId: input.deliveryId,
        });
        return written;
      });

      return Object.freeze({
        webhookId: input.webhookId,
        eventId: delivery.eventId,
        scheduled,
      });
    });
  }

  /**
   * L1–L3 then L5 of the destination guard, run server-side on every accepted
   * URL. The shared schema proved syntax; this proves the host is not private,
   * not link-local, not the metadata address, and not us.
   */
  private async assertDeliverableUrl(url: string): Promise<void> {
    const options = webhookGuardOptions(this.appConfig, this.securityConfig);
    const inspected = inspectWebhookUrl(url, options);
    if (!inspected.ok || (await resolveWebhookHost(inspected.url.hostname, options)) !== "ok") {
      throw new ApiHttpException(HttpStatus.UNPROCESSABLE_ENTITY, {
        code: "WEBHOOK_URL_REJECTED",
        // Deliberately non-specific: telling a caller WHICH layer refused, or
        // which address a name resolved to, is a private-network oracle.
        message: "This webhook URL cannot be used as a delivery destination.",
      });
    }
  }

  private async assertOwnedEndpoint(webhookId: string): Promise<void> {
    const [row] = await this.database.db
      .select({ id: webhooks.id })
      .from(webhooks)
      .where(and(eq(webhooks.id, webhookId), whereWorkspace(webhooks, this.tenantContext)))
      .limit(1);
    if (row === undefined) this.notFound();
  }

  private async recordDelivery(
    webhookId: string,
    eventId: string,
    deliveryId: string,
    attempt: {
      readonly status: WebhookDeliveryStatus;
      readonly errorCode: WebhookDeliveryErrorCode | null;
      readonly responseStatus?: number | null;
      readonly responseBodySnippet?: string | null;
      readonly payloadHash?: string | null;
      readonly delivered?: boolean;
    },
  ): Promise<WebhookDelivery> {
    // Written OUTSIDE any transaction on purpose: a failed verification answers
    // 422, and an attempt row rolled back with that response would erase the
    // only evidence the admin needs.
    const [row] = await this.database.db
      .insert(webhookDeliveries)
      .values({
        id: deliveryId,
        webhookId,
        eventId,
        event: WEBHOOK_VERIFICATION_EVENT,
        status: attempt.status,
        // Verification is never retried, so it is always attempt 1.
        attempt: 1,
        responseStatus: attempt.responseStatus ?? null,
        responseBodySnippet: attempt.responseBodySnippet ?? null,
        errorMessage: attempt.errorCode,
        payloadHash: attempt.payloadHash ?? null,
        deliveredAt: attempt.delivered === true ? new Date() : null,
      })
      .returning(this.deliverySelection());
    if (row === undefined) throw new Error("Webhook delivery attempt was not recorded");
    return this.toDelivery(row);
  }

  /** `encryptedSecret` and `encryptionKeyVersion` are absent by construction. */
  private webhookSelection() {
    return {
      id: webhooks.id,
      workspaceId: webhooks.workspaceId,
      url: webhooks.url,
      events: webhooks.events,
      isEnabled: webhooks.isEnabled,
      isVerified: webhooks.isVerified,
      createdById: webhooks.createdById,
      createdAt: webhooks.createdAt,
      updatedAt: webhooks.updatedAt,
    };
  }

  private deliverySelection() {
    return {
      id: webhookDeliveries.id,
      webhookId: webhookDeliveries.webhookId,
      eventId: webhookDeliveries.eventId,
      event: webhookDeliveries.event,
      status: webhookDeliveries.status,
      attempt: webhookDeliveries.attempt,
      responseStatus: webhookDeliveries.responseStatus,
      responseBodySnippet: webhookDeliveries.responseBodySnippet,
      errorMessage: webhookDeliveries.errorMessage,
      payloadHash: webhookDeliveries.payloadHash,
      deliveredAt: webhookDeliveries.deliveredAt,
      createdAt: webhookDeliveries.createdAt,
    };
  }

  private async readRow(tx: DatabaseTransaction, webhookId: string): Promise<WebhookRow> {
    const [row] = await tx
      .select(this.webhookSelection())
      .from(webhooks)
      .where(and(eq(webhooks.id, webhookId), whereWorkspace(webhooks, this.tenantContext)))
      .limit(1);
    if (row === undefined) return this.notFound();
    return row;
  }

  private toEndpoint(row: WebhookRow): WebhookEndpoint {
    return Object.freeze({
      id: row.id,
      workspaceId: row.workspaceId,
      url: row.url,
      // The column is `string[]`, not `WebhookEvent[]`: the database cannot
      // enforce the catalog, so a stale row from before a catalog change is
      // filtered here rather than claimed to be something it is not.
      events: Object.freeze(
        row.events.filter((e): e is WebhookEvent => SUBSCRIBABLE_EVENTS.has(e)),
      ),
      isEnabled: row.isEnabled,
      isVerified: row.isVerified,
      createdById: row.createdById,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
  }

  private toDelivery(row: DeliveryRow): WebhookDelivery {
    return Object.freeze({
      id: row.id,
      webhookId: row.webhookId,
      eventId: row.eventId,
      event: row.event,
      status: row.status,
      attempt: row.attempt,
      responseStatus: row.responseStatus,
      responseBodySnippet: row.responseBodySnippet,
      // `error_message` is plain `text`, so a hand-written or migrated row is
      // narrowed to the closed vocabulary rather than echoed into the API.
      errorMessage:
        row.errorMessage !== null && DELIVERY_ERROR_CODES.has(row.errorMessage)
          ? (row.errorMessage as WebhookDeliveryErrorCode)
          : null,
      payloadHash: row.payloadHash,
      deliveredAt: row.deliveredAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    });
  }

  /**
   * AUDIT METADATA CARRIES NO SECRET AND NO FULL URL.
   *
   * `api-keys.service.ts` records the display prefix and the scopes — enough to
   * identify the credential, never enough to use it. The equivalent here is the
   * HOSTNAME: a webhook URL's path and query are admin-supplied and routinely
   * carry a bearer token, and audit rows are long-lived, exportable and widely
   * readable. The full URL stays in `webhooks.url`, where exactly one code path
   * reads it.
   */
  private async recordAudit(
    tx: DatabaseTransaction,
    action: (typeof WEBHOOK_AUDIT_ACTIONS)[keyof typeof WEBHOOK_AUDIT_ACTIONS],
    entityId: string,
    input: ScopedInput,
    metadata: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await tx.insert(auditLogs).values({
      workspaceId: activeWorkspaceId(this.tenantContext),
      userId: input.principal.userId,
      action,
      entityType: WEBHOOK_AUDIT_ENTITY_TYPE,
      entityId,
      metadata,
      requestId: input.requestId ?? null,
    });
  }

  private verificationFailed(): never {
    throw new ApiHttpException(HttpStatus.UNPROCESSABLE_ENTITY, {
      code: "WEBHOOK_VERIFICATION_FAILED",
      message: "The endpoint did not echo the verification challenge.",
    });
  }

  private notFound(): never {
    throw new ApiHttpException(HttpStatus.NOT_FOUND, {
      code: "NOT_FOUND",
      message: "The requested resource was not found.",
    });
  }
}

/** Hostname only — see `recordAudit`. Unparseable input yields `"invalid"`. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "invalid";
  }
}
