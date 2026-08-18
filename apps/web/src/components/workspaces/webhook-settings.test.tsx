import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WebhookDelivery, WebhookEndpoint } from "@notted/shared-types";

import { WebhookSettings } from "@/components/workspaces/WebhookSettings";
import {
  createWebhook,
  deleteWebhook,
  loadWebhookDeliveries,
  loadWebhooks,
  retryWebhookDelivery,
  updateWebhook,
  verifyWebhook,
} from "@/lib/webhooks/requests";

vi.mock("@/lib/webhooks/requests", () => ({
  loadWebhooks: vi.fn(),
  createWebhook: vi.fn(),
  updateWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
  rotateWebhookSecret: vi.fn(),
  verifyWebhook: vi.fn(),
  loadWebhookDeliveries: vi.fn(),
  retryWebhookDelivery: vi.fn(),
}));

const WORKSPACE_ID = "70000000-0000-4000-8000-000000000001";
const WEBHOOK_ID = "70000000-0000-4000-8000-000000000002";
const DELIVERY_ID = "70000000-0000-4000-8000-000000000003";
const EVENT_ID = "70000000-0000-4000-8000-000000000004";
const USER_ID = "70000000-0000-4000-8000-000000000005";
const SECRET = "whsec_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const ENDPOINT_URL = "https://hooks.example.com/notted";

const list = vi.mocked(loadWebhooks);
const create = vi.mocked(createWebhook);
const update = vi.mocked(updateWebhook);
const remove = vi.mocked(deleteWebhook);
const verify = vi.mocked(verifyWebhook);
const deliveries = vi.mocked(loadWebhookDeliveries);
const retry = vi.mocked(retryWebhookDelivery);

const webhook: WebhookEndpoint = {
  id: WEBHOOK_ID,
  workspaceId: WORKSPACE_ID,
  url: ENDPOINT_URL,
  events: ["note.created"],
  isEnabled: false,
  isVerified: false,
  createdById: USER_ID,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const delivery: WebhookDelivery = {
  id: DELIVERY_ID,
  webhookId: WEBHOOK_ID,
  eventId: EVENT_ID,
  event: "note.created",
  status: "failed",
  attempt: 2,
  responseStatus: 500,
  responseBodySnippet: "upstream exploded",
  errorMessage: "http_error",
  payloadHash: "a".repeat(64),
  deliveredAt: null,
  createdAt: "2026-08-02T00:00:00.000Z",
};

function endpointPage(items: readonly WebhookEndpoint[]) {
  return { ok: true, data: { items, page: 1, limit: 25, hasMore: false } } as const;
}

function deliveryPage(items: readonly WebhookDelivery[]) {
  return { ok: true, data: { items, page: 1, limit: 25, hasMore: false } } as const;
}

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText("Endpoint URL"), ENDPOINT_URL);
  await user.click(screen.getByRole("checkbox", { name: "note.created" }));
  await user.click(screen.getByRole("button", { name: "Add endpoint" }));
}

async function openDeliveryHistory(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByText("Delivery history"));
  return screen.findByRole("table");
}

