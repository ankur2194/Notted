import type { NoteRequestFailureKind } from "./requests";
import type { PageSize } from "@notted/shared-types";
import type { NoteDocument, UpdateNoteInput } from "@notted/shared-validators";

// A pure, DOM-free value comparison. It lives beside the editor because that is
// where the key-order problem it solves comes from, and it is imported rather
// than duplicated so the dirty check and the editor's reconciliation can never
// disagree about what counts as the same document.
import { areDocumentsEquivalent } from "@/components/editor/document-sync";

/**
 * Reliable-save state machine (Plan Part 39).
 *
 * Pure and framework-free on purpose: no React, no timers, no `fetch`. Events
 * go in, `{ state, effects }` comes out, and `useNoteAutosave` is the only place
 * that turns an effect into a timer or a request. Every scenario the Plan asks
 * to be proven — rapid typing, slow responses, out-of-order responses, network
 * loss, tab close, version conflicts — is therefore reproducible without a DOM.
 *
 * THE SHAPE-DETERMINING CONSTRAINT
 *
 * `apps/api/src/notes/notes.service.ts` bumps `version` by exactly one on
 * *every* update, including a page-size-only change. So there is exactly one
 * version cell and at most one request in flight here, and a pending content
 * change and a pending page-size change are coalesced into a single PATCH.
 * Two independent mutations would invalidate each other's `expectedVersion`
 * on almost every interleaving.
 *
 * WHAT IS NEVER DONE
 *
 * - A version is never guessed or incremented locally. It is seeded from the
 *   server render and thereafter replaced only by the version the server
 *   returns on a successful update.
 * - A `version-conflict` is never retried, and the local document is never
 *   re-sent over a newer server version. The machine halts and waits for an
 *   explicit human decision.
 * - Nothing is written to browser storage. Part 32 established that no note
 *   content reaches `localStorage` or IndexedDB; an offline queue here is
 *   in-memory only, and the UI says plainly that closing the tab loses it.
 */

/** How long typing must pause before a content save is issued. */
export const AUTOSAVE_DEBOUNCE_MS = 800;

/** Retries after the first failure, for retryable failures only. */
export const AUTOSAVE_MAX_ATTEMPTS = 4;

export const AUTOSAVE_BASE_BACKOFF_MS = 1_000;
export const AUTOSAVE_MAX_BACKOFF_MS = 30_000;

export type AutosaveStatus =
  "idle" | "dirty" | "saving" | "saved" | "retrying" | "error" | "conflict" | "offline";

export interface AutosaveFailure {
  readonly kind: NoteRequestFailureKind;
  /** Retries already spent when this failure became terminal. */
  readonly attempts: number;
}

/** The patch that is currently on the wire, tagged with its own identifier. */
export interface AutosaveInFlight {
  readonly saveId: number;
  readonly document: NoteDocument | null;
  readonly pageSize: PageSize | null;
}

export interface AutosaveState {
  readonly status: AutosaveStatus;
  /** The only version cell. Server-seeded, server-replaced, never derived. */
  readonly version: number;
  /** Exactly what the server most recently acknowledged storing. */
  readonly savedDocument: NoteDocument | null;
  readonly savedPageSize: PageSize;
  readonly pendingDocument: NoteDocument | null;
  readonly pendingPageSize: PageSize | null;
  readonly inFlight: AutosaveInFlight | null;
  /** Monotonic; the newest identifier ever issued. */
  readonly lastSaveId: number;
  readonly attempt: number;
  readonly online: boolean;
  readonly failure: AutosaveFailure | null;
  /** The editor produced JSON the note contract rejects; surfaced, never silent. */
  readonly documentRejected: boolean;
}

export type AutosaveEffect =
  | { readonly kind: "schedule-debounce"; readonly delayMs: number }
  | { readonly kind: "cancel-debounce" }
  | { readonly kind: "schedule-retry"; readonly delayMs: number }
  | { readonly kind: "cancel-retry" }
  | {
      readonly kind: "save";
      readonly saveId: number;
      readonly input: UpdateNoteInput;
      /** True for a navigation flush, which must survive the document. */
      readonly keepalive: boolean;
    };

/** What a successful update told us the server now holds. */
export interface AutosaveAcknowledgement {
  readonly version: number;
  readonly pageSize: PageSize;
}

