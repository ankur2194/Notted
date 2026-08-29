// The fractional sort-order arithmetic shared by notes and tasks.
//
// Both services keep a `sort_order` per sibling group and insert between two
// neighbours by taking their midpoint, renumbering the group when the gaps run
// out. The three functions below were duplicated line for line in
// `notes.service.ts` and `tasks.service.ts` — including `gapExhausted`'s
// index arithmetic, which is the part nobody wants to re-derive.
//
// WHAT IS *NOT* SHARED, AND WHY. The two services genuinely disagree in ways
// that are deliberate, so the differences are parameters here rather than
// something a merge quietly picked a winner for:
//
//   - A MISSING ANCHOR. Notes answer 404 `NOT_FOUND`: a note id is a resource
//     the caller may not be entitled to know exists, and answering "no such
//     order" would confirm it does. Tasks answer 409 `ORDER_CONFLICT`, because
//     a task anchor that has moved out of the group IS an ordinary concurrent
//     edit and the client should retry. `tasks.service.test.ts` asserts that
//     status, code and message exactly, so this is not a free choice.
//
//   - A SOFT-DELETED ANCHOR. Notes refuse to position against one; tasks have
//     no soft-delete concept. NOTHING IN THE SUITE COVERS THIS: every test was
//     searched for a `beforeNoteId` pointing at a soft-deleted note and there
//     is none, so it is preserved by inspection and by `rejectAnchor` being
//     required to say so out loud.
//
// THE ADVISORY-LOCK KEYS STAY IN THEIR SERVICES, deliberately. PostgreSQL
// advisory locks share ONE namespace per database, and neither key carries a
// table discriminator — `notes.containerKey` joins with ":" and
// `tasks.groupKey` joins with "|", and that separator is the only thing keeping
// a note container and a task group from hashing to the same lock. Unifying
// them here would look like tidying and would serialize unrelated writes
// against each other. If they are ever unified, prefix them first.

/** The minimum a row must carry to be ordered. */
export interface OrderableSibling {
  readonly id: string;
  readonly sortOrder: number;
}

export interface AnchorPolicy<T extends OrderableSibling> {
  /** The anchor id is not in this group. Notes throw 404; tasks throw 409. */
  readonly onMissingAnchor: () => never;
  /**
   * The anchor exists but may not be positioned against — a soft-deleted note.
   * Required rather than optional: a caller that has no such state says so with
   * `() => false`, which is a decision, and an omitted callback would be a
   * silent one.
   */
  readonly rejectAnchor: (row: T) => boolean;
  /** What to throw when `rejectAnchor` refuses. */
  readonly onRejectedAnchor: () => never;
}

/**
 * Where a row goes: the midpoint before `beforeId`, or one past the end.
 *
 * Returns a possibly-fractional order. The caller checks it for exhaustion —
 * `gapExhausted` — and renormalizes before trying again.
 */
export function calculatePosition<T extends OrderableSibling>(
  siblings: readonly T[],
  beforeId: string | null,
  policy: AnchorPolicy<T>,
): number {
  if (beforeId !== null) {
    const index = siblings.findIndex((row) => row.id === beforeId);
    if (index < 0) policy.onMissingAnchor();
    const anchor = siblings[index]!;
    if (policy.rejectAnchor(anchor)) policy.onRejectedAnchor();
    if (index === 0) return siblings[0]!.sortOrder - 1;
    return (siblings[index - 1]!.sortOrder + anchor.sortOrder) / 2;
  }
  if (siblings.length === 0) return 1;
  return siblings[siblings.length - 1]!.sortOrder + 1;
}

/**
 * Has the gap closed? A midpoint that equals one of its neighbours means
 * float precision has run out and the group must be renumbered.
 */
export function gapExhausted<T extends OrderableSibling>(
  siblings: readonly T[],
  beforeId: string | null,
  position: number,
): boolean {
  if (beforeId === null || siblings.length === 0) return position === siblings.at(-1)?.sortOrder;
  const index = siblings.findIndex((row) => row.id === beforeId);
  if (index <= 0) return position === siblings[0]?.sortOrder;
  return position === siblings[index - 1]?.sortOrder || position === siblings[index]?.sortOrder;
}

/** A duplicated or non-finite order means the group is already inconsistent. */
export function requiresRenormalization(rows: readonly OrderableSibling[]): boolean {
  const values = new Set<number>();
  for (const row of rows) {
    if (!Number.isFinite(row.sortOrder) || values.has(row.sortOrder)) return true;
    values.add(row.sortOrder);
  }
  return false;
}
