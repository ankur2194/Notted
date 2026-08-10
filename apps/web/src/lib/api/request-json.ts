import { uuidSchema } from "@notted/shared-validators";

import { publicEnvironment } from "@/config/public-environment";

export type ApiRequestFailureKind =
  "invalid" | "forbidden-or-not-found" | "version-conflict" | "conflict" | "unavailable";

/**
 * A failed request.
 *
 * `kind` is the stable vocabulary every surface writes its own copy from; it is
 * deliberately *not* widened, because eight components already switch on
 * exactly these five values.
 *
 * The two optional fields exist for Part 39's autosave, which has to tell a
 * retryable outage apart from a permanent rejection — `unavailable` covers both
 * a 503 and an unsupported method. Every other caller simply ignores them.
 */
export interface ApiRequestFailure {
  readonly ok: false;
  readonly kind: ApiRequestFailureKind;
  /** True only when repeating the identical request could plausibly succeed. */
  readonly retryable?: boolean;
  /** Server-advised wait before repeating it, parsed from `Retry-After`. */
  readonly retryAfterMs?: number;
  /**
   * The stable `ApiErrorCode` from the error envelope, when the response
   * carried one. Present only on a 409 today, because that is the one status
   * where a single `kind` covers genuinely different remedies: `TAG_NAME_TAKEN`
   * asks the user to rename, `TAG_LIMIT_REACHED` asks them to delete something
   * first, and telling one to rename is advice that can never succeed.
   *
   * Surfaces should keep switching on `kind` and consult `code` only where the
   * distinction changes what the user must do.
   */
  readonly code?: string;
}

export type ApiRequestResult<T> = { readonly ok: true; readonly data: T } | ApiRequestFailure;

export interface ApiRequestOptions {
  /**
   * Ask the browser to keep this request alive across a navigation or a hidden
   * document. Ignored when the body is larger than the specification's 64 KiB
   * keepalive limit, since a rejected request saves nothing at all.
   */
  readonly keepalive?: boolean;
}

/**
 * Historical names, kept because note, attachment, and autosave modules already
 * import them. They are the same types — a tag or template failure is not a
 * different vocabulary — so new code should prefer the `Api*` names.
 */
export type NoteRequestFailureKind = ApiRequestFailureKind;
export type NoteRequestFailure = ApiRequestFailure;
export type NoteRequestResult<T> = ApiRequestResult<T>;
export type NoteRequestOptions = ApiRequestOptions;

export type SafeParser<T> = (value: unknown) => { success: true; data: T } | { success: false };

/**
 * Largest body the fetch specification allows on a `keepalive` request.
 *
 * A keepalive request whose body exceeds this is rejected as a network error
 * before it leaves the browser, so a navigation flush of a large note must fall
 * back to an ordinary request rather than silently vanish.
 */
export const KEEPALIVE_BODY_LIMIT_BYTES = 64 * 1024;

function bodyFitsKeepalive(body: BodyInit | null | undefined): boolean {
  if (typeof body !== "string") return false;
  return new TextEncoder().encode(body).length <= KEEPALIVE_BODY_LIMIT_BYTES;
}

/**
 * `Retry-After` as milliseconds. The header is delta-seconds or an HTTP date;
 * both are accepted, anything else is treated as absent so a malformed header
 * can never stall a client indefinitely.
 */
function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("Retry-After");
  if (raw === null) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.min(seconds, 300) * 1_000 : undefined;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(at - Date.now(), 0), 300_000);
}

async function conflictFailure(response: Response): Promise<ApiRequestFailure> {
  try {
    const body: unknown = await response.json();
    const topCode =
      typeof body === "object" && body !== null && "code" in body ? body.code : undefined;
    const nested =
      typeof body === "object" && body !== null && "error" in body ? body.error : undefined;
    const nestedCode =
      typeof nested === "object" && nested !== null && "code" in nested ? nested.code : undefined;
    const code = typeof topCode === "string" ? topCode : nestedCode;
    if (code === "VERSION_CONFLICT") return { ok: false, kind: "version-conflict", code };
    if (typeof code === "string") return { ok: false, kind: "conflict", code };
  } catch {
    // The status remains a safe generic conflict when the error envelope is unavailable.
  }
  return { ok: false, kind: "conflict" };
}

export async function requestJson<T>(
  path: string,
  init: RequestInit,
  parser: SafeParser<T>,
  options: ApiRequestOptions = {},
): Promise<ApiRequestResult<T>> {
  // A keepalive request has to outlive the document that started it, so it gets
  // no abort timer: a timeout scheduled on a page that is going away either
  // never fires or cancels the very request the flush exists to deliver.
  const keepalive = options.keepalive === true && bodyFitsKeepalive(init.body);
  try {
    const response = await fetch(new URL(path, publicEnvironment.NEXT_PUBLIC_API_URL), {
      ...init,
      cache: "no-store",
      credentials: "include",
      ...(keepalive ? { keepalive: true } : { signal: AbortSignal.timeout(8_000) }),
    });
    if (!response.ok) {
      if (response.status === 400 || response.status === 422) return { ok: false, kind: "invalid" };
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        return { ok: false, kind: "forbidden-or-not-found" };
      }
      if (response.status === 409) return conflictFailure(response);
      // Only a rate limit or a server fault is worth repeating unchanged. Every
      // other status (405, 413, 415, …) describes the request itself and would
      // fail identically forever.
      return {
        ok: false,
        kind: "unavailable",
        retryable: response.status === 429 || response.status >= 500,
        retryAfterMs: retryAfterMs(response),
      };
    }
    const parsed = parser(await response.json());
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, kind: "invalid" };
  } catch {
    // Offline, DNS failure, TLS failure, or the 8s timeout above: all transient
    // by nature, so the caller is allowed to repeat them.
    return { ok: false, kind: "unavailable", retryable: true };
  }
}

export function validIds(...ids: readonly string[]): boolean {
  return ids.every((id) => uuidSchema.safeParse(id).success);
}

export function json(
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}