export type AutosaveEvent =
  | { readonly type: "document-changed"; readonly document: NoteDocument }
  /**
   * The editor's own serialization of the document it was opened with.
   *
   * Needed because ProseMirror fills in default attributes the stored contract
   * document omits, so the server's JSON and the editor's JSON for the *same*
   * content are not byte-identical. Without this baseline, typing a character
   * and deleting it again would look like a real change and issue a pointless
   * save. It is accepted only while nothing has been queued or saved yet, so it
   * can never overwrite a genuine acknowledgement.
   */
  | { readonly type: "document-baseline"; readonly document: NoteDocument }
  | { readonly type: "document-rejected"; readonly rejected: boolean }
  | { readonly type: "page-size-changed"; readonly pageSize: PageSize }
  | { readonly type: "debounce-elapsed" }
  | { readonly type: "retry-elapsed" }
  | { readonly type: "flush"; readonly keepalive: boolean }
  | {
      readonly type: "save-succeeded";
      readonly saveId: number;
      readonly note: AutosaveAcknowledgement;
    }
  | {
      readonly type: "save-failed";
      readonly saveId: number;
      readonly kind: NoteRequestFailureKind;
      readonly retryable?: boolean;
      readonly retryAfterMs?: number;
    }
  | { readonly type: "online-changed"; readonly online: boolean }
  | { readonly type: "retry-requested" }
  | {
      readonly type: "reset";
      readonly version: number;
      readonly pageSize: PageSize;
      readonly document: NoteDocument | null;
    };

export interface AutosaveTransition {
  readonly state: AutosaveState;
  readonly effects: readonly AutosaveEffect[];
}

export interface AutosaveSeed {
  readonly version: number;
  readonly pageSize: PageSize;
  readonly document?: NoteDocument | null;
  readonly online?: boolean;
}

export function createAutosaveState(seed: AutosaveSeed): AutosaveState {
  return {
    status: "idle",
    version: seed.version,
    savedDocument: seed.document ?? null,
    savedPageSize: seed.pageSize,
    pendingDocument: null,
    pendingPageSize: null,
    inFlight: null,
    lastSaveId: 0,
    attempt: 0,
    online: seed.online ?? true,
    failure: null,
    documentRejected: false,
  };
}

export function hasPendingWork(state: AutosaveState): boolean {
  return state.pendingDocument !== null || state.pendingPageSize !== null;
}

/**
 * Anything the server has not acknowledged yet. Drives the `beforeunload`
 * guard, so it deliberately counts the in-flight patch too: a request that has
 * not answered has not saved.
 */
export function hasUnsavedWork(state: AutosaveState): boolean {
  return hasPendingWork(state) || state.inFlight !== null;
}

/** Exponential backoff, honouring a server-advised delay when there is one. */
export function backoffDelayMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    return Math.min(retryAfterMs, AUTOSAVE_MAX_BACKOFF_MS);
  }
  const exponent = Math.max(attempt - 1, 0);
  return Math.min(AUTOSAVE_BASE_BACKOFF_MS * 2 ** exponent, AUTOSAVE_MAX_BACKOFF_MS);
}

/**
 * Drop a pending value that has become identical to what the server holds.
 *
 * This is what makes a document typed and then undone back to the saved value
 * produce no request at all, and it uses the key-order-independent comparison
 * from `document-sync` because the contract's key order and ProseMirror's
 * differ.
 */
function normalizePending(state: AutosaveState): AutosaveState {
  // Compared against what the server will hold once the open request lands, not
  // against what it holds right now. Pressing "A4" while an "US Letter" save is
  // on the wire is a real change and must not be discarded as a no-op.
  const settled = state.inFlight?.document ?? state.savedDocument;
  const settledPageSize = state.inFlight?.pageSize ?? state.savedPageSize;
  const pendingDocument =
    state.pendingDocument !== null && areDocumentsEquivalent(state.pendingDocument, settled)
      ? null
      : state.pendingDocument;
  const pendingPageSize = state.pendingPageSize === settledPageSize ? null : state.pendingPageSize;
  if (pendingDocument === state.pendingDocument && pendingPageSize === state.pendingPageSize) {
    return state;
  }
  return { ...state, pendingDocument, pendingPageSize };
}

/**
 * Whether a request could be issued from this state right now.
 *
 * Exported because the hook needs the same answer outside the reducer, when the
 * component is being torn down by an in-app navigation and there is no longer a
 * machine to dispatch into.
 */
export function canSaveNow(state: AutosaveState): boolean {
  return (
    state.online && state.inFlight === null && state.status !== "conflict" && hasPendingWork(state)
  );
}

