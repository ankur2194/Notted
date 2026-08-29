/**
 * The wire format between this client and the realtime gateway: acknowledgement
 * envelopes in, note events out.
 *
 * Split out of `note-collaboration-provider.ts` because every function here is
 * pure — none of them touches `this`, a socket, or a `Y.Doc`. They exist to
 * answer one question about an untrusted value that arrived over a socket:
 * "is this the shape it claims to be?" Keeping them beside the state machine
 * made a 1 350-line file out of two things that share nothing but a topic.
 *
 * DEFENSIVE BY DESIGN. Every parser returns `null` rather than throwing or
 * coercing, because the server is not the only thing that can put bytes on this
 * socket: a proxy, a stale deployment, or a replayed frame can all produce a
 * record that type-checks and means nothing. `isForNote` exists for the same
 * reason — one connection carries several notes' rooms.
 */

export type AckError = "denied" | "invalid" | "limited" | "stale" | "unavailable";

const ACK_ERRORS: readonly string[] = ["denied", "invalid", "limited", "stale", "unavailable"];

export type AckOutcome<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: AckError };

export interface SyncAck {
  readonly epoch: number;
  readonly revision: number;
  readonly schemaVersion: number;
  readonly update: Uint8Array;
  readonly stateVector: Uint8Array;
}

export interface UpdateAck {
  readonly epoch: number;
  readonly revision: number;
}

/* ------------------------------------------------------------------------- *
 * Trust boundary
 *
 * Everything below arrives over a socket and is `unknown` until proven
 * otherwise. A frame that does not parse is dropped, never applied: feeding a
 * malformed buffer to `Y.applyUpdate` corrupts the document for everyone in the
 * room, and the writer's own text is the thing being protected.
 * ------------------------------------------------------------------------- */

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export function asInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/**
 * Socket.IO frames binary natively, but some browser builds hand the payload
 * back as an `ArrayBuffer` rather than a `Uint8Array`. Normalise that one case;
 * reject everything else, including strings that merely look like base64.
 */
export function asBinary(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  return null;
}

export function parseAck<T>(
  raw: unknown,
  parseValue: (record: Record<string, unknown>) => T | null,
): AckOutcome<T> {
  const record = asRecord(raw);

  if (record === null) {
    return { ok: false, error: "invalid" };
  }

  if (record.ok !== true) {
    const error = record.error;

    return {
      ok: false,
      error:
        typeof error === "string" && ACK_ERRORS.includes(error) ? (error as AckError) : "invalid",
    };
  }

  const value = parseValue(record);

  return value === null ? { ok: false, error: "invalid" } : { ok: true, value };
}

export function parseSyncAck(record: Record<string, unknown>): SyncAck | null {
  const epoch = asInteger(record.epoch);
  const revision = asInteger(record.revision);
  const schemaVersion = asInteger(record.schemaVersion);
  const update = asBinary(record.update);
  const stateVector = asBinary(record.stateVector);

  if (
    epoch === null ||
    revision === null ||
    schemaVersion === null ||
    update === null ||
    stateVector === null
  ) {
    return null;
  }

  return { epoch, revision, schemaVersion, update, stateVector };
}

export function parseUpdateAck(record: Record<string, unknown>): UpdateAck | null {
  const epoch = asInteger(record.epoch);
  const revision = asInteger(record.revision);

  return epoch === null || revision === null ? null : { epoch, revision };
}

/**
 * One Socket.io connection is shared by the whole app, and Socket.io dispatches
 * by EVENT NAME, not by room: a socket that holds two note rooms receives both
 * notes' frames on this provider's handlers. Every server -> room frame carries
 * `noteId` so each provider can drop the ones that are not its own. Filtering on
 * `epoch` alone would not do it — epochs are per-note and collide freely, so a
 * frame for another note would be applied to this document.
 */
export function isForNote(record: Record<string, unknown>, noteId: string): boolean {
  return record.noteId === noteId;
}

export function sameBytes(first: Uint8Array, second: Uint8Array): boolean {
  if (first.length !== second.length) {
    return false;
  }
  for (let index = 0; index < first.length; index += 1) {
    if (first[index] !== second[index]) {
      return false;
    }
  }

  return true;
}
