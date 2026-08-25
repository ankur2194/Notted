/**
 * The cookie that remembers which workspace the shell should open.
 *
 * It lives in its own module — and NOT in `server-shell.ts` — because Part 73's
 * `proxy.ts` needs the name and `server-shell.ts` is `import "server-only"` with
 * a `next/headers` dependency. The proxy runs before rendering and must not drag
 * either of those in for the sake of one string.
 */
export const WORKSPACE_SELECTION_COOKIE = "notted_workspace";