/**
 * The single coalesced patch for everything currently queued, or `null` when
 * nothing is. One `expectedVersion`, content and settings together.
 */
export function pendingSaveInput(state: AutosaveState): UpdateNoteInput | null {
  if (!hasPendingWork(state)) return null;
  return {
    expectedVersion: state.version,
    ...(state.pendingDocument !== null ? { content: state.pendingDocument } : {}),
    ...(state.pendingPageSize !== null ? { pageSize: state.pendingPageSize } : {}),
  };
}

/** The status to settle on when there is nothing left to send. */
function restingStatus(state: AutosaveState): AutosaveStatus {
  if (state.inFlight !== null) return "saving";
  if (state.status === "conflict") return "conflict";
  if (state.status === "saved") return "saved";
  return "idle";
}

function startSave(state: AutosaveState, keepalive: boolean): AutosaveTransition {
  const saveId = state.lastSaveId + 1;
  // ONE patch, ONE `expectedVersion`. Splitting content and settings apart here
  // is what would make the two saves fight over the same version cell.
  const input = pendingSaveInput(state);
  if (input === null) return { state, effects: [] };
  return {
    state: {
      ...state,
      status: "saving",
      lastSaveId: saveId,
      inFlight: { saveId, document: state.pendingDocument, pageSize: state.pendingPageSize },
      pendingDocument: null,
      pendingPageSize: null,
      failure: null,
    },
    effects: [
      { kind: "cancel-debounce" },
      { kind: "cancel-retry" },
      { kind: "save", saveId, input, keepalive },
    ],
  };
}

/**
 * Put an unacknowledged patch back on the queue.
 *
 * Anything the user did *while* the request was in flight is newer and wins.
 * `keepSettings` is false for a terminal outcome: a page-size toggle is a
 * discrete control whose pressed state must not keep claiming a change that
 * definitively did not happen, whereas the document can never be rolled back
 * without destroying what the person wrote.
 */
function requeue(
  state: AutosaveState,
  inFlight: AutosaveInFlight,
  keepSettings: boolean,
): AutosaveState {
  return normalizePending({
    ...state,
    inFlight: null,
    pendingDocument: state.pendingDocument ?? inFlight.document,
    pendingPageSize: keepSettings
      ? (state.pendingPageSize ?? inFlight.pageSize)
      : state.pendingPageSize,
  });
}

/** Decide what to do once new work has been queued. */
function scheduleQueued(state: AutosaveState, debounce: boolean): AutosaveTransition {
  if (!hasPendingWork(state)) {
    return {
      state: { ...state, status: restingStatus(state) },
      effects: [{ kind: "cancel-debounce" }],
    };
  }
  if (state.status === "conflict") {
    // Held in memory, never sent: the server is ahead of us.
    return { state, effects: [{ kind: "cancel-debounce" }, { kind: "cancel-retry" }] };
  }
  if (!state.online) {
    return {
      state: { ...state, status: "offline" },
      effects: [{ kind: "cancel-debounce" }, { kind: "cancel-retry" }],
    };
  }
  if (state.inFlight !== null) {
    // One request at a time. This becomes the next patch, not a second call.
    return { state: { ...state, status: "saving" }, effects: [] };
  }
  if (state.status === "retrying") {
    // A backoff timer is already running and will pick the merged patch up.
    return { state, effects: [] };
  }
  if (!debounce) return startSave(state, false);
  return {
    state: { ...state, status: "dirty" },
    effects: [{ kind: "schedule-debounce", delayMs: AUTOSAVE_DEBOUNCE_MS }],
  };
}

