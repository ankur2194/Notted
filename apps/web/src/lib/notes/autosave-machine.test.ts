import { describe, expect, it } from "vitest";

import {
  AUTOSAVE_DEBOUNCE_MS,
  AUTOSAVE_MAX_ATTEMPTS,
  autosaveReducer,
  backoffDelayMs,
  createAutosaveState,
  describeAutosave,
  effectivePageSize,
  hasUnsavedWork,
  type AutosaveEffect,
  type AutosaveEvent,
  type AutosaveState,
} from "./autosave-machine";

import type { PageSize } from "@notted/shared-types";
import type { NoteDocument, UpdateNoteInput } from "@notted/shared-validators";

/**
 * The whole Plan Part 39 verify list, proven without a DOM, a timer, or a
 * request. That is the point of keeping the machine pure: rapid typing, slow
 * responses, out-of-order responses, network loss, tab close, and version
 * conflicts are all just event sequences here.
 */

function doc(text: string): NoteDocument {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

/** The same content with a different key order, as ProseMirror may emit it. */
function reorderedDoc(text: string): NoteDocument {
  return { content: [{ content: [{ text, type: "text" }], type: "paragraph" }], type: "doc" };
}

type SaveEffect = Extract<AutosaveEffect, { kind: "save" }>;

class Harness {
  public state: AutosaveState;
  /** Every effect ever emitted, in order. */
  public readonly log: AutosaveEffect[] = [];

  public constructor(
    seed: { version?: number; pageSize?: PageSize; document?: NoteDocument } = {},
  ) {
    this.state = createAutosaveState({
      version: seed.version ?? 3,
      pageSize: seed.pageSize ?? "a4",
      document: seed.document ?? null,
    });
  }

  public send(event: AutosaveEvent): readonly AutosaveEffect[] {
    const transition = autosaveReducer(this.state, event);
    this.state = transition.state;
    this.log.push(...transition.effects);
    return transition.effects;
  }

  /** Emit the effects of one event only. */
  public saveFrom(effects: readonly AutosaveEffect[]): SaveEffect | undefined {
    return effects.find((effect): effect is SaveEffect => effect.kind === "save");
  }

  public get saves(): readonly SaveEffect[] {
    return this.log.filter((effect): effect is SaveEffect => effect.kind === "save");
  }

  public get inputs(): readonly UpdateNoteInput[] {
    return this.saves.map((effect) => effect.input);
  }

  /** Type, wait out the debounce, and return the request that was issued. */
  public type(text: string): SaveEffect | undefined {
    this.send({ type: "document-changed", document: doc(text) });
    return this.saveFrom(this.send({ type: "debounce-elapsed" }));
  }

  public ack(saveId: number, version: number, pageSize: PageSize = "a4"): void {
    this.send({ type: "save-succeeded", saveId, note: { version, pageSize } });
  }
}

describe("autosave machine: debouncing and dirty detection", () => {
  it("coalesces rapid typing into a single request carrying the newest content", () => {
    const machine = new Harness();
    for (const text of ["h", "he", "hel", "hell", "hello"]) {
      const effects = machine.send({ type: "document-changed", document: doc(text) });
      expect(machine.saveFrom(effects)).toBeUndefined();
      expect(effects).toContainEqual({ kind: "schedule-debounce", delayMs: AUTOSAVE_DEBOUNCE_MS });
    }
    expect(machine.state.status).toBe("dirty");

    machine.send({ type: "debounce-elapsed" });
    expect(machine.saves).toHaveLength(1);
    expect(machine.inputs[0]).toEqual({ expectedVersion: 3, content: doc("hello") });
    expect(machine.state.status).toBe("saving");
  });

  it("issues nothing for a document edited back to the value the server holds", () => {
    const machine = new Harness();
    machine.send({ type: "document-baseline", document: doc("hello") });

    machine.send({ type: "document-changed", document: doc("hello!") });
    expect(machine.state.status).toBe("dirty");

    const effects = machine.send({ type: "document-changed", document: doc("hello") });
    expect(effects).toContainEqual({ kind: "cancel-debounce" });
    expect(machine.state.status).toBe("idle");

    machine.send({ type: "debounce-elapsed" });
    expect(machine.saves).toHaveLength(0);
  });

  it("compares by value, not by key order, so re-serialization is not a change", () => {
    const machine = new Harness();
    machine.send({ type: "document-baseline", document: doc("hello") });
    machine.send({ type: "document-changed", document: reorderedDoc("hello") });

    expect(machine.state.status).toBe("idle");
    machine.send({ type: "debounce-elapsed" });
    expect(machine.saves).toHaveLength(0);
  });

  it("lets the baseline absorb the transaction the editor emits when it mounts", () => {
    const machine = new Harness();
    // Opening a note can emit one transaction that merely re-serializes the
    // loaded content, and it arrives before the editor reports itself ready.
    machine.send({ type: "document-changed", document: doc("hello") });
    machine.send({ type: "document-baseline", document: doc("hello") });

    expect(machine.state.status).toBe("idle");
    expect(machine.state.pendingDocument).toBeNull();
    machine.send({ type: "debounce-elapsed" });
    expect(machine.saves).toHaveLength(0);
  });

  it("never lets a baseline discard content that differs from it", () => {
    const machine = new Harness();
    machine.send({ type: "document-changed", document: doc("typed") });
    machine.send({ type: "document-baseline", document: doc("as loaded") });

    expect(machine.state.pendingDocument).toEqual(doc("typed"));
    machine.send({ type: "debounce-elapsed" });
    expect(machine.inputs.at(-1)).toEqual({ expectedVersion: 3, content: doc("typed") });
  });

  it("is never mistaken for an acknowledgement once a request has been issued", () => {
    const machine = new Harness();
    machine.type("typed");
    machine.ack(1, 4);

    machine.send({ type: "document-baseline", document: doc("stale baseline") });
    expect(machine.state.savedDocument).toEqual(doc("typed"));
    expect(machine.state.version).toBe(4);
  });
});

describe("autosave machine: one request at a time", () => {
  it("holds changes made during a save and sends them as the next patch", () => {
    const machine = new Harness();
    machine.type("first");
    expect(machine.saves).toHaveLength(1);

    // Slow response: the user keeps typing while the request is outstanding.
    machine.send({ type: "document-changed", document: doc("first and second") });
    expect(machine.state.status).toBe("saving");
    machine.send({ type: "debounce-elapsed" });
    expect(machine.saves).toHaveLength(1);

    machine.ack(1, 4);
    expect(machine.state.status).toBe("dirty");
    expect(machine.state.version).toBe(4);

    machine.send({ type: "debounce-elapsed" });
    expect(machine.saves).toHaveLength(2);
    expect(machine.inputs[1]).toEqual({ expectedVersion: 4, content: doc("first and second") });
  });

  it("never sends a second concurrent request, whatever arrives while one is open", () => {
    const machine = new Harness();
    machine.type("a");
    machine.send({ type: "document-changed", document: doc("ab") });
    machine.send({ type: "page-size-changed", pageSize: "letter" });
    machine.send({ type: "debounce-elapsed" });
    machine.send({ type: "retry-elapsed" });
    machine.send({ type: "flush", keepalive: true });
    machine.send({ type: "retry-requested" });

    expect(machine.saves).toHaveLength(1);
    expect(machine.state.inFlight?.saveId).toBe(1);
  });
});

describe("autosave machine: out-of-order responses", () => {
  it("discards a success whose identifier is not the request in flight", () => {
    const machine = new Harness();
    machine.type("first");
    machine.ack(1, 4);
    machine.send({ type: "debounce-elapsed" });

    machine.send({ type: "document-changed", document: doc("second") });
    machine.send({ type: "debounce-elapsed" });
    expect(machine.state.inFlight?.saveId).toBe(2);

    // The first request answers a second time, late, claiming an older version.
    machine.send({ type: "save-succeeded", saveId: 1, note: { version: 2, pageSize: "letter" } });

    expect(machine.state.version).toBe(4);
    expect(machine.state.savedPageSize).toBe("a4");
    expect(machine.state.inFlight?.saveId).toBe(2);
    expect(machine.state.status).toBe("saving");
  });

  it("cannot let a stale success clobber newer acknowledged content", () => {
    const machine = new Harness();
    machine.type("first");
    machine.ack(1, 4);
    machine.send({ type: "document-changed", document: doc("second") });
    machine.send({ type: "debounce-elapsed" });
    machine.ack(2, 5);
    expect(machine.state.savedDocument).toEqual(doc("second"));

    machine.send({ type: "save-succeeded", saveId: 1, note: { version: 4, pageSize: "a4" } });
    expect(machine.state.savedDocument).toEqual(doc("second"));
    expect(machine.state.version).toBe(5);
  });

  it("discards a failure whose identifier is not the request in flight", () => {
    const machine = new Harness();
    machine.type("first");
    machine.ack(1, 4);
    machine.send({ type: "document-changed", document: doc("second") });
    machine.send({ type: "debounce-elapsed" });

    machine.send({ type: "save-failed", saveId: 1, kind: "version-conflict" });

    // A superseded request must never be able to halt the machine.
    expect(machine.state.status).toBe("saving");
    expect(machine.state.inFlight?.saveId).toBe(2);
  });
});

describe("autosave machine: transient failures", () => {
  it("retries with exponential backoff and recovers without losing content", () => {
    const machine = new Harness();
    machine.type("draft");

    const first = machine.send({
      type: "save-failed",
      saveId: 1,
      kind: "unavailable",
      retryable: true,
    });
    expect(first).toContainEqual({ kind: "schedule-retry", delayMs: 1_000 });
    expect(machine.state.status).toBe("retrying");
    expect(describeAutosave(machine.state).message).toBe("Couldn't reach Notted. Retrying…");

    machine.send({ type: "retry-elapsed" });
    expect(machine.inputs[1]).toEqual({ expectedVersion: 3, content: doc("draft") });

    const second = machine.send({
      type: "save-failed",
      saveId: 2,
      kind: "unavailable",
      retryable: true,
    });
    expect(second).toContainEqual({ kind: "schedule-retry", delayMs: 2_000 });

    machine.send({ type: "retry-elapsed" });
    machine.ack(3, 4);
    expect(machine.state.status).toBe("saved");
    expect(machine.state.savedDocument).toEqual(doc("draft"));
    expect(machine.state.version).toBe(4);
    expect(hasUnsavedWork(machine.state)).toBe(false);
  });

  it("gives up after a bounded number of attempts and offers an explicit retry", () => {
    const machine = new Harness();
    machine.type("draft");

    for (let attempt = 1; attempt <= AUTOSAVE_MAX_ATTEMPTS; attempt += 1) {
      machine.send({ type: "save-failed", saveId: attempt, kind: "unavailable", retryable: true });
      expect(machine.state.status).toBe("retrying");
      machine.send({ type: "retry-elapsed" });
    }
    const last = machine.send({
      type: "save-failed",
      saveId: AUTOSAVE_MAX_ATTEMPTS + 1,
      kind: "unavailable",
      retryable: true,
    });

    expect(machine.state.status).toBe("error");
    expect(last).not.toContainEqual(expect.objectContaining({ kind: "schedule-retry" }));
    // The writing is still held, so the manual retry has something to send.
    expect(machine.state.pendingDocument).toEqual(doc("draft"));
    const description = describeAutosave(machine.state);
    expect(description.canRetry).toBe(true);
    expect(description.canReload).toBe(false);

    machine.send({ type: "retry-requested" });
    expect(machine.saves).toHaveLength(AUTOSAVE_MAX_ATTEMPTS + 2);
    expect(machine.inputs.at(-1)).toEqual({ expectedVersion: 3, content: doc("draft") });
  });

  it("honours a server-advised Retry-After over its own backoff", () => {
    const machine = new Harness();
    machine.type("draft");
    const effects = machine.send({
      type: "save-failed",
      saveId: 1,
      kind: "unavailable",
      retryable: true,
      retryAfterMs: 12_000,
    });
    expect(effects).toContainEqual({ kind: "schedule-retry", delayMs: 12_000 });
  });

  it("caps its own backoff and clamps an absurd Retry-After", () => {
    expect(backoffDelayMs(1)).toBe(1_000);
    expect(backoffDelayMs(4)).toBe(8_000);
    expect(backoffDelayMs(50)).toBe(30_000);
    expect(backoffDelayMs(1, 600_000)).toBe(30_000);
    expect(backoffDelayMs(1, 0)).toBe(1_000);
  });
});

describe("autosave machine: terminal failures", () => {
  it.each([
    ["invalid" as const, true, false],
    ["forbidden-or-not-found" as const, false, false],
    ["conflict" as const, false, true],
  ])("does not retry a %s failure", (kind, canRetry, canReload) => {
    const machine = new Harness();
    machine.type("draft");
    const effects = machine.send({ type: "save-failed", saveId: 1, kind });

    expect(machine.state.status).toBe("error");
    expect(effects).not.toContainEqual(expect.objectContaining({ kind: "schedule-retry" }));
    expect(machine.saves).toHaveLength(1);
    const description = describeAutosave(machine.state);
    expect(description.canRetry).toBe(canRetry);
    expect(description.canReload).toBe(canReload);
    // The document is still held: rolling text back would destroy the writing.
    expect(machine.state.pendingDocument).toEqual(doc("draft"));
  });

  it("treats a non-retryable outage as terminal rather than looping on it", () => {
    const machine = new Harness();
    machine.type("draft");
    machine.send({ type: "save-failed", saveId: 1, kind: "unavailable", retryable: false });
    expect(machine.state.status).toBe("error");
    expect(machine.log).not.toContainEqual(expect.objectContaining({ kind: "schedule-retry" }));
  });

  it("reverts a page-size change that definitively failed, but never the document", () => {
    const machine = new Harness();
    machine.send({ type: "document-changed", document: doc("draft") });
    machine.send({ type: "page-size-changed", pageSize: "letter" });
    expect(effectivePageSize(machine.state)).toBe("letter");

    machine.send({ type: "save-failed", saveId: 1, kind: "invalid" });

    // A toggle shows a definite state and must not keep claiming a change that
    // did not happen; text has no equivalent rollback that is not data loss.
    expect(effectivePageSize(machine.state)).toBe("a4");
    expect(machine.state.pendingDocument).toEqual(doc("draft"));
  });

  it("lets a fresh edit clear a terminal error and try again", () => {
    const machine = new Harness();
    machine.type("draft");
    machine.send({ type: "save-failed", saveId: 1, kind: "invalid" });
    expect(machine.state.status).toBe("error");

    machine.send({ type: "document-changed", document: doc("draft repaired") });
    expect(machine.state.status).toBe("dirty");
    expect(machine.state.failure).toBeNull();

    machine.send({ type: "debounce-elapsed" });
    expect(machine.inputs.at(-1)).toEqual({
      expectedVersion: 3,
      content: doc("draft repaired"),
    });
  });
});

describe("autosave machine: version conflicts", () => {
  it("halts, keeps the writing in memory, and never re-sends over the newer version", () => {
    const machine = new Harness();
    machine.type("mine");
    machine.send({ type: "save-failed", saveId: 1, kind: "version-conflict" });

    expect(machine.state.status).toBe("conflict");
    expect(machine.state.pendingDocument).toEqual(doc("mine"));

    // Nothing reopens the wire: not more typing, not a timer, not a manual
    // retry, not a settings change, not a navigation flush.
    machine.send({ type: "document-changed", document: doc("mine, more") });
    machine.send({ type: "debounce-elapsed" });
    machine.send({ type: "retry-elapsed" });
    machine.send({ type: "retry-requested" });
    machine.send({ type: "page-size-changed", pageSize: "letter" });
    machine.send({ type: "flush", keepalive: true });
    machine.send({ type: "online-changed", online: false });
    machine.send({ type: "online-changed", online: true });

    expect(machine.saves).toHaveLength(1);
    expect(machine.state.status).toBe("conflict");
    expect(machine.state.version).toBe(3);
  });

  it("offers reload as the only resolution, and says what reloading costs", () => {
    const machine = new Harness();
    machine.type("mine");
    machine.send({ type: "save-failed", saveId: 1, kind: "version-conflict" });

    const description = describeAutosave(machine.state);
    expect(description.canReload).toBe(true);
    expect(description.canRetry).toBe(false);
    expect(description.severity).toBe("error");
    expect(description.message).toMatch(/discards the changes you made here/u);
  });

  it("resumes saving once the reloaded server state re-seeds it", () => {
    const machine = new Harness();
    machine.type("mine");
    machine.send({ type: "save-failed", saveId: 1, kind: "version-conflict" });

    machine.send({ type: "reset", version: 9, pageSize: "letter", document: doc("theirs") });
    expect(machine.state.status).toBe("idle");
    expect(machine.state.version).toBe(9);
    expect(hasUnsavedWork(machine.state)).toBe(false);

    machine.type("theirs plus mine");
    expect(machine.inputs.at(-1)).toEqual({
      expectedVersion: 9,
      content: doc("theirs plus mine"),
    });
  });

  it("discards a response still in flight when the note is re-seeded", () => {
    const machine = new Harness();
    machine.type("draft");
    machine.send({ type: "reset", version: 9, pageSize: "a4", document: doc("theirs") });

    machine.send({ type: "save-succeeded", saveId: 1, note: { version: 4, pageSize: "letter" } });
    expect(machine.state.version).toBe(9);
    expect(machine.state.savedDocument).toEqual(doc("theirs"));
  });
});

describe("autosave machine: offline", () => {
  it("queues changes in memory while offline and resumes on reconnect", () => {
    const machine = new Harness();
    machine.send({ type: "online-changed", online: false });

    machine.send({ type: "document-changed", document: doc("written on a train") });
    expect(machine.state.status).toBe("offline");
    machine.send({ type: "debounce-elapsed" });
    machine.send({ type: "flush", keepalive: true });
    expect(machine.saves).toHaveLength(0);
    expect(describeAutosave(machine.state).message).toMatch(/lost if you close this tab/u);

    const back = machine.send({ type: "online-changed", online: true });
    expect(back).toContainEqual({ kind: "schedule-debounce", delayMs: AUTOSAVE_DEBOUNCE_MS });
    expect(machine.state.status).toBe("dirty");

    machine.send({ type: "debounce-elapsed" });
    expect(machine.inputs.at(-1)).toEqual({
      expectedVersion: 3,
      content: doc("written on a train"),
    });
  });

  it("does not claim to be offline when there is nothing waiting to be saved", () => {
    const machine = new Harness();
    machine.send({ type: "online-changed", online: false });
    expect(machine.state.status).toBe("idle");
  });

  it("parks an in-flight request that fails after the connection dropped", () => {
    const machine = new Harness();
    machine.type("draft");
    machine.send({ type: "online-changed", online: false });
    const effects = machine.send({
      type: "save-failed",
      saveId: 1,
      kind: "unavailable",
      retryable: true,
    });

    expect(machine.state.status).toBe("offline");
    expect(effects).not.toContainEqual(expect.objectContaining({ kind: "schedule-retry" }));
    expect(machine.state.pendingDocument).toEqual(doc("draft"));
  });

  it("reports offline rather than saving when a manual retry is pressed offline", () => {
    const machine = new Harness();
    machine.send({ type: "online-changed", online: false });
    machine.send({ type: "document-changed", document: doc("draft") });
    machine.send({ type: "retry-requested" });

    expect(machine.saves).toHaveLength(0);
    expect(machine.state.status).toBe("offline");
  });
});

describe("autosave machine: content and settings share one version", () => {
  it("coalesces a pending document and a page-size change into one PATCH", () => {
    const machine = new Harness({ version: 7 });
    machine.send({ type: "document-changed", document: doc("body text") });
    const effects = machine.send({ type: "page-size-changed", pageSize: "letter" });

    // One request, one precondition. Two independent mutations would each bump
    // `version` and invalidate the other's `expectedVersion`.
    expect(machine.saves).toHaveLength(1);
    expect(effects).toContainEqual({ kind: "cancel-debounce" });
    expect(machine.inputs[0]).toEqual({
      expectedVersion: 7,
      content: doc("body text"),
      pageSize: "letter",
    });
  });

  it("sends a settings change immediately rather than waiting out the debounce", () => {
    const machine = new Harness();
    const effects = machine.send({ type: "page-size-changed", pageSize: "letter" });
    expect(machine.saveFrom(effects)).toBeDefined();
    expect(machine.inputs[0]).toEqual({ expectedVersion: 3, pageSize: "letter" });
  });

  it("issues nothing when the requested size is the one already stored", () => {
    const machine = new Harness({ pageSize: "a4" });
    machine.send({ type: "page-size-changed", pageSize: "a4" });
    expect(machine.saves).toHaveLength(0);
    expect(machine.state.status).toBe("idle");
  });

  it("adopts the version and size the server returns, never a locally derived one", () => {
    const machine = new Harness({ version: 7 });
    machine.send({ type: "page-size-changed", pageSize: "letter" });
    machine.ack(1, 8, "letter");

    expect(machine.state.version).toBe(8);
    expect(machine.state.savedPageSize).toBe("letter");
    expect(machine.state.status).toBe("saved");

    machine.send({ type: "page-size-changed", pageSize: "a4" });
    expect(machine.inputs.at(-1)).toEqual({ expectedVersion: 8, pageSize: "a4" });
  });

  it("keeps the acknowledged document across a settings-only save", () => {
    const machine = new Harness();
    machine.type("body text");
    machine.ack(1, 4);

    machine.send({ type: "page-size-changed", pageSize: "letter" });
    expect(machine.inputs.at(-1)).toEqual({ expectedVersion: 4, pageSize: "letter" });
    machine.ack(2, 5, "letter");

    // A settings PATCH carries no content, so the acknowledged document must
    // survive it rather than being blanked.
    expect(machine.state.savedDocument).toEqual(doc("body text"));
  });
});

describe("autosave machine: navigation flush and unsaved work", () => {
  it("flushes pending work immediately with a keepalive request", () => {
    const machine = new Harness();
    machine.send({ type: "document-changed", document: doc("half written") });
    const effects = machine.send({ type: "flush", keepalive: true });

    const save = machine.saveFrom(effects);
    expect(save?.keepalive).toBe(true);
    expect(save?.input).toEqual({ expectedVersion: 3, content: doc("half written") });
  });

  it("reports unsaved work for the leave prompt while anything is unacknowledged", () => {
    const machine = new Harness();
    expect(hasUnsavedWork(machine.state)).toBe(false);

    machine.send({ type: "document-changed", document: doc("draft") });
    expect(hasUnsavedWork(machine.state)).toBe(true);

    machine.send({ type: "debounce-elapsed" });
    // In flight is still unsaved: a request that has not answered has not saved.
    expect(hasUnsavedWork(machine.state)).toBe(true);

    machine.ack(1, 4);
    expect(hasUnsavedWork(machine.state)).toBe(false);
  });

  it("cancels the debounce when a flush has nothing to send", () => {
    const machine = new Harness();
    const effects = machine.send({ type: "flush", keepalive: true });
    expect(effects).toEqual([{ kind: "cancel-debounce" }]);
  });
});

describe("autosave machine: rejected editor output", () => {
  it("carries the rejection as its own explicit flag, never as silence", () => {
    const machine = new Harness();
    machine.send({ type: "document-changed", document: doc("valid") });
    machine.send({ type: "document-rejected", rejected: true });
    expect(machine.state.documentRejected).toBe(true);

    // The last valid document is still saved: the rejection stops new content
    // from arriving, it does not discard content already accepted.
    machine.send({ type: "debounce-elapsed" });
    expect(machine.inputs.at(-1)).toEqual({ expectedVersion: 3, content: doc("valid") });

    machine.send({ type: "document-rejected", rejected: false });
    expect(machine.state.documentRejected).toBe(false);
  });
});

describe("autosave machine: status vocabulary", () => {
  it("describes every state in words rather than by colour alone", () => {
    const machine = new Harness();
    expect(describeAutosave(machine.state).message).toBe("No unsaved changes.");

    machine.send({ type: "document-changed", document: doc("x") });
    expect(describeAutosave(machine.state).message).toBe("Unsaved changes.");

    machine.send({ type: "debounce-elapsed" });
    expect(describeAutosave(machine.state).message).toBe("Saving…");

    machine.ack(1, 4);
    expect(describeAutosave(machine.state).message).toBe("Saved.");
  });

  it("falls back to a retryable message when a failure kind was never recorded", () => {
    const machine = new Harness();
    const description = describeAutosave({ ...machine.state, status: "error", failure: null });
    expect(description.canRetry).toBe(true);
    expect(description.message).toMatch(/Check your connection/u);
  });
});

/**
 * Part 58. A collaborative session writes `notes.content` through the API's
 * projection, so this machine can learn about a version it never produced.
 * Adopting it is only ever safe while the machine has nothing outstanding.
 */
describe("autosave machine: externally assigned versions", () => {
  it("adopts the version while the machine is clean and idle, and emits nothing", () => {
    const machine = new Harness({ version: 3 });
    const effects = machine.send({ type: "external-version", version: 9 });

    expect(machine.state.version).toBe(9);
    expect(machine.state.status).toBe("idle");
    expect(effects).toEqual([]);

    // The next save uses the version the server actually holds, so a projected
    // change no longer costs the writer a conflict.
    machine.type("typed");
    expect(machine.inputs.at(-1)).toEqual({ expectedVersion: 9, content: doc("typed") });
  });

  it("ignores the version while the document is dirty", () => {
    const machine = new Harness({ version: 3 });
    machine.send({ type: "document-changed", document: doc("typed") });

    const effects = machine.send({ type: "external-version", version: 9 });
    expect(effects).toEqual([]);
    expect(machine.state.version).toBe(3);
    expect(machine.state.status).toBe("dirty");

    // The precondition this patch was queued with is the one it is sent with:
    // a compare-and-set that moved its own expectation is a blind overwrite.
    machine.send({ type: "debounce-elapsed" });
    expect(machine.inputs.at(-1)).toEqual({ expectedVersion: 3, content: doc("typed") });
  });

  it("ignores the version while a save is in flight", () => {
    const machine = new Harness({ version: 3 });
    machine.type("typed");
    expect(machine.state.status).toBe("saving");

    const effects = machine.send({ type: "external-version", version: 9 });
    expect(effects).toEqual([]);
    expect(machine.state.version).toBe(3);

    // Only the acknowledgement moves the cell.
    machine.ack(1, 4);
    expect(machine.state.version).toBe(4);
  });

  it("ignores the version while a retry is pending", () => {
    const machine = new Harness({ version: 3 });
    machine.type("typed");
    machine.send({ type: "save-failed", saveId: 1, kind: "unavailable" });
    expect(machine.state.status).toBe("retrying");

    const effects = machine.send({ type: "external-version", version: 9 });
    expect(effects).toEqual([]);
    expect(machine.state.version).toBe(3);

    machine.send({ type: "retry-elapsed" });
    expect(machine.inputs.at(-1)).toEqual({ expectedVersion: 3, content: doc("typed") });
  });
});
