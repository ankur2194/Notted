"use client";

import { WEBHOOK_ENDPOINT_LIMIT, WEBHOOK_EVENTS } from "@notted/shared-types";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ApiRequestFailure, ApiRequestFailureKind } from "@/lib/api/request-json";
import type {
  WebhookDelivery,
  WebhookDeliveryPage,
  WebhookDeliveryStatus,
  WebhookEndpoint,
  WebhookEndpointPage,
  WebhookEvent,
} from "@notted/shared-types";
import type { FormEvent } from "react";

import {
  createWebhook,
  deleteWebhook,
  loadWebhookDeliveries,
  loadWebhooks,
  retryWebhookDelivery,
  rotateWebhookSecret,
  updateWebhook,
  verifyWebhook,
} from "@/lib/webhooks/requests";

/**
 * Part 66 — outbound webhook endpoints and their delivery log.
 *
 * Modelled on `ApiKeys` (Part 65), which is the same shape of problem: a
 * workspace-settings island with a list, a create form, and a secret that is
 * shown exactly once.
 *
 * ponytail: local state, no TanStack Query. There is one reader, no cache to
 * share and nothing to invalidate beyond re-running this component's own load.
 * Upgrade path: move onto the query client when a real integrations surface
 * exists and a second screen needs the same endpoints.
 *
 * PERMISSION: the settings page renders this only for a workspace admin, and
 * that gate is presentation only — every route below re-authorizes server-side,
 * so a member who forces the component to render still gets a 403 and the
 * permission copy rather than a webhook.
 *
 * The signing secret lives in React state and nowhere else: no localStorage, no
 * URL, no clipboard until the reader asks. Dismissing the panel drops it, and
 * no reload can bring it back because the list response has no secret field at
 * all — only create and rotate ever return one.
 */

const PERMISSION_MESSAGE = "You need to be a workspace admin to manage webhooks.";

/**
 * Copy keyed by the stable `ApiErrorCode`, for the failures where the remedy
 * genuinely differs. Everything else falls through to the `kind` switch below.
 *
 * `requestJson` surfaces the envelope's `code` on a 409 today; the 400/422
 * passthrough is a separate change, so `WEBHOOK_URL_REJECTED` and
 * `WEBHOOK_VERIFICATION_FAILED` may arrive as a plain `invalid` for now. That
 * is why the fallback copy still has to make sense on its own.
 */
const VERIFICATION_FAILED_MESSAGE =
  "The endpoint did not echo the challenge. It has to answer 2xx with the challenge value in the response body.";

const CODE_MESSAGES: Readonly<Record<string, string>> = {
  WEBHOOK_URL_REJECTED:
    "That address was refused. A webhook endpoint has to be a public HTTPS address — private, local, and internal addresses are never called.",
  WEBHOOK_NOT_VERIFIED:
    "Verify this endpoint before enabling it. Verification sends one signed request that the endpoint has to echo back.",
  WEBHOOK_VERIFICATION_FAILED: VERIFICATION_FAILED_MESSAGE,
};

const LIMIT_MESSAGE = `This workspace already has the maximum of ${WEBHOOK_ENDPOINT_LIMIT} webhook endpoints. Delete one before adding another.`;

const GENERIC_CONFLICT = "Something changed this endpoint first. Reload the list and try again.";

const GENERIC_INVALID =
  "That was rejected. Check the endpoint URL — it has to be a public HTTPS address — and select at least one event.";

const STATUS_LABELS: Readonly<Record<WebhookDeliveryStatus, string>> = {
  pending: "Pending",
  success: "Delivered",
  failed: "Failed",
  retrying: "Retrying",
};

/**
 * Our own copy, always — the server's message is never echoed. An error
 * envelope can quote the endpoint URL an admin typed, and such a URL routinely
 * carries a bearer token in its path or query.
 *
 * `code` is consulted first and for every `kind`, because one status covers
 * genuinely different remedies: a 409 that means "verify it first" and a 409
 * that means "you are at the endpoint limit" ask for opposite actions.
 */