describe("WebhookSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("says it is loading before the first page arrives", () => {
    list.mockReturnValue(new Promise<never>(() => undefined));
    render(<WebhookSettings workspaceId={WORKSPACE_ID} />);

    expect(screen.getByText("Loading webhook endpoints…")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Add endpoint" })).toBeNull();
  });

  it("explains what an endpoint is when the workspace has none", async () => {
    list.mockResolvedValue(endpointPage([]));
    render(<WebhookSettings workspaceId={WORKSPACE_ID} />);

    expect(await screen.findByText(/No endpoints yet\./u)).toHaveTextContent(
      /calls with a signed JSON payload/u,
    );
    expect(screen.getByText("0 of 10 endpoints used.")).toBeVisible();
    // Nothing is subscribed by default: a subscription is a deliberate choice.
    expect(screen.getByRole("checkbox", { name: "note.created" })).not.toBeChecked();
  });

  it("alerts and retries when the endpoints cannot be loaded", async () => {
    list.mockResolvedValueOnce({ ok: false, kind: "unavailable", retryable: true });
    list.mockResolvedValueOnce(endpointPage([webhook]));
    render(<WebhookSettings workspaceId={WORKSPACE_ID} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/could not be loaded/iu);
    expect(screen.queryByRole("button", { name: "Add endpoint" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText(ENDPOINT_URL)).toBeVisible();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("names the missing permission rather than offering a pointless retry", async () => {
    list.mockResolvedValue({ ok: false, kind: "forbidden-or-not-found" });
    render(<WebhookSettings workspaceId={WORKSPACE_ID} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You need to be a workspace admin to manage webhooks.",
    );
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("never repeats the server's own error detail back to the reader", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue(endpointPage([]));
    // A code this build does not recognize stands in for anything the envelope
    // might carry: it is a lookup key here, never copy.
    create.mockResolvedValue({
      ok: false,
      kind: "invalid",
      code: "connect ECONNREFUSED 10.0.0.7:443 for https://internal.corp/hook?token=s3cret",
    });
    render(<WebhookSettings workspaceId={WORKSPACE_ID} />);
    await screen.findByText(/No endpoints yet\./u);

    await fillAndSubmit(user);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/public HTTPS address/u);
    expect(alert).not.toHaveTextContent(/ECONNREFUSED/u);
    expect(alert).not.toHaveTextContent(/s3cret/u);
  });

  it("refuses to submit without an event and reports it beside the checkboxes", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue(endpointPage([]));
    render(<WebhookSettings workspaceId={WORKSPACE_ID} />);
    await screen.findByText(/No endpoints yet\./u);

    await user.type(screen.getByLabelText("Endpoint URL"), ENDPOINT_URL);
    await user.click(screen.getByRole("button", { name: "Add endpoint" }));

    expect(await screen.findByText("Select at least one event to send.")).toBeVisible();
    expect(create).not.toHaveBeenCalled();
  });

  it("says the workspace is at its endpoint limit rather than 'conflict'", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue(endpointPage([]));
    create.mockResolvedValue({ ok: false, kind: "conflict", code: "CONFLICT" });
    render(<WebhookSettings workspaceId={WORKSPACE_ID} />);
    await screen.findByText(/No endpoints yet\./u);

    await fillAndSubmit(user);

    expect(await screen.findByText(/maximum of 10 webhook endpoints/u)).toBeVisible();
  });

  it("shows a created secret once, then never again", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue(endpointPage([]));
    create.mockResolvedValue({ ok: true, data: { webhook, secret: SECRET } });
    render(<WebhookSettings workspaceId={WORKSPACE_ID} />);
    await screen.findByText(/No endpoints yet\./u);

    list.mockResolvedValue(endpointPage([webhook]));
    await fillAndSubmit(user);

    expect(await screen.findByText(SECRET)).toBeVisible();
    expect(screen.getByText(/only time this secret is shown/iu)).toBeVisible();
    // The receiver guidance the secret is useless without.
    expect(screen.getByText(/HMAC-SHA256/u)).toBeVisible();
    expect(screen.getByText(/300 seconds/u)).toBeVisible();
    expect(create).toHaveBeenCalledWith(WORKSPACE_ID, {
      url: ENDPOINT_URL,
      events: ["note.created"],
    });

    await user.click(screen.getByRole("button", { name: "I have saved it" }));
    await waitFor(() => expect(screen.queryByText(SECRET)).toBeNull());

    // A reload reads the list endpoint, which has no secret field at all.
    verify.mockResolvedValue({
      ok: true,
      data: { webhook: { ...webhook, isVerified: true }, isVerified: true, delivery },
    });
    await user.click(screen.getByRole("button", { name: `Verify ${ENDPOINT_URL}` }));

    await waitFor(() => expect(list).toHaveBeenCalledTimes(3));
    expect(screen.queryByText(SECRET)).toBeNull();
  });

  it("states enabled and verified as words, not as colour", async () => {
    list.mockResolvedValue(endpointPage([webhook]));
    render(<WebhookSettings workspaceId={WORKSPACE_ID} />);

    expect(await screen.findByText("Disabled")).toBeVisible();
    expect(screen.getByText("Not verified")).toBeVisible();
  });

  it("tells the reader to verify before enabling instead of repeating '409'", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue(endpointPage([webhook]));
    update.mockResolvedValue({ ok: false, kind: "conflict", code: "WEBHOOK_NOT_VERIFIED" });
    render(<WebhookSettings workspaceId={WORKSPACE_ID} />);
    await screen.findByText(ENDPOINT_URL);

    await user.click(screen.getByRole("button", { name: `Enable ${ENDPOINT_URL}` }));

    expect(update).toHaveBeenCalledWith(WORKSPACE_ID, WEBHOOK_ID, { isEnabled: true });
    expect(await screen.findByText(/Verify this endpoint before enabling it\./u)).toBeVisible();
  });

  it("loads the delivery history only once the disclosure is opened", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue(endpointPage([webhook]));
    deliveries.mockResolvedValue(deliveryPage([delivery]));
    render(<WebhookSettings workspaceId={WORKSPACE_ID} />);
    await screen.findByText(ENDPOINT_URL);

    expect(deliveries).not.toHaveBeenCalled();

    const table = await openDeliveryHistory(user);

    expect(deliveries).toHaveBeenCalledWith(WORKSPACE_ID, WEBHOOK_ID, { page: 1, limit: 25 });
    for (const header of [
      "Time",
      "Event",
      "Attempt",
      "Status",
      "HTTP status",
      "Response snippet",
      "Retry",
    ]) {
      expect(within(table).getByRole("columnheader", { name: header })).toBeVisible();
    }
    expect(within(table).getByRole("cell", { name: "note.created" })).toBeVisible();
    expect(within(table).getByRole("cell", { name: "Failed — http error" })).toBeVisible();
    expect(within(table).getByRole("cell", { name: "500" })).toBeVisible();
    expect(within(table).getByRole("cell", { name: "upstream exploded" })).toBeVisible();
  });

  it("queues another attempt from the delivery row", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue(endpointPage([webhook]));
    deliveries.mockResolvedValue(deliveryPage([delivery]));
    retry.mockResolvedValue({
      ok: true,
      data: { webhookId: WEBHOOK_ID, eventId: EVENT_ID, scheduled: true },
    });
    render(<WebhookSettings workspaceId={WORKSPACE_ID} />);
    await screen.findByText(ENDPOINT_URL);
    await openDeliveryHistory(user);

    await user.click(screen.getByRole("button", { name: "Retry note.created attempt 2" }));

    expect(retry).toHaveBeenCalledWith(WORKSPACE_ID, WEBHOOK_ID, DELIVERY_ID);
    expect(
      await screen.findByText("A new attempt at the note.created delivery is queued."),
    ).toBeVisible();
  });

  it("holds deletion behind a host that has to be typed exactly", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue(endpointPage([webhook]));
    render(<WebhookSettings workspaceId={WORKSPACE_ID} />);
    await screen.findByText(ENDPOINT_URL);

    await user.click(screen.getByRole("button", { name: `Delete ${ENDPOINT_URL}` }));
    const field = screen.getByLabelText("Type the endpoint host (hooks.example.com) to confirm");
    // The confirmation takes focus, so a keyboard reader is not left behind.
    expect(field).toHaveFocus();

    await user.type(field, "hooks.example.co");
    expect(screen.getByRole("button", { name: "Permanently delete" })).toBeDisabled();
    expect(remove).not.toHaveBeenCalled();

    remove.mockResolvedValue({ ok: true, data: { webhookId: WEBHOOK_ID, deleted: true } });
    list.mockResolvedValue(endpointPage([]));
    await user.type(field, "m");
    await user.click(screen.getByRole("button", { name: "Permanently delete" }));

    expect(remove).toHaveBeenCalledWith(WORKSPACE_ID, WEBHOOK_ID);
    expect(
      await screen.findByText(/was deleted\. Nothing will be delivered to it again\./u),
    ).toBeVisible();
  });

  it("returns focus to the delete control when the confirmation is cancelled", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue(endpointPage([webhook]));
    render(<WebhookSettings workspaceId={WORKSPACE_ID} />);
    await screen.findByText(ENDPOINT_URL);

    await user.click(screen.getByRole("button", { name: `Delete ${ENDPOINT_URL}` }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: `Delete ${ENDPOINT_URL}` })).toHaveFocus(),
    );
    expect(remove).not.toHaveBeenCalled();
  });
});
