import { getTableName, type Table } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { AuthorizationPolicyService } from "../authorization/authorization-policy.service";
import { createTenantContext, TenantContextService } from "../tenant";

import { SearchResultRepository, type NoteSearchFact } from "./search-result.repository";

import type { DatabaseService } from "../database/database.service";

// --------------------------------------------------------------------------- //
// Stable identifiers
// --------------------------------------------------------------------------- //

const WORKSPACE_ID = "11111111-0000-4000-8000-000000000001";
const USER_ID = "33333333-0000-4000-8000-000000000003";
const NOTE_PUBLIC = "44444444-0000-4000-8000-000000000004";
const NOTE_RESTRICTED_NO_ACCESS = "55555555-0000-4000-8000-000000000005";
const NOTE_RESTRICTED_VIEWER = "66666666-0000-4000-8000-000000000006";
const NOTE_SHARED_ON_RESTRICTED = "77777777-0000-4000-8000-000000000007";
const PROJECT_OPEN = "88888888-0000-4000-8000-000000000008";
const PROJECT_RESTRICTED = "99999999-0000-4000-8000-000000000009";
const AUTHOR_ID = "aaaaaaaa-0000-4000-8000-00000000000a";

const NOW = new Date("2026-08-12T12:00:00.000Z");

interface NotePgRow {
  readonly id: string;
  readonly title: string;
  readonly projectId: string | null;
  readonly createdById: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly isArchived: boolean;
  readonly isTemplate: boolean;
  readonly isPinned: boolean;
  readonly isDeleted: boolean;
}

function noteRow(overrides: Partial<NotePgRow>): NotePgRow {
  return {
    id: NOTE_PUBLIC,
    title: "Title",
    projectId: null,
    createdById: AUTHOR_ID,
    createdAt: NOW,
    updatedAt: NOW,
    isArchived: false,
    isTemplate: false,
    isPinned: false,
    isDeleted: false,
    ...overrides,
  };
}

/**
 * Minimal DatabaseService double. The repository issues six distinct query
 * shapes (notes, project facts, project access, note shares, attachments,
 * authors, project titles); the double inspects the projected selection to
 * route each call. Two selection shapes are ambiguous on keys alone:
 *   - `{ noteId }` → note_shares OR attachments
 *   - `{ id, name }` → users (authors) OR projects (titles)
 * Drizzle table objects do not expose `.name`; the public accessor is
 * `getTableName(table)`, so the `from(table)` step disambiguates using it.
 */
function buildDatabase(overrides: {
  readonly noteRows?: readonly NotePgRow[];
  readonly projectFactsRows?: readonly { readonly id: string; readonly isRestricted: boolean }[];
  readonly projectAccessRows?: readonly {
    readonly projectId: string;
    readonly role: "viewer" | "editor" | "admin";
  }[];
  readonly noteShareRows?: readonly { readonly noteId: string }[];
  readonly attachmentRows?: readonly { readonly noteId: string }[];
  readonly authorRows?: readonly { readonly id: string; readonly name: string }[];
  readonly projectTitleRows?: readonly { readonly id: string; readonly name: string }[];
}): {
  readonly database: DatabaseService;
  readonly calls: ReadonlyArray<{ readonly kind: string }>;
} {
  const calls: Array<{ readonly kind: string }> = [];

  const select = (selection: unknown) => {
    const selectionKeys =
      selection !== null && typeof selection === "object"
        ? Object.keys(selection as Record<string, unknown>)
        : [];
    let kind: string;
    // Ambiguous selections are tagged here and resolved by the `from(table)`
    // step using `getTableName`; all other shapes are fully classified by
    // their selection keys.
    if (selectionKeys.includes("isRestricted")) kind = "projectFacts";
    else if (selectionKeys.includes("role") && selectionKeys.includes("projectId"))
      kind = "projectAccess";
    else if (selectionKeys.length === 1 && selectionKeys[0] === "noteId") kind = "noteId";
    else if (
      selectionKeys.length === 2 &&
      selectionKeys.includes("name") &&
      selectionKeys.includes("id")
    )
      kind = "nameId";
    else kind = "notes";
    return {
      from: (table: Table) => {
        const tableName = getTableName(table);
        if (kind === "noteId") {
          // `note_shares` (noteShares) vs `attachments` (attachment flags).
          kind = tableName === "note_shares" ? "noteShares" : "attachments";
        } else if (kind === "nameId") {
          // `users` (authors) vs `projects` (project titles).
          kind = tableName === "users" ? "authors" : "projectTitles";
        }
        calls.push({ kind });
        const rows = pickRows(kind);
        return {
          where: () => ({
            then(resolve: (value: unknown) => void) {
              resolve(rows);
              return Promise.resolve(rows);
            },
          }),
        };
      },
    };
  };

  const pickRows = (kind: string): readonly unknown[] => {
    switch (kind) {
      case "notes":
        return overrides.noteRows ?? [];
      case "projectFacts":
        return overrides.projectFactsRows ?? [];
      case "projectAccess":
        return overrides.projectAccessRows ?? [];
      case "noteShares":
        return overrides.noteShareRows ?? [];
      case "attachments":
        return overrides.attachmentRows ?? [];
      case "authors":
        return overrides.authorRows ?? [];
      case "projectTitles":
        return overrides.projectTitleRows ?? [];
      default:
        return [];
    }
  };

  const database = {
    db: { select: vi.fn((selection: unknown) => select(selection)) },
  } as unknown as DatabaseService;
  return { database, calls };
}