function failureMessage(
  failure: ApiRequestFailure,
  fallbacks: { readonly invalid?: string; readonly conflict?: string } = {},
): string {
  const named = failure.code === undefined ? undefined : CODE_MESSAGES[failure.code];
  if (named !== undefined) return named;
  switch (failure.kind) {
    case "forbidden-or-not-found":
      return PERMISSION_MESSAGE;
    case "invalid":
      return fallbacks.invalid ?? GENERIC_INVALID;
    case "conflict":
    case "version-conflict":
      return fallbacks.conflict ?? GENERIC_CONFLICT;
    default:
      return "Webhooks are unavailable right now. Nothing was changed.";
  }
}

function formatMoment(value: string): string {
  const at = Date.parse(value);
  return Number.isNaN(at) ? "unknown" : new Date(at).toLocaleString();
}

/** What the admin has to retype to delete. The full URL would be hostile. */
function endpointHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * A delivery's outcome as words, never as colour alone. The stored failure
 * reasons are a closed snake_case catalog, so unslugging them reads correctly
 * for every member and cannot fall out of step with the shared enum the way a
 * hand-written label table would.
 */
function deliveryStatusText(delivery: WebhookDelivery): string {
  const label = STATUS_LABELS[delivery.status];
  if (delivery.errorMessage === null) return label;
  return `${label} — ${delivery.errorMessage.replace(/_/gu, " ")}`;
}

/**
 * One endpoint's delivery attempts, loaded the first time the disclosure is
 * opened. A workspace may hold ten endpoints; loading every log up front would
 * be ten queries for a panel nobody opened.
 */