function onSaveFailed(
  state: AutosaveState,
  event: Extract<AutosaveEvent, { type: "save-failed" }>,
): AutosaveTransition {
  const inFlight = state.inFlight;
  // OUT-OF-ORDER GUARD. A result whose identifier is not the current in-flight
  // one is from a superseded request; adopting it could regress the version or
  // resurrect content the user has already moved past.
  if (inFlight === null || inFlight.saveId !== event.saveId) return { state, effects: [] };

  if (event.kind === "version-conflict") {
    return {
      state: {
        ...requeue(state, inFlight, true),
        status: "conflict",
        attempt: 0,
        failure: { kind: event.kind, attempts: state.attempt },
      },
      effects: [{ kind: "cancel-debounce" }, { kind: "cancel-retry" }],
    };
  }

  const retryable = event.kind === "unavailable" && event.retryable !== false;

  if (retryable && !state.online) {
    return {
      state: { ...requeue(state, inFlight, true), status: "offline", attempt: 0, failure: null },
      effects: [{ kind: "cancel-debounce" }, { kind: "cancel-retry" }],
    };
  }

  if (retryable && state.attempt < AUTOSAVE_MAX_ATTEMPTS) {
    const attempt = state.attempt + 1;
    return {
      state: { ...requeue(state, inFlight, true), status: "retrying", attempt, failure: null },
      effects: [
        { kind: "cancel-debounce" },
        { kind: "schedule-retry", delayMs: backoffDelayMs(attempt, event.retryAfterMs) },
      ],
    };
  }

  return {
    state: {
      ...requeue(state, inFlight, false),
      status: "error",
      attempt: 0,
      failure: { kind: event.kind, attempts: state.attempt },
    },
    effects: [{ kind: "cancel-debounce" }, { kind: "cancel-retry" }],
  };
}

function onSaveSucceeded(
  state: AutosaveState,
  event: Extract<AutosaveEvent, { type: "save-succeeded" }>,
): AutosaveTransition {
  const inFlight = state.inFlight;
  if (inFlight === null || inFlight.saveId !== event.saveId) return { state, effects: [] };

  const acknowledged: AutosaveState = normalizePending({
    ...state,
    version: event.note.version,
    // A settings-only save carried no document, so the last acknowledged
    // document stands unchanged rather than being blanked.
    savedDocument: inFlight.document ?? state.savedDocument,
    savedPageSize: event.note.pageSize,
    inFlight: null,
    attempt: 0,
    failure: null,
    status: "saved",
  });

  // Whatever arrived during the save now becomes the next patch. A settings
  // press that had to wait is sent straight away rather than serving a second
  // debounce it never asked for; text goes back through the debounce.
  return scheduleQueued(acknowledged, acknowledged.pendingPageSize === null);
}

export function autosaveReducer(state: AutosaveState, event: AutosaveEvent): AutosaveTransition {
  switch (event.type) {
    case "document-changed": {
      const queued = normalizePending({
        ...state,
        pendingDocument: event.document,
        // A fresh edit clears a terminal error: the new content may well be
        // acceptable where the last one was not.
        failure: state.status === "error" ? null : state.failure,
      });
      return scheduleQueued(queued, true);
    }

    case "page-size-changed": {
      const queued = normalizePending({
        ...state,
        pendingPageSize: event.pageSize,
        failure: state.status === "error" ? null : state.failure,
      });
      // A discrete control press is an explicit act, so it is not debounced; it
      // flushes immediately and carries any pending content along with it.
      return scheduleQueued(queued, false);
    }

    case "document-baseline": {
      // Only ever the *first* word on what the server holds, and never a
      // substitute for an acknowledgement: once anything has been sent, the
      // server's answer is the only thing allowed to move this.
      if (state.savedDocument !== null || state.inFlight !== null || state.lastSaveId !== 0) {
        return { state, effects: [] };
      }
      const seeded = normalizePending({ ...state, savedDocument: event.document });
      // Mounting the editor can emit one transaction that merely re-serializes
      // the loaded content. Recognizing it as equal to the baseline is what
      // stops opening a note from writing to it.
      if (hasPendingWork(seeded)) return { state: seeded, effects: [] };
      return {
        state: { ...seeded, status: restingStatus(seeded) },
        effects: [{ kind: "cancel-debounce" }],
      };
    }

    case "document-rejected":
      return { state: { ...state, documentRejected: event.rejected }, effects: [] };

    case "debounce-elapsed":
    case "retry-elapsed":
      return canSaveNow(state) ? startSave(state, false) : { state, effects: [] };

    case "flush":
      return canSaveNow(state)
        ? startSave(state, event.keepalive)
        : { state, effects: [{ kind: "cancel-debounce" }] };

    case "save-succeeded":
      return onSaveSucceeded(state, event);

    case "save-failed":
      return onSaveFailed(state, event);

    case "online-changed": {
      if (!event.online) {
        const offline: AutosaveState = { ...state, online: false };
        const status: AutosaveStatus =
          state.status === "conflict" || !hasPendingWork(state) ? state.status : "offline";
        return {
          state: { ...offline, status },
          effects: [{ kind: "cancel-debounce" }, { kind: "cancel-retry" }],
        };
      }
      const online: AutosaveState = { ...state, online: true, attempt: 0 };
      if (state.status === "conflict") return { state: online, effects: [] };
      if (!hasPendingWork(online)) {
        return { state: { ...online, status: restingStatus(online) }, effects: [] };
      }
      if (online.inFlight !== null) return { state: { ...online, status: "saving" }, effects: [] };
      return {
        state: { ...online, status: "dirty" },
        effects: [{ kind: "schedule-debounce", delayMs: AUTOSAVE_DEBOUNCE_MS }],
      };
    }

    case "retry-requested": {
      // A conflict is never resolved by retrying: that is precisely the write
      // that would overwrite a newer server version.
      if (state.status === "conflict") return { state, effects: [] };
      const cleared: AutosaveState = { ...state, attempt: 0, failure: null };
      if (canSaveNow(cleared)) return startSave(cleared, false);
      if (!cleared.online && hasPendingWork(cleared)) {
        return { state: { ...cleared, status: "offline" }, effects: [] };
      }
      return { state: { ...cleared, status: restingStatus(cleared) }, effects: [] };
    }

    case "reset":
      // Dropping `inFlight` also invalidates any response still on its way:
      // its identifier can no longer match, so it is discarded on arrival.
      return {
        state: {
          ...createAutosaveState({
            version: event.version,
            pageSize: event.pageSize,
            document: event.document,
            online: state.online,
          }),
          lastSaveId: state.lastSaveId,
        },
        effects: [{ kind: "cancel-debounce" }, { kind: "cancel-retry" }],
      };

    default:
      return { state, effects: [] };
  }
}