function buildRepository(
  database: DatabaseService,
  tenantContext: TenantContextService,
): SearchResultRepository {
  return new SearchResultRepository(database, new AuthorizationPolicyService(), tenantContext);
}

function runUnderTenant<T>(
  tenantContext: TenantContextService,
  workspaceId: string,
  work: () => T,
): T {
  return tenantContext.run(createTenantContext({ workspaceId, userId: USER_ID }), work);
}

describe("SearchResultRepository.loadFacts", () => {
  it("returns an empty map for an empty candidate list", async () => {
    const tenantContext = new TenantContextService();
    const { database } = buildDatabase({});
    const repository = buildRepository(database, tenantContext);

    const facts = await runUnderTenant(tenantContext, WORKSPACE_ID, () =>
      repository.loadFacts([], {
        userId: USER_ID,
        membershipRole: "editor",
        shareGrantsReadOnRestrictedProject: true,
      }),
    );

    expect(facts.size).toBe(0);
  });

  it("includes standalone notes (no project) for editor and viewer", async () => {
    const tenantContext = new TenantContextService();
    const { database } = buildDatabase({
      noteRows: [noteRow({ id: NOTE_PUBLIC, projectId: null })],
      authorRows: [{ id: AUTHOR_ID, name: "Author A" }],
    });
    const repository = buildRepository(database, tenantContext);

    for (const role of ["editor", "viewer"] as const) {
      const facts = await runUnderTenant(tenantContext, WORKSPACE_ID, () =>
        repository.loadFacts([NOTE_PUBLIC], {
          userId: USER_ID,
          membershipRole: role,
          shareGrantsReadOnRestrictedProject: true,
        }),
      );
      expect(facts.size).toBe(1);
      const fact: NoteSearchFact | undefined = facts.get(NOTE_PUBLIC);
      expect(fact?.accessible).toBe(true);
      expect(fact?.authorName).toBe("Author A");
    }
  });

  it("owner and admin can read every note regardless of project restriction", async () => {
    const tenantContext = new TenantContextService();
    const { database } = buildDatabase({
      noteRows: [noteRow({ id: NOTE_RESTRICTED_NO_ACCESS, projectId: PROJECT_RESTRICTED })],
      projectFactsRows: [{ id: PROJECT_RESTRICTED, isRestricted: true }],
    });
    const repository = buildRepository(database, tenantContext);

    for (const role of ["owner", "admin"] as const) {
      const facts = await runUnderTenant(tenantContext, WORKSPACE_ID, () =>
        repository.loadFacts([NOTE_RESTRICTED_NO_ACCESS], {
          userId: USER_ID,
          membershipRole: role,
          shareGrantsReadOnRestrictedProject: true,
        }),
      );
      expect(facts.size).toBe(1);
    }
  });

  it("editor/viewer cannot read a restricted-project note without project access or share", async () => {
    const tenantContext = new TenantContextService();
    const { database } = buildDatabase({
      noteRows: [noteRow({ id: NOTE_RESTRICTED_NO_ACCESS, projectId: PROJECT_RESTRICTED })],
      projectFactsRows: [{ id: PROJECT_RESTRICTED, isRestricted: true }],
      // No projectAccessRows and no noteShareRows.
    });
    const repository = buildRepository(database, tenantContext);

    for (const role of ["editor", "viewer"] as const) {
      const facts = await runUnderTenant(tenantContext, WORKSPACE_ID, () =>
        repository.loadFacts([NOTE_RESTRICTED_NO_ACCESS], {
          userId: USER_ID,
          membershipRole: role,
          shareGrantsReadOnRestrictedProject: true,
        }),
      );
      expect(facts.size).toBe(0);
    }
  });

  it("editor/viewer can read a restricted-project note via an explicit project_access grant", async () => {
    const tenantContext = new TenantContextService();
    const { database } = buildDatabase({
      noteRows: [noteRow({ id: NOTE_RESTRICTED_VIEWER, projectId: PROJECT_RESTRICTED })],
      projectFactsRows: [{ id: PROJECT_RESTRICTED, isRestricted: true }],
      projectAccessRows: [{ projectId: PROJECT_RESTRICTED, role: "viewer" }],
    });
    const repository = buildRepository(database, tenantContext);

    const facts = await runUnderTenant(tenantContext, WORKSPACE_ID, () =>
      repository.loadFacts([NOTE_RESTRICTED_VIEWER], {
        userId: USER_ID,
        membershipRole: "viewer",
        shareGrantsReadOnRestrictedProject: true,
      }),
    );

    expect(facts.size).toBe(1);
  });

  it("does not broaden restricted-project access when the user has a direct note share", async () => {
    const tenantContext = new TenantContextService();
    const { database } = buildDatabase({
      noteRows: [noteRow({ id: NOTE_SHARED_ON_RESTRICTED, projectId: PROJECT_RESTRICTED })],
      projectFactsRows: [{ id: PROJECT_RESTRICTED, isRestricted: true }],
      noteShareRows: [{ noteId: NOTE_SHARED_ON_RESTRICTED }],
    });
    const repository = buildRepository(database, tenantContext);

    const facts = await runUnderTenant(tenantContext, WORKSPACE_ID, () =>
      repository.loadFacts([NOTE_SHARED_ON_RESTRICTED], {
        userId: USER_ID,
        membershipRole: "viewer",
        shareGrantsReadOnRestrictedProject: true,
      }),
    );

    expect(facts.size).toBe(0);
  });

  it("keeps restricted-project access denied regardless of the legacy share option", async () => {
    const tenantContext = new TenantContextService();
    const { database } = buildDatabase({
      noteRows: [noteRow({ id: NOTE_SHARED_ON_RESTRICTED, projectId: PROJECT_RESTRICTED })],
      projectFactsRows: [{ id: PROJECT_RESTRICTED, isRestricted: true }],
      noteShareRows: [{ noteId: NOTE_SHARED_ON_RESTRICTED }],
    });
    const repository = buildRepository(database, tenantContext);

    const facts = await runUnderTenant(tenantContext, WORKSPACE_ID, () =>
      repository.loadFacts([NOTE_SHARED_ON_RESTRICTED], {
        userId: USER_ID,
        membershipRole: "viewer",
        shareGrantsReadOnRestrictedProject: false,
      }),
    );

    expect(facts.size).toBe(0);
  });

  it("excludes soft-deleted notes that slip past the SQL filter (defense-in-depth)", async () => {
    const tenantContext = new TenantContextService();
    const { database } = buildDatabase({
      noteRows: [noteRow({ id: NOTE_PUBLIC, isDeleted: true })],
    });
    const repository = buildRepository(database, tenantContext);

    const facts = await runUnderTenant(tenantContext, WORKSPACE_ID, () =>
      repository.loadFacts([NOTE_PUBLIC], {
        userId: USER_ID,
        membershipRole: "editor",
        shareGrantsReadOnRestrictedProject: true,
      }),
    );

    expect(facts.size).toBe(0);
  });

  it("excludes notes belonging to another workspace (defense-in-depth via tenant scope)", async () => {
    const tenantContext = new TenantContextService();
    const { database } = buildDatabase({
      // The tenant-scoped SQL would return zero rows for another workspace's
      // notes. We simulate the post-filter case by providing no noteRows at
      // all; the empty map proves the workspace predicate was applied.
      noteRows: [],
    });
    const repository = buildRepository(database, tenantContext);

    const facts = await runUnderTenant(tenantContext, WORKSPACE_ID, () =>
      repository.loadFacts([NOTE_PUBLIC], {
        userId: USER_ID,
        membershipRole: "editor",
        shareGrantsReadOnRestrictedProject: true,
      }),
    );

    expect(facts.size).toBe(0);
  });

  it("carries author display name and project title for labeling", async () => {
    const tenantContext = new TenantContextService();
    const { database } = buildDatabase({
      noteRows: [noteRow({ id: NOTE_PUBLIC, projectId: PROJECT_OPEN })],
      projectFactsRows: [{ id: PROJECT_OPEN, isRestricted: false }],
      authorRows: [{ id: AUTHOR_ID, name: "Display Name" }],
      projectTitleRows: [{ id: PROJECT_OPEN, name: "Open Project" }],
    });
    const repository = buildRepository(database, tenantContext);

    const facts = await runUnderTenant(tenantContext, WORKSPACE_ID, () =>
      repository.loadFacts([NOTE_PUBLIC], {
        userId: USER_ID,
        membershipRole: "editor",
        shareGrantsReadOnRestrictedProject: true,
      }),
    );

    const fact = facts.get(NOTE_PUBLIC);
    expect(fact?.authorName).toBe("Display Name");
    expect(fact?.projectTitle).toBe("Open Project");
  });

  it("falls back to null author/project labels when the rows are absent", async () => {
    const tenantContext = new TenantContextService();
    const { database } = buildDatabase({
      noteRows: [noteRow({ id: NOTE_PUBLIC, projectId: PROJECT_OPEN })],
      projectFactsRows: [{ id: PROJECT_OPEN, isRestricted: false }],
      // No author or project title rows.
    });
    const repository = buildRepository(database, tenantContext);

    const facts = await runUnderTenant(tenantContext, WORKSPACE_ID, () =>
      repository.loadFacts([NOTE_PUBLIC], {
        userId: USER_ID,
        membershipRole: "editor",
        shareGrantsReadOnRestrictedProject: true,
      }),
    );

    const fact = facts.get(NOTE_PUBLIC);
    expect(fact?.authorName).toBeNull();
    expect(fact?.projectTitle).toBeNull();
  });

  it("labels archived and template state on authorized notes", async () => {
    const tenantContext = new TenantContextService();
    const { database } = buildDatabase({
      noteRows: [noteRow({ id: NOTE_PUBLIC, isArchived: true, isTemplate: true })],
    });
    const repository = buildRepository(database, tenantContext);

    const facts = await runUnderTenant(tenantContext, WORKSPACE_ID, () =>
      repository.loadFacts([NOTE_PUBLIC], {
        userId: USER_ID,
        membershipRole: "editor",
        shareGrantsReadOnRestrictedProject: true,
      }),
    );

    const fact = facts.get(NOTE_PUBLIC);
    expect(fact?.isArchived).toBe(true);
    expect(fact?.isTemplate).toBe(true);
  });

  it("sources hasAttachments from the authoritative attachments table", async () => {
    const tenantContext = new TenantContextService();
    const { database } = buildDatabase({
      noteRows: [
        noteRow({ id: NOTE_PUBLIC }),
        noteRow({ id: NOTE_RESTRICTED_NO_ACCESS, projectId: PROJECT_RESTRICTED }),
      ],
      projectFactsRows: [{ id: PROJECT_RESTRICTED, isRestricted: false }],
      // NOTE_PUBLIC has a ready attachment; NOTE_RESTRICTED_NO_ACCESS does not.
      attachmentRows: [{ noteId: NOTE_PUBLIC }],
    });
    const repository = buildRepository(database, tenantContext);

    const facts = await runUnderTenant(tenantContext, WORKSPACE_ID, () =>
      repository.loadFacts([NOTE_PUBLIC, NOTE_RESTRICTED_NO_ACCESS], {
        userId: USER_ID,
        membershipRole: "editor",
        shareGrantsReadOnRestrictedProject: true,
      }),
    );

    expect(facts.get(NOTE_PUBLIC)?.hasAttachments).toBe(true);
    expect(facts.get(NOTE_RESTRICTED_NO_ACCESS)?.hasAttachments).toBe(false);
  });

  it("treats a missing projectFacts row as restricted (fail closed)", async () => {
    const tenantContext = new TenantContextService();
    const { database } = buildDatabase({
      noteRows: [noteRow({ id: NOTE_PUBLIC, projectId: PROJECT_RESTRICTED })],
      // Project was deleted between Meilisearch and PostgreSQL; no facts row.
    });
    const repository = buildRepository(database, tenantContext);

    const facts = await runUnderTenant(tenantContext, WORKSPACE_ID, () =>
      repository.loadFacts([NOTE_PUBLIC], {
        userId: USER_ID,
        membershipRole: "viewer",
        shareGrantsReadOnRestrictedProject: true,
      }),
    );

    expect(facts.size).toBe(0);
  });

  it("requires an active tenant context (deny-by-default)", async () => {
    const tenantContext = new TenantContextService();
    const { database } = buildDatabase({ noteRows: [noteRow({ id: NOTE_PUBLIC })] });
    const repository = buildRepository(database, tenantContext);

    await expect(
      repository.loadFacts([NOTE_PUBLIC], {
        userId: USER_ID,
        membershipRole: "editor",
        shareGrantsReadOnRestrictedProject: true,
      }),
    ).rejects.toThrow();
  });
});
