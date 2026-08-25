// Part 73 — the custom-domain use cases.
//
// FOUR OPERATIONS AND ONE PUBLIC LOOKUP:
//
//   read    (`settings.read`)   — the current claim and the two records to publish.
//   set     (`settings.update`) — claim a hostname. Always lands `pending`, never
//                                 `verified`: a claim is not a proof.
//   verify  (`settings.update`) — run the DNS checks and record the verdict.
//   remove  (`settings.update`) — release the claim and free the hostname.
//   resolve (PUBLIC)            — host → `{ workspaceId, slug }` for VERIFIED
//                                 hosts only. The ACME `ask` seam.
//
// `workspaces.domain` IS A MIRROR, NOT A SOURCE. It is written only on a
// successful verification and cleared on removal or a failed re-verification, so
// the column routing and the workspace detail read can never contain a hostname
// nobody proved they own. Every write happens in the SAME transaction as the
// `workspace_domains` write and the audit row (ADR 0006).
//
// THE FEATURE FLAG IS A 404, NOT A 403. With `CUSTOM_DOMAINS_ENABLED=false` the
// capability does not exist on this deployment, and a 403 would say "you are not
// allowed", which invites the caller to find someone who is.

import { randomBytes } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";

import { recordAudit } from "../audit/audit-record";
import { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import { ApiHttpException } from "../common/errors/api-http.exception";
import { VerifiedHostsService } from "../common/verified-hosts.service";
import { APP_CONFIG, type AppConfig } from "../config/app.config";
import { DatabaseService, type DatabaseTransaction } from "../database/database.service";
import { workspaceDomains, workspaces } from "../database/schema";
import { TenantContextService, whereWorkspace, whereWorkspaceId } from "../tenant";
import { isUniqueViolationOnConstraint } from "../workspaces/workspaces.service";

import {
  DOMAIN_DNS_RESOLVER,
  verificationRecordName,
  verificationRecordValue,
  verifyDomain,
  type DomainDnsResolver,
} from "./domain-verifier";
import {
  DOMAIN_AUDIT_ACTIONS,
  DOMAIN_AUDIT_ENTITY_TYPE,
  DOMAIN_VERIFICATION_TOKEN_BYTES,
  WORKSPACE_DOMAINS_HOSTNAME_UNIQUE,
  WORKSPACE_DOMAINS_WORKSPACE_UNIQUE,
} from "./domains.constants";

import type {
  AuthenticatedPrincipal,
  DomainResolveResult,
  WorkspaceDomain,
  WorkspaceDomainError,
  WorkspaceDomainResult,
} from "@notted/shared-types";

type DomainRow = typeof workspaceDomains.$inferSelect;

/** Anything that can read — `database.db` or an open transaction. */
type DomainReader = Pick<DatabaseTransaction, "select">;

interface ScopedInput {
  readonly principal: AuthenticatedPrincipal;
  readonly workspaceId: string;
  readonly requestId?: string | null;
}

export interface SetDomainInput extends ScopedInput {
  readonly hostname: string;
}

@Injectable()
export class DomainsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorizationEntry: AuthorizationEntryService,
    private readonly tenantContext: TenantContextService,
    private readonly verifiedHosts: VerifiedHostsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    // Injected so the service's tests need no network. `DomainsModule` binds the
    // real `node:dns`-backed resolver; it is named in exactly one place.
    @Inject(DOMAIN_DNS_RESOLVER) private readonly resolver: DomainDnsResolver,
  ) {}

  async read(input: ScopedInput): Promise<WorkspaceDomainResult> {
    this.assertEnabled();
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "settings.read",
      resource: { kind: "settings" },
      requestId: input.requestId ?? null,
    });
    return this.authorizationEntry.run(operation, async () => {
      const row = await this.load(this.database.db);
      return Object.freeze({ domain: row === null ? null : this.toContract(row) });
    });
  }

  /**
   * Claim a hostname.
   *
   * Re-claiming the SAME hostname is idempotent and does NOT mint a new token:
   * an administrator who has already published the TXT record and comes back to
   * the form should not be told to publish a different one. Claiming a
   * DIFFERENT hostname replaces the row wholesale — new token, `pending` status,
   * and `workspaces.domain` cleared, because whatever was verified before is not
   * this name.
   */
  async set(input: SetDomainInput): Promise<WorkspaceDomainResult> {
    this.assertEnabled();
    const hostname = input.hostname.toLowerCase();
    this.assertClaimable(hostname);
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "settings.update",
      resource: { kind: "settings" },
      requestId: input.requestId ?? null,
    });
    return this.authorizationEntry.run(operation, async () => {
      try {
        const row = await this.database.transaction(async (tx) => {
          const existing = await this.load(tx);
          if (existing !== null && existing.hostname === hostname) return existing;

          const token = randomBytes(DOMAIN_VERIFICATION_TOKEN_BYTES).toString("hex");
          const now = new Date();
          if (existing !== null) {
            await tx
              .delete(workspaceDomains)
              .where(
                and(
                  eq(workspaceDomains.id, existing.id),
                  eq(workspaceDomains.workspaceId, input.workspaceId),
                ),
              );
          }
          const [inserted] = await tx
            .insert(workspaceDomains)
            .values({
              workspaceId: input.workspaceId,
              hostname,
              status: "pending",
              verificationToken: token,
              createdById: input.principal.userId,
            })
            .returning();
          if (inserted === undefined) throw new Error("Domain claim was not readable after insert");
          // The mirror is cleared the moment the claim changes: the previously
          // verified hostname is no longer this workspace's domain.
          await tx
            .update(workspaces)
            .set({ domain: null, updatedAt: now })
            .where(whereWorkspaceId(workspaces, this.tenantContext));
          await recordAudit(tx, {
            workspaceId: input.workspaceId,
            userId: input.principal.userId,
            action: DOMAIN_AUDIT_ACTIONS.set,
            entityType: DOMAIN_AUDIT_ENTITY_TYPE,
            entityId: inserted.id,
            metadata: { hostname, status: "pending" },
            requestId: input.requestId ?? null,
          });
          if (existing !== null) this.verifiedHosts.invalidate(existing.hostname);
          return inserted;
        });
        return Object.freeze({ domain: this.toContract(row) });
      } catch (error: unknown) {
        this.rethrowClaimConflict(error);
      }
    });
  }

  /**
   * Re-run the DNS checks and record the verdict.
   *
   * The DNS work happens BEFORE the transaction opens. Holding a row lock across
   * up to four network lookups would pin a connection for as long as a resolver
   * chooses to take, and nothing in the verdict depends on the row staying
   * unchanged — a concurrent `set` simply makes this verify write against a row
   * that is no longer there, which the id-scoped update handles by touching
   * nothing.
   */
  async verify(input: ScopedInput): Promise<WorkspaceDomainResult> {
    this.assertEnabled();
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "settings.update",
      resource: { kind: "settings" },
      requestId: input.requestId ?? null,
    });
    return this.authorizationEntry.run(operation, async () => {
      const claim = await this.load(this.database.db);
      if (claim === null) this.notFound();

      const verdict = await verifyDomain({
        hostname: claim.hostname,
        token: claim.verificationToken,
        cnameTarget: this.config.customDomainCnameTarget,
        resolver: this.resolver,
      });
      const now = new Date();
      const status = verdict.ok ? "verified" : "error";
      const lastError: WorkspaceDomainError | null = verdict.ok ? null : verdict.reason;

      const row = await this.database.transaction(async (tx) => {
        const [updated] = await tx
          .update(workspaceDomains)
          .set({
            status,
            lastError,
            lastCheckedAt: now,
            verifiedAt: verdict.ok ? now : null,
            updatedAt: now,
          })
          .where(
            and(
              eq(workspaceDomains.id, claim.id),
              eq(workspaceDomains.workspaceId, input.workspaceId),
            ),
          )
          .returning();
        if (updated === undefined) this.notFound();
        // The mirror follows the verdict in both directions: a re-verification
        // that now fails must not leave a hostname in the column that routing
        // and the workspace detail present as live.
        await tx
          .update(workspaces)
          .set({ domain: verdict.ok ? claim.hostname : null, updatedAt: now })
          .where(whereWorkspaceId(workspaces, this.tenantContext));
        await recordAudit(tx, {
          workspaceId: input.workspaceId,
          userId: input.principal.userId,
          action: DOMAIN_AUDIT_ACTIONS.verify,
          entityType: DOMAIN_AUDIT_ENTITY_TYPE,
          entityId: claim.id,
          metadata: { hostname: claim.hostname, status, lastError },
          requestId: input.requestId ?? null,
        });
        return updated;
      });
      // Both directions: a newly verified host must start answering, and a host
      // that just failed re-verification must stop.
      this.verifiedHosts.invalidate(claim.hostname);
      return Object.freeze({ domain: this.toContract(row) });
    });
  }

  /** Release the claim. Idempotent: removing an absent claim is a success. */
  async remove(input: ScopedInput): Promise<WorkspaceDomainResult> {
    this.assertEnabled();
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "settings.update",
      resource: { kind: "settings" },
      requestId: input.requestId ?? null,
    });
    return this.authorizationEntry.run(operation, async () => {
      const removed = await this.database.transaction(async (tx) => {
        const existing = await this.load(tx);
        if (existing === null) return null;
        await tx
          .delete(workspaceDomains)
          .where(
            and(
              eq(workspaceDomains.id, existing.id),
              eq(workspaceDomains.workspaceId, input.workspaceId),
            ),
          );
        await tx
          .update(workspaces)
          .set({ domain: null, updatedAt: new Date() })
          .where(whereWorkspaceId(workspaces, this.tenantContext));
        await recordAudit(tx, {
          workspaceId: input.workspaceId,
          userId: input.principal.userId,
          action: DOMAIN_AUDIT_ACTIONS.remove,
          entityType: DOMAIN_AUDIT_ENTITY_TYPE,
          entityId: existing.id,
          metadata: { hostname: existing.hostname },
          requestId: input.requestId ?? null,
        });
        return existing;
      });
      if (removed !== null) this.verifiedHosts.invalidate(removed.hostname);
      return Object.freeze({ domain: null });
    });
  }

  /**
   * PUBLIC host → workspace lookup. NO principal, NO tenant context.
   *
   * Only `verified` rows answer, and every miss is the same 404 — an unknown
   * host, a pending claim, a failed one — so the route cannot be used to
   * enumerate which hostnames are claimed but not yet proved. It returns
   * identifiers only: this is what a certificate issuer asks before a handshake
   * and what the web proxy asks before routing, and neither needs a name.
   */
  async resolve(host: string): Promise<DomainResolveResult> {
    this.assertEnabled();
    const [row] = await this.database.db
      .select({ workspaceId: workspaces.id, slug: workspaces.slug })
      .from(workspaceDomains)
      .innerJoin(workspaces, eq(workspaces.id, workspaceDomains.workspaceId))
      .where(and(eq(workspaceDomains.hostname, host), eq(workspaceDomains.status, "verified")))
      .limit(1);
    if (row === undefined) this.notFound();
    return Object.freeze({ workspaceId: row.workspaceId, slug: row.slug });
  }

  // ----------------------------------------------------------------------- //

  private async load(db: DomainReader): Promise<DomainRow | null> {
    const [row] = await db
      .select()
      .from(workspaceDomains)
      .where(whereWorkspace(workspaceDomains, this.tenantContext))
      .limit(1);
    return row ?? null;
  }

  private toContract(row: DomainRow): WorkspaceDomain {
    return Object.freeze({
      id: row.id,
      workspaceId: row.workspaceId,
      hostname: row.hostname,
      status: row.status,
      lastError: (row.lastError as WorkspaceDomainError | null) ?? null,
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      verificationRecord: Object.freeze({
        name: verificationRecordName(row.hostname),
        type: "TXT" as const,
        value: verificationRecordValue(row.verificationToken),
      }),
      cnameRecord: Object.freeze({
        name: row.hostname,
        type: "CNAME" as const,
        value: this.config.customDomainCnameTarget,
      }),
    });
  }

  private assertEnabled(): void {
    if (!this.config.customDomainsEnabled) this.notFound();
  }

  /** A hostname the deployment already answers on is never a tenant's to claim. */
  private assertClaimable(hostname: string): void {
    if (this.verifiedHosts.staticHosts.has(hostname)) {
      throw new ApiHttpException(HttpStatus.UNPROCESSABLE_ENTITY, {
        code: "DOMAIN_RESERVED",
        message: "That hostname is reserved by this deployment.",
      });
    }
  }

  private rethrowClaimConflict(error: unknown): never {
    if (
      isUniqueViolationOnConstraint(error, WORKSPACE_DOMAINS_HOSTNAME_UNIQUE) ||
      isUniqueViolationOnConstraint(error, WORKSPACE_DOMAINS_WORKSPACE_UNIQUE)
    ) {
      // Deliberately the SAME message for both: "another workspace already
      // claimed this" and "you already have a claim" are distinguishable to the
      // caller from their own state, and naming the other workspace would leak
      // that a foreign tenant holds the name.
      throw new ApiHttpException(HttpStatus.CONFLICT, {
        code: "DOMAIN_TAKEN",
        message: "That domain is already claimed.",
      });
    }
    throw error;
  }

  private notFound(): never {
    throw new ApiHttpException(HttpStatus.NOT_FOUND, {
      code: "NOT_FOUND",
      message: "The requested resource was not found.",
    });
  }
}
