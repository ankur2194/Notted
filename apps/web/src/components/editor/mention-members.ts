import type { WorkspaceMemberPage, WorkspaceRole } from "@notted/shared-types";

/**
 * A member the mention menu may offer.
 *
 * Candidates only ever come from a workspace-scoped member listing that the
 * backend already authorized (`memberships.service.ts#listMembers`). Nothing
 * here re-implements tenant isolation; it simply never invents a candidate that
 * did not come from that response.
 */
export interface MentionCandidate {
  /** Stable UUID user id, persisted as the mention node's `id`. */
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly role: WorkspaceRole;
}

/** How a stored mention id relates to the currently loaded member list. */
export type MentionResolution =
  | { readonly kind: "current"; readonly name: string }
  | { readonly kind: "former" }
  | { readonly kind: "unknown" };

/**
 * The loaded workspace member list, as the mention node view sees it.
 *
 * Node views are created once per node, so they subscribe here and repaint when
 * the member list arrives or changes. `setMembers(null)` means "not loaded or
 * unavailable", which resolves to `unknown` — never to `former`, because an
 * unavailable list is not evidence that anyone was removed.
 */
export interface MentionDirectory {
  resolve(userId: string): MentionResolution;
  setMembers(members: readonly MentionCandidate[] | null): void;
  subscribe(listener: () => void): () => void;
}

export function createMentionDirectory(
  initial: readonly MentionCandidate[] | null = null,
): MentionDirectory {
  let byUserId: ReadonlyMap<string, MentionCandidate> | null =
    initial === null ? null : new Map(initial.map((member) => [member.userId, member]));
  const listeners = new Set<() => void>();

  return {
    resolve: (userId: string): MentionResolution => {
      if (byUserId === null) return { kind: "unknown" };
      const member = byUserId.get(userId);
      return member === undefined ? { kind: "former" } : { kind: "current", name: member.name };
    },
    setMembers: (members: readonly MentionCandidate[] | null): void => {
      byUserId = members === null ? null : new Map(members.map((m) => [m.userId, m]));
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Project an authorized member page onto mention candidates. */
export function mentionCandidates(page: WorkspaceMemberPage): readonly MentionCandidate[] {
  return page.items.map((member) => ({
    userId: member.userId,
    name: member.name,
    email: member.email,
    role: member.role,
  }));
}

/**
 * Whether a document contains at least one `mention` node.
 *
 * Used to decide whether the member directory is needed up front: only a note
 * that already stores mentions has anything to resolve on load. A note without
 * them fetches nothing until the reader actually types `@`, at which point the
 * search populates the same cache entry. Reads raw JSON rather than a validated
 * document because it only gates a fetch — a false negative costs one lazy
 * request, never correctness.
 */
export function documentHasMention(document: unknown): boolean {
  if (Array.isArray(document)) return document.some(documentHasMention);
  if (typeof document !== "object" || document === null) return false;
  const node: Record<string, unknown> = document as Record<string, unknown>;
  if (node.type === "mention") return true;
  return documentHasMention(node.content);
}

/** How many candidates the popup shows at once. */
export const MENTION_RESULT_LIMIT = 8;

/**
 * Filter candidates by name or email. Matching is done on the already-fetched,
 * workspace-scoped list: the query string never reaches a request path, so it
 * can never be used to widen the search beyond this workspace.
 */
export function filterMentionCandidates(
  query: string,
  candidates: readonly MentionCandidate[],
  limit: number = MENTION_RESULT_LIMIT,
): readonly MentionCandidate[] {
  const needle = query.trim().toLowerCase();
  const matches =
    needle.length === 0
      ? candidates
      : candidates.filter(
          (candidate) =>
            candidate.name.toLowerCase().includes(needle) ||
            candidate.email.toLowerCase().includes(needle),
        );
  return matches.slice(0, limit);
}

export const MENTION_SEARCH_DEBOUNCE_MS = 150;

export interface DebouncedSearch<TItem> {
  (query: string): Promise<readonly TItem[]>;
  readonly cancel: () => void;
}

/**
 * Collapse a burst of keystrokes into one lookup.
 *
 * A superseded call resolves with no results rather than hanging, and the popup
 * additionally discards any settled result whose query is no longer the one on
 * screen (`useSuggestionPopup`), so a slow response can never overwrite a
 * faster, newer one.
 */
export function createDebouncedSearch<TItem>(
  search: (query: string) => Promise<readonly TItem[]>,
  delayMs: number = MENTION_SEARCH_DEBOUNCE_MS,
): DebouncedSearch<TItem> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let supersede: (() => void) | null = null;

  const debounced = (query: string): Promise<readonly TItem[]> =>
    new Promise<readonly TItem[]>((resolve, reject) => {
      if (timer !== null) clearTimeout(timer);
      supersede?.();
      supersede = () => resolve([]);
      timer = setTimeout(() => {
        timer = null;
        supersede = null;
        search(query).then(resolve, reject);
      }, delayMs);
    });

  debounced.cancel = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    supersede?.();
    supersede = null;
  };

  return debounced;
}
