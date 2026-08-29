import { parseAck, type AckOutcome } from "./note-frame-codec";

import type { Socket } from "socket.io-client";

/**
 * One socket emit that must be acknowledged, with a deadline.
 *
 * Split out of `NoteCollaborationProvider` because it is about the SOCKET, not
 * about this note: nothing in it reads the provider's state, and the settle-once
 * latch it implements is the kind of thing that is easiest to trust when it is
 * fifteen lines on its own.
 *
 * THE LATCH IS THE POINT. Two things race to finish every emit — the server's
 * callback and the timer — and both can fire. Exactly one outcome is delivered,
 * and a late callback after a timeout is dropped rather than resolving a promise
 * the caller has already acted on. A timeout is reported as `unavailable`, which
 * is the one ack error the server itself never sends: the caller can tell "the
 * server refused" from "the server never answered".
 */
export function emitWithAck<T>(
  socket: Socket,
  event: string,
  payload: object,
  timeoutMs: number,
  parseValue: (record: Record<string, unknown>) => T | null,
): Promise<AckOutcome<T>> {
  return new Promise((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ ok: false, error: "unavailable" });
    }, timeoutMs);

    socket.emit(event, payload, (raw: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(parseAck(raw, parseValue));
    });
  });
}