function DeliveryHistory({
  workspaceId,
  webhookId,
  url,
  onStatus,
}: {
  readonly workspaceId: string;
  readonly webhookId: string;
  readonly url: string;
  readonly onStatus: (message: string) => void;
}) {
  const [page, setPage] = useState<WebhookDeliveryPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    const result = await loadWebhookDeliveries(workspaceId, webhookId, { page: 1, limit: 25 });
    setLoading(false);
    if (!result.ok) {
      setFailed(true);
      return;
    }
    setPage(result.data);
  }, [workspaceId, webhookId]);

  /*
   * The native `toggle` event is the trigger, so keyboard and pointer opening
   * behave identically and no click handler has to be bolted onto `<summary>`.
   * Guarded twice over: only on opening, and only while nothing has loaded, so
   * closing and reopening the disclosure does not refetch.
   */
  function openOnce(open: boolean): void {
    if (open && page === null && !loading) void load();
  }

  async function retry(deliveryId: string, event: string): Promise<void> {
    setRetryingId(deliveryId);
    const result = await retryWebhookDelivery(workspaceId, webhookId, deliveryId);
    setRetryingId(null);
    if (!result.ok) {
      onStatus(failureMessage(result));
      return;
    }
    onStatus(
      result.data.scheduled
        ? `A new attempt at the ${event} delivery is queued.`
        : `The ${event} delivery could not be queued again.`,
    );
    await load();
  }

  return (
    <details
      className="rounded-md border p-2"
      onToggle={(event) => openOnce(event.currentTarget.open)}
    >
      <summary className="min-h-11 cursor-pointer list-item py-2 text-sm font-medium">
        Delivery history
      </summary>
      {loading ? (
        <p className="p-2 text-sm text-muted-foreground">Loading delivery history…</p>
      ) : failed ? (
        <div role="alert" className="space-y-2 p-2 text-sm">
          <p>The delivery history could not be loaded. Nothing was changed.</p>
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex min-h-11 items-center rounded-md border px-3 text-sm font-medium"
          >
            Try again
          </button>
        </div>
      ) : page !== null && page.items.length === 0 ? (
        <p className="p-2 text-sm text-muted-foreground">
          Nothing has been delivered to this endpoint yet.
        </p>
      ) : page !== null ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <caption className="p-2 text-left text-xs text-muted-foreground">
              Delivery attempts for {url}, newest first.
            </caption>
            <thead>
              <tr>
                <th scope="col" className="p-2">
                  Time
                </th>
                <th scope="col" className="p-2">
                  Event
                </th>
                <th scope="col" className="p-2">
                  Attempt
                </th>
                <th scope="col" className="p-2">
                  Status
                </th>
                <th scope="col" className="p-2">
                  HTTP status
                </th>
                <th scope="col" className="p-2">
                  Response snippet
                </th>
                <th scope="col" className="p-2">
                  Retry
                </th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((delivery) => (
                <tr key={delivery.id} className="border-t align-top">
                  <th scope="row" className="p-2 font-normal">
                    {formatMoment(delivery.createdAt)}
                  </th>
                  <td className="p-2">{delivery.event}</td>
                  <td className="p-2">{delivery.attempt}</td>
                  <td className="p-2">{deliveryStatusText(delivery)}</td>
                  <td className="p-2">{delivery.responseStatus ?? "—"}</td>
                  <td className="p-2">
                    <code className="break-all">{delivery.responseBodySnippet ?? "—"}</code>
                  </td>
                  <td className="p-2">
                    <button
                      type="button"
                      disabled={retryingId === delivery.id}
                      aria-label={`Retry ${delivery.event} attempt ${delivery.attempt}`}
                      onClick={() => void retry(delivery.id, delivery.event)}
                      className="inline-flex min-h-11 items-center rounded-md border px-3 font-medium disabled:opacity-60"
                    >
                      Retry
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </details>
  );
}

export function WebhookSettings({ workspaceId }: { readonly workspaceId: string }) {
  const [page, setPage] = useState<WebhookEndpointPage | null>(null);
  const [loadFailure, setLoadFailure] = useState<ApiRequestFailureKind | null>(null);
  const [status, setStatus] = useState("");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<readonly WebhookEvent[]>([]);
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [secret, setSecret] = useState<{ readonly value: string; readonly url: string } | null>(
    null,
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [deleteError, setDeleteError] = useState("");

  // Focus has to come back to the control that opened the confirmation, and
  // that control is unmounted while the confirmation is open — so the node is
  // remembered by id and refocused once it has remounted.
  const deleteTriggers = useRef(new Map<string, HTMLButtonElement>());
  const confirmInputRef = useRef<HTMLInputElement>(null);
  const restoreFocusId = useRef<string | null>(null);
  const listHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (confirmingId !== null) {
      confirmInputRef.current?.focus();
      return;
    }
    const id = restoreFocusId.current;
    if (id === null) return;
    restoreFocusId.current = null;
    deleteTriggers.current.get(id)?.focus();
  }, [confirmingId]);

  const load = useCallback(async () => {
    setLoadFailure(null);
    const result = await loadWebhooks(workspaceId);
    if (result.ok) {
      setPage(result.data);
      return;
    }
    setPage(null);
    setLoadFailure(result.kind);
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  function closeConfirmation(id: string): void {
    restoreFocusId.current = id;
    setConfirmingId(null);
    setConfirmText("");
    setDeleteError("");
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (url.trim() === "") {
      setFormError("Enter the HTTPS address deliveries should be sent to.");
      return;
    }
    // The server refuses an empty subscription too; saying so here saves a
    // round trip and keeps the reason next to the checkboxes.
    if (events.length === 0) {
      setFormError("Select at least one event to send.");
      return;
    }
    setFormError("");
    setSubmitting(true);
    setStatus("");
    setSecret(null);
    const result = await createWebhook(workspaceId, { url: url.trim(), events: [...events] });
    setSubmitting(false);
    if (!result.ok) {
      setFormError(failureMessage(result, { conflict: LIMIT_MESSAGE }));
      return;
    }
    setSecret({ value: result.data.secret, url: result.data.webhook.url });
    setUrl("");
    setEvents([]);
    setStatus(
      `Endpoint ${result.data.webhook.url} was created, disabled and unverified. Copy the signing secret now, then verify the endpoint.`,
    );
    await load();
  }

  async function setEnabled(endpoint: WebhookEndpoint, next: boolean): Promise<void> {
    setBusyId(endpoint.id);
    setStatus("");
    const result = await updateWebhook(workspaceId, endpoint.id, { isEnabled: next });
    setBusyId(null);
    if (!result.ok) {
      setStatus(failureMessage(result));
      return;
    }
    setStatus(
      result.data.isEnabled
        ? `${result.data.url} is enabled and will receive deliveries.`
        : `${result.data.url} is disabled and will receive nothing.`,
    );
    await load();
  }

  async function verify(endpoint: WebhookEndpoint): Promise<void> {
    setBusyId(endpoint.id);
    setStatus("");
    const result = await verifyWebhook(workspaceId, endpoint.id);
    setBusyId(null);
    if (!result.ok) {
      // On this route a 422 means exactly one thing, so the specific copy is
      // right even before `requestJson` starts carrying the 422 error code.
      setStatus(failureMessage(result, { invalid: VERIFICATION_FAILED_MESSAGE }));
      return;
    }
    // A 2xx with the wrong body is still a failed verification, so the outcome
    // is read from the response rather than inferred from the call succeeding.
    setStatus(
      result.data.isVerified
        ? `${result.data.webhook.url} echoed the challenge and is verified. You can enable it now.`
        : VERIFICATION_FAILED_MESSAGE,
    );
    await load();
  }

  async function rotate(endpoint: WebhookEndpoint): Promise<void> {
    setBusyId(endpoint.id);
    setStatus("");
    setSecret(null);
    const result = await rotateWebhookSecret(workspaceId, endpoint.id);
    setBusyId(null);
    if (!result.ok) {
      setStatus(failureMessage(result));
      return;
    }
    setSecret({ value: result.data.secret, url: result.data.webhook.url });
    setStatus(
      `A new signing secret was issued for ${result.data.webhook.url}. The previous secret is already rejected, so update the receiver now.`,
    );
    await load();
  }

  async function remove(endpoint: WebhookEndpoint): Promise<void> {
    const host = endpointHost(endpoint.url);
    // Defence in depth: the submit button is already disabled until the host
    // matches, but a form can be submitted in ways a disabled button does not
    // cover, and this is the one irreversible action on the panel.
    if (confirmText !== host) {
      setDeleteError(`Type ${host} exactly to confirm deletion.`);
      return;
    }
    setBusyId(endpoint.id);
    setStatus("");
    const result = await deleteWebhook(workspaceId, endpoint.id);
    setBusyId(null);
    if (!result.ok) {
      closeConfirmation(endpoint.id);
      setStatus(failureMessage(result));
      return;
    }
    // The control that opened this confirmation is about to stop existing, so
    // `closeConfirmation`'s focus restore would aim at nothing. The list
    // heading takes the focus instead of letting it fall back to the document.
    setConfirmingId(null);
    setConfirmText("");
    setDeleteError("");
    setStatus(`${endpoint.url} was deleted. Nothing will be delivered to it again.`);
    await load();
    listHeadingRef.current?.focus();
  }

  async function copySecret(): Promise<void> {
    if (secret === null) return;
    try {
      await navigator.clipboard.writeText(secret.value);
      setStatus("Signing secret copied to the clipboard.");
    } catch {
      // An insecure context, a denied permission, or a browser without the API.
      setStatus("The secret could not be copied. Select it and copy it manually.");
    }
  }

  return (
    <section aria-labelledby="webhooks-heading" className="space-y-4 rounded-md border p-4">
      <h2 id="webhooks-heading" className="text-lg font-semibold">
        Webhooks
      </h2>
      <p className="text-sm text-muted-foreground">
        Notted posts a signed JSON request to your endpoint whenever a subscribed event happens in
        this workspace. A signing secret is shown once, when it is created or rotated.
      </p>

      {loadFailure !== null ? (
        <div role="alert" className="space-y-2 text-sm">
          <p>
            {loadFailure === "forbidden-or-not-found"
              ? PERMISSION_MESSAGE
              : "Webhook endpoints could not be loaded. Nothing was changed."}
          </p>
          {loadFailure === "forbidden-or-not-found" ? null : (
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex min-h-11 items-center rounded-md border px-3 text-sm font-medium"
            >
              Try again
            </button>
          )}
        </div>
      ) : page === null ? (
        <p className="text-sm text-muted-foreground">Loading webhook endpoints…</p>
      ) : (
        <>
          {secret === null ? null : (
            <section
              aria-labelledby="webhook-secret-heading"
              className="space-y-2 rounded-md border-2 border-primary p-4"
            >
              <h3 id="webhook-secret-heading" className="text-sm font-semibold">
                Signing secret for {secret.url}
              </h3>
              <code className="block break-all rounded bg-muted p-2 font-mono text-sm">
                {secret.value}
              </code>
              <p className="text-sm font-medium">
                This is the only time this secret is shown. It cannot be retrieved later — if you
                lose it, you have to rotate it.
              </p>
              <p className="text-sm text-muted-foreground">
                Your endpoint should verify the <code>X-Notted-Signature</code> header (
                <code>t=&lt;unix&gt;,v1=&lt;hex&gt;</code>): compute HMAC-SHA256 of{" "}
                <code>&lt;t&gt;.&lt;raw request body&gt;</code> with this secret, compare it in
                constant time, and reject anything whose timestamp is more than 300 seconds old.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void copySecret()}
                  className="inline-flex min-h-11 items-center rounded-md border px-3 text-sm font-medium"
                >
                  Copy secret
                </button>
                <button
                  type="button"
                  onClick={() => setSecret(null)}
                  className="inline-flex min-h-11 items-center rounded-md border px-3 text-sm font-medium"
                >
                  I have saved it
                </button>
              </div>
            </section>
          )}

          <section aria-labelledby="webhook-create-heading" className="space-y-3">
            <h3 id="webhook-create-heading" className="text-sm font-semibold">
              Add an endpoint
            </h3>
            <p className="text-sm text-muted-foreground">
              {page.items.length} of {WEBHOOK_ENDPOINT_LIMIT} endpoints used.
            </p>
            <form onSubmit={(event) => void submit(event)} className="space-y-3">
              <div className="space-y-1">
                <label htmlFor="webhook-url" className="block text-sm font-medium">
                  Endpoint URL
                </label>
                <input
                  id="webhook-url"
                  type="url"
                  required
                  maxLength={2048}
                  inputMode="url"
                  placeholder="https://hooks.example.com/notted"
                  value={url}
                  disabled={submitting}
                  onChange={(event) => setUrl(event.target.value)}
                  className="min-h-11 w-full rounded-md border px-3 text-sm"
                />
              </div>

              <fieldset className="space-y-1">
                <legend className="text-sm font-medium">Events to send</legend>
                {WEBHOOK_EVENTS.map((event) => (
                  <div key={event} className="flex min-h-11 items-center gap-3">
                    <input
                      id={`webhook-event-${event}`}
                      type="checkbox"
                      checked={events.includes(event)}
                      disabled={submitting}
                      onChange={(changed) =>
                        setEvents((current) =>
                          changed.target.checked
                            ? [...current, event]
                            : current.filter((value) => value !== event),
                        )
                      }
                      className="size-4"
                    />
                    <label htmlFor={`webhook-event-${event}`} className="text-sm">
                      {event}
                    </label>
                  </div>
                ))}
              </fieldset>

              {formError === "" ? null : (
                <p role="alert" className="text-sm font-medium">
                  {formError}
                </p>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="inline-flex min-h-11 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-60"
              >
                {submitting ? "Adding…" : "Add endpoint"}
              </button>
            </form>
          </section>

          <section aria-labelledby="webhook-list-heading" className="space-y-3">
            <h3
              ref={listHeadingRef}
              tabIndex={-1}
              id="webhook-list-heading"
              className="text-sm font-semibold"
            >
              Endpoints
            </h3>
            {page.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No endpoints yet. An endpoint is a URL of yours that Notted calls with a signed JSON
                payload every time a subscribed event happens here.
              </p>
            ) : (
              <ul className="space-y-3">
                {page.items.map((item) => (
                  <li key={item.id} className="space-y-2 rounded-md border p-3 text-sm">
                    <p className="break-all font-medium">{item.url}</p>
                    {/* State as words, never as colour alone. */}
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full border px-2 py-0.5 text-xs font-medium">
                        {item.isEnabled ? "Enabled" : "Disabled"}
                      </span>
                      <span className="rounded-full border px-2 py-0.5 text-xs font-medium">
                        {item.isVerified ? "Verified" : "Not verified"}
                      </span>
                      {item.events.map((event) => (
                        <span
                          key={event}
                          className="rounded-full border px-2 py-0.5 text-xs font-medium"
                        >
                          {event}
                        </span>
                      ))}
                    </div>
                    <p className="text-muted-foreground">Added {formatMoment(item.createdAt)}</p>

                    {confirmingId === item.id ? (
                      <form
                        className="space-y-2"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void remove(item);
                        }}
                      >
                        <p>
                          Deleting this endpoint stops every delivery to it and removes its delivery
                          history. This cannot be undone.
                        </p>
                        <label
                          htmlFor={`webhook-delete-${item.id}`}
                          className="block text-sm font-medium"
                        >
                          Type the endpoint host ({endpointHost(item.url)}) to confirm
                        </label>
                        <input
                          ref={confirmInputRef}
                          id={`webhook-delete-${item.id}`}
                          type="text"
                          autoComplete="off"
                          value={confirmText}
                          disabled={busyId === item.id}
                          onChange={(event) => setConfirmText(event.target.value)}
                          className="min-h-11 w-full rounded-md border px-3 text-sm"
                        />
                        {deleteError === "" ? null : (
                          <p role="alert" className="font-medium">
                            {deleteError}
                          </p>
                        )}
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="submit"
                            disabled={busyId === item.id || confirmText !== endpointHost(item.url)}
                            className="inline-flex min-h-11 items-center rounded-md border px-3 font-medium disabled:opacity-60"
                          >
                            Permanently delete
                          </button>
                          <button
                            type="button"
                            disabled={busyId === item.id}
                            onClick={() => closeConfirmation(item.id)}
                            className="inline-flex min-h-11 items-center rounded-md border px-3 font-medium disabled:opacity-60"
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={busyId === item.id}
                          onClick={() => void verify(item)}
                          className="inline-flex min-h-11 items-center rounded-md border px-3 font-medium disabled:opacity-60"
                        >
                          Verify {item.url}
                        </button>
                        <button
                          type="button"
                          disabled={busyId === item.id}
                          onClick={() => void setEnabled(item, !item.isEnabled)}
                          className="inline-flex min-h-11 items-center rounded-md border px-3 font-medium disabled:opacity-60"
                        >
                          {item.isEnabled ? "Disable" : "Enable"} {item.url}
                        </button>
                        <button
                          type="button"
                          disabled={busyId === item.id}
                          onClick={() => void rotate(item)}
                          className="inline-flex min-h-11 items-center rounded-md border px-3 font-medium disabled:opacity-60"
                        >
                          Rotate secret for {item.url}
                        </button>
                        <button
                          type="button"
                          ref={(node) => {
                            if (node === null) deleteTriggers.current.delete(item.id);
                            else deleteTriggers.current.set(item.id, node);
                          }}
                          disabled={busyId === item.id}
                          onClick={() => {
                            setDeleteError("");
                            setConfirmText("");
                            setConfirmingId(item.id);
                          }}
                          className="inline-flex min-h-11 items-center rounded-md border px-3 font-medium disabled:opacity-60"
                        >
                          Delete {item.url}
                        </button>
                      </div>
                    )}

                    <DeliveryHistory
                      workspaceId={workspaceId}
                      webhookId={item.id}
                      url={item.url}
                      onStatus={setStatus}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {/* One live region, and only for text that has no box of its own. */}
      <p aria-live="polite" aria-atomic="true" className="min-h-5 text-sm text-muted-foreground">
        {loadFailure === null ? status : ""}
      </p>
    </section>
  );
}