export interface AutosaveDescription {
  readonly message: string;
  readonly canRetry: boolean;
  readonly canReload: boolean;
  readonly severity: "info" | "warning" | "error";
}

/**
 * Every word shown to a person is written here, from the failure *kind* only.
 * A backend message is never displayed verbatim — the same rule
 * `NoteBrowser.failureMessage` follows.
 */
export function describeAutosave(state: AutosaveState): AutosaveDescription {
  switch (state.status) {
    case "saving":
      return { message: "Saving…", canRetry: false, canReload: false, severity: "info" };
    case "saved":
      return { message: "Saved.", canRetry: false, canReload: false, severity: "info" };
    case "dirty":
      return { message: "Unsaved changes.", canRetry: false, canReload: false, severity: "info" };
    case "retrying":
      return {
        message: "Couldn't reach Notted. Retrying…",
        canRetry: false,
        canReload: false,
        severity: "warning",
      };
    case "offline":
      return {
        message:
          "Offline. Your changes are not saved yet, and they will be lost if you close this tab before you reconnect.",
        canRetry: false,
        canReload: false,
        severity: "warning",
      };
    case "conflict":
      return {
        message:
          "This note changed somewhere else, so your changes were not saved. Reloading brings in the newer version and discards the changes you made here.",
        canRetry: false,
        canReload: true,
        severity: "error",
      };
    case "error":
      return describeFailure(state.failure);
    default:
      return {
        message: "No unsaved changes.",
        canRetry: false,
        canReload: false,
        severity: "info",
      };
  }
}

function describeFailure(failure: AutosaveFailure | null): AutosaveDescription {
  if (failure === null || failure.kind === "unavailable") {
    return {
      message: "Couldn't save your changes. Check your connection, then retry.",
      canRetry: true,
      canReload: false,
      severity: "error",
    };
  }
  if (failure.kind === "forbidden-or-not-found") {
    // No reload is offered: the note may have been deleted or unshared outright,
    // so reloading would replace an accurate warning with a not-found page. And
    // no retry: the identical request would be refused identically.
    return {
      message:
        "Saving was denied, or this note is no longer available to you. Your changes are not saved.",
      canRetry: false,
      canReload: false,
      severity: "error",
    };
  }
  if (failure.kind === "conflict") {
    return {
      message:
        "Your changes conflicted with a recent change and were not saved. Reload before trying again.",
      canRetry: false,
      canReload: true,
      severity: "error",
    };
  }
  return {
    message: "Notted did not accept this change, so it was not saved.",
    canRetry: true,
    canReload: false,
    severity: "error",
  };
}

/** The page size to *display*: the requested one until the server disagrees. */
export function effectivePageSize(state: AutosaveState): PageSize {
  return state.pendingPageSize ?? state.inFlight?.pageSize ?? state.savedPageSize;
}
