import { io, type Socket } from "socket.io-client";

import { wsOrigin } from "@/lib/api/api-origin";

/**
 * The single realtime connection for the whole tab (Part 58).
 *
 * One socket, many rooms: every note, presence, and notification room is
 * multiplexed over this connection, so opening a second note must never open a
 * second WebSocket. It is created lazily because a Server Component render must
 * not dial anything, and `autoConnect: false` so the first caller decides when
 * the handshake happens.
 *
 * Identity travels only in the Better Auth cookie on the handshake request.
 * There is deliberately no token parameter and no query string carrying a user
 * or workspace id: a URL is logged by proxies, a cookie is not.
 */
let socket: Socket | null = null;

export function getRealtimeSocket(): Socket {
  // Part 73: the page's own origin on a custom host, the configured
  // `NEXT_PUBLIC_WS_URL` everywhere else. Resolved lazily, inside the factory,
  // so it reads the real `window` rather than a build-time constant.
  socket ??= io(wsOrigin(), {
    path: "/socket.io",
    // WebSocket only. The HTTP long-polling fallback would send the session
    // cookie on every poll and cannot be sticky-routed without extra
    // infrastructure.
    transports: ["websocket"],
    withCredentials: true,
    autoConnect: false,
    // Bounded: a client that cannot reach the server falls back to solo editing
    // instead of retrying forever against a service that is down.
    reconnectionAttempts: 10,
    reconnectionDelay: 500,
    reconnectionDelayMax: 10_000,
  });

  return socket;
}

/** Full teardown. Used by tests and by sign-out, never during normal editing. */
export function disposeRealtimeSocket(): void {
  socket?.disconnect();
  socket = null;
}
