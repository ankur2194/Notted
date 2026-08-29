import { HttpStatus, Injectable } from "@nestjs/common";
import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import { AuthorizationPolicyService } from "../authorization/authorization-policy.service";
import {
  actorFromPrincipal,
  type AuthorizationAction,
} from "../authorization/authorization.contracts";
import { ApiHttpException } from "../common/errors/api-http.exception";
import { DatabaseService } from "../database/database.service";
import { notifications, users, workspaceMembers, workspaces } from "../database/schema";
import { TenantContextService, whereWorkspace } from "../tenant";

import type {
  AuthenticatedPrincipal,
  ShellBootstrap,
  ShellPresentationPermissions,
  ShellWorkspaceMembership,
} from "@notted/shared-types";

interface MembershipRow extends ShellWorkspaceMembership {
  readonly loadedAt: string;
}

/**
 * `workspaces.settings` is untyped `jsonb`, so the accent is parsed
 * defensively here exactly as it is in `WorkspacesService` and
 * `email-branding.ts`: any miss yields `null` and the shell renders the
 * platform default rather than emitting a value a stylesheet would inherit.
 * The regex is the anchor that stops an arbitrary stored string from reaching
 * a CSS custom property.
 */
function accentColorOf(settings: unknown): string | null {
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return null;
  const accentColor = (settings as { readonly accentColor?: unknown }).accentColor;
  return typeof accentColor === "string" && /^#[0-9a-f]{6}$/iu.test(accentColor)
    ? accentColor
    : null;
}

@Injectable()
export class ShellService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorizationEntry: AuthorizationEntryService,
    private readonly policy: AuthorizationPolicyService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async bootstrap(
    principal: AuthenticatedPrincipal,
    requestedWorkspaceId?: string,
  ): Promise<ShellBootstrap> {
    const [userRows, membershipRows] = await Promise.all([
      this.database.db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, principal.userId))
        .limit(1),
      this.database.db
        .select({
          workspaceId: workspaces.id,
          name: workspaces.name,
          slug: workspaces.slug,
          role: workspaceMembers.role,
          // Part 72 branding. Carried on the bootstrap the shell already
          // fetches so the sidebar mark and the accent custom property are
          // correct on the FIRST paint, with no second round-trip and no flash
          // of the default branding.
          logoUrl: workspaces.logoUrl,
          settings: workspaces.settings,
        })
        .from(workspaceMembers)
        .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
        .where(eq(workspaceMembers.userId, principal.userId))
        .orderBy(asc(workspaces.name), asc(workspaces.id)),
    ]);

    const user = userRows[0];
    if (user === undefined) {
      throw new ApiHttpException(HttpStatus.UNAUTHORIZED, {
        code: "UNAUTHENTICATED",
        message: "Authentication is required.",
      });
    }

    const loadedAt = new Date().toISOString();
    const memberships: readonly MembershipRow[] = membershipRows.map(
      ({ settings, logoUrl, ...row }) => ({
        ...row,
        logoUrl,
        accentColor: accentColorOf(settings),
        loadedAt,
      }),
    );
    const current =
      requestedWorkspaceId === undefined
        ? (memberships[0] ?? null)
        : (memberships.find(({ workspaceId }) => workspaceId === requestedWorkspaceId) ?? null);

    if (requestedWorkspaceId !== undefined && current === null) {
      throw new ApiHttpException(HttpStatus.NOT_FOUND, {
        code: "NOT_FOUND",
        message: "The requested resource was not found.",
      });
    }

    const permissions =
      current === null ? this.emptyPermissions() : this.permissions(principal, current);
    const notificationUnreadCount =
      current === null ? 0 : await this.loadUnreadCount(principal, current.workspaceId);

    return Object.freeze({
      user: Object.freeze(user),
      workspaces: Object.freeze(
        memberships.map(({ workspaceId, name, slug, role, logoUrl, accentColor }) => ({
          workspaceId,
          name,
          slug,
          role,
          logoUrl,
          accentColor,
        })),
      ),
      currentWorkspace:
        current === null
          ? null
          : Object.freeze({
              workspaceId: current.workspaceId,
              name: current.name,
              slug: current.slug,
              role: current.role,
              logoUrl: current.logoUrl,
              accentColor: current.accentColor,
            }),
      permissions,
      notificationUnreadCount,
    });
  }

  private async loadUnreadCount(
    principal: AuthenticatedPrincipal,
    workspaceId: string,
  ): Promise<number> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal,
      workspaceId,
      action: "workspace.read",
      resource: { kind: "workspace" },
    });
    return this.authorizationEntry.run(operation, async () => {
      const [row] = await this.database.db
        .select({ count: sql<number>`count(*)::int` })
        .from(notifications)
        .where(
          and(
            whereWorkspace(notifications, this.tenantContext),
            eq(notifications.recipientUserId, principal.userId),
            isNull(notifications.readAt),
          ),
        );
      return row?.count ?? 0;
    });
  }

  private permissions(
    principal: AuthenticatedPrincipal,
    membership: MembershipRow,
  ): ShellPresentationPermissions {
    const allowed = (
      action: AuthorizationAction,
      kind: "workspace" | "settings" = "workspace",
    ): boolean =>
      this.policy.decide({
        actor: actorFromPrincipal(principal),
        action,
        resource: {
          kind,
          id: membership.workspaceId,
          workspaceId: membership.workspaceId,
          project: null,
          loadedAt: membership.loadedAt,
          relationsValid: true,
        },
        tenant: {
          workspaceId: membership.workspaceId,
          membershipRole: membership.role,
          membershipLoadedAt: membership.loadedAt,
        },
      }).allowed;

    return Object.freeze({
      canViewSettings: allowed("settings.read", "settings"),
      canManageWorkspace: allowed("settings.update", "settings"),
      canManageMembers: allowed("member.invite"),
      canCreateContent: allowed("note.create"),
    });
  }

  private emptyPermissions(): ShellPresentationPermissions {
    return Object.freeze({
      canViewSettings: false,
      canManageWorkspace: false,
      canManageMembers: false,
      canCreateContent: false,
    });
  }
}
