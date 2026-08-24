import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AiConfigView, AiUsageSummary } from "@notted/shared-types";
import type { AiConfigUpdateInput } from "@notted/shared-validators";

import AiSettings from "@/components/workspaces/AiSettings";
import { fetchAiConfig, fetchAiUsage, updateAiConfig } from "@/lib/ai/requests";

vi.mock("@/lib/ai/requests", () => ({
  fetchAiConfig: vi.fn(),
  fetchAiUsage: vi.fn(),
  updateAiConfig: vi.fn(),
}));

const WORKSPACE_ID = "80000000-0000-4000-8000-000000000001";
const USER_ID = "80000000-0000-4000-8000-000000000002";

const loadConfig = vi.mocked(fetchAiConfig);
const loadUsage = vi.mocked(fetchAiUsage);
const save = vi.mocked(updateAiConfig);

const config: AiConfigView = {
  workspaceId: WORKSPACE_ID,
  provider: "openai",
  model: "gpt-4o-mini",
  isEnabled: true,
  hasCredentials: true,
  dailyTokenQuota: 999,
  rateLimitPerMinute: 10,
  contentConsent: true,
  updatedById: USER_ID,
  updatedAt: "2026-08-01T00:00:00.000Z",
};

/**
 * Deliberately small, ungrouped numbers: the component formats through
 * `toLocaleString`, and asserting on "50,000" would be asserting on the test
 * runner's locale rather than on the component.
 */
const usage: AiUsageSummary = {
  workspaceId: WORKSPACE_ID,
  since: "2026-07-25T00:00:00.000Z",
  until: "2026-08-24T00:00:00.000Z",
  totalRequests: 12,
  successfulRequests: 10,
  failedRequests: 1,
  rateLimitedRequests: 1,
  promptTokens: 700,
  completionTokens: 200,
  totalTokens: 900,
  costMicros: 2_500_000,
  dailyTokenQuota: 999,
  tokensUsedToday: 900,
  features: [{ feature: "summarize", requests: 8, totalTokens: 700, costMicros: 1_500_000 }],
};

const emptyUsage: AiUsageSummary = {
  ...usage,
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  rateLimitedRequests: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  costMicros: 0,
  tokensUsedToday: 0,
  features: [],
};

function mountWith(
  overrides: Partial<AiConfigView> = {},
  usageSummary: AiUsageSummary = emptyUsage,
): void {
  loadConfig.mockResolvedValue({ ok: true, data: { ...config, ...overrides } });
  loadUsage.mockResolvedValue({ ok: true, data: usageSummary });
  render(<AiSettings workspaceId={WORKSPACE_ID} />);
}

function savedInput(): AiConfigUpdateInput {
  const call = save.mock.calls[0];
  if (call === undefined) throw new Error("updateAiConfig was never called");
  return call[1];
}

describe("AiSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the stored configuration without ever rendering the key", async () => {
    mountWith();

    expect(await screen.findByLabelText("Model")).toHaveValue("gpt-4o-mini");
    const key = screen.getByLabelText("API key");
    // The response has no field that could carry the credential, so the only
    // correct starting value is the empty one.
    expect(key).toHaveValue("");
    expect(key).toHaveAttribute("type", "password");
    expect(screen.getByText(/A key is stored for this workspace/u)).toBeVisible();
    expect(key).toHaveAttribute("placeholder", "Leave blank to keep the stored key");
    expect(screen.getByRole("radio", { name: "OpenAI" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Enable AI features/u })).toBeChecked();
  });

  it("says a key is required when none is stored", async () => {
    mountWith({ hasCredentials: false, isEnabled: false, contentConsent: false });

    expect(await screen.findByText(/No key is stored yet\./u)).toBeVisible();
  });

  it("names the data-retention terms for the selected provider", async () => {
    mountWith();

    expect(
      await screen.findByText(
        "Note content you use AI features on is sent to OpenAI for processing. Notted does not store prompts or outputs.",
      ),
    ).toBeVisible();

    await userEvent.click(screen.getByRole("radio", { name: "Anthropic" }));

    expect(
      screen.getByText(
        "Note content you use AI features on is sent to Anthropic for processing. Notted does not store prompts or outputs.",
      ),
    ).toBeVisible();
  });

  it("refuses to enable AI without consent and says so beside the checkbox", async () => {
    const user = userEvent.setup();
    mountWith({ isEnabled: false, contentConsent: false });
    await screen.findByLabelText("Model");

    await user.click(screen.getByRole("checkbox", { name: /Enable AI features/u }));
    await user.click(screen.getByRole("button", { name: "Save AI settings" }));

    const consent = screen.getByRole("checkbox", { name: /Consent to sending note content/u });
    expect(consent).toHaveAttribute("aria-invalid", "true");
    expect(consent.getAttribute("aria-describedby")).toContain("ai-consent-error");
    // Once in the error summary a screen reader is sent to, once against the
    // control that has to change.
    expect(
      screen.getAllByText("Data-retention consent is required to enable AI features"),
    ).toHaveLength(2);
    // Nothing reached the server: the refusal is entirely client-side.
    expect(save).not.toHaveBeenCalled();
  });

  it("asks for a new key when the server rejects a provider switch", async () => {
    const user = userEvent.setup();
    mountWith();
    await screen.findByLabelText("Model");
    save.mockResolvedValue({ ok: false, kind: "invalid", code: "AI_CREDENTIAL_REQUIRED" });

    await user.click(screen.getByRole("radio", { name: "Anthropic" }));
    await user.click(screen.getByRole("button", { name: "Save AI settings" }));

    expect(savedInput().provider).toBe("anthropic");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Enter an API key for the new provider before saving\./u);
    expect(screen.getByLabelText("API key")).toHaveAttribute("aria-invalid", "true");
  });

  it("omits apiKey entirely when the key field is left blank", async () => {
    const user = userEvent.setup();
    mountWith();
    await screen.findByLabelText("Model");
    save.mockResolvedValue({ ok: true, data: config });

    await user.click(screen.getByRole("button", { name: "Save AI settings" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    // Absent, not `""`: absence is how the contract says "keep the stored key",
    // while an empty string is a value the server rejects.
    expect(Object.hasOwn(savedInput(), "apiKey")).toBe(false);
    expect(await screen.findByRole("status")).toHaveTextContent(/AI features are on/u);
  });

  it("sends the typed key when one is supplied", async () => {
    const user = userEvent.setup();
    mountWith();
    await screen.findByLabelText("Model");
    save.mockResolvedValue({ ok: true, data: config });

    await user.type(screen.getByLabelText("API key"), "sk-test-0123456789abcdefghij");
    await user.click(screen.getByRole("button", { name: "Save AI settings" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(savedInput().apiKey).toBe("sk-test-0123456789abcdefghij");
    // The field is cleared after a successful save so it cannot be resubmitted.
    expect(screen.getByLabelText("API key")).toHaveValue("");
  });

  it("turns the feature off when the provider is disabled", async () => {
    const user = userEvent.setup();
    mountWith();
    await screen.findByLabelText("Model");
    save.mockResolvedValue({
      ok: true,
      data: { ...config, provider: "disabled", isEnabled: false },
    });

    await user.click(screen.getByRole("radio", { name: "Disable AI" }));

    expect(screen.getByLabelText("Model")).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /Enable AI features/u })).not.toBeChecked();

    await user.click(screen.getByRole("button", { name: "Save AI settings" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(savedInput()).toMatchObject({ provider: "disabled", isEnabled: false, model: null });
    expect(await screen.findByRole("status")).toHaveTextContent(/AI features are off/u);
  });

  it("explains that there is no usage yet", async () => {
    mountWith();

    expect(await screen.findByText(/No AI usage recorded yet\./u)).toBeVisible();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("reports totals and the per-feature breakdown", async () => {
    mountWith({}, usage);

    const totals = await screen.findByRole("table", { name: "AI totals for this workspace" });
    expect(within(totals).getByRole("rowheader", { name: "Requests" })).toBeVisible();
    expect(within(totals).getByRole("cell", { name: "12" })).toBeVisible();
    expect(within(totals).getByRole("cell", { name: "10" })).toBeVisible();
    expect(within(totals).getByRole("cell", { name: "900" })).toBeVisible();
    expect(within(totals).getByRole("cell", { name: /2\.50/u })).toBeVisible();
    // The quota is shown as spent-against-limit, not as a bare number.
    expect(within(totals).getByRole("cell", { name: "900 of 999" })).toBeVisible();

    const byFeature = screen.getByRole("table", { name: "AI usage by feature" });
    for (const header of ["Feature", "Requests", "Tokens", "Cost"]) {
      expect(within(byFeature).getByRole("columnheader", { name: header })).toBeVisible();
    }
    expect(within(byFeature).getByRole("rowheader", { name: "summarize" })).toBeVisible();
    expect(within(byFeature).getByRole("cell", { name: "8" })).toBeVisible();
    expect(within(byFeature).getByRole("cell", { name: /1\.50/u })).toBeVisible();
  });

  it("keeps the form usable when only the usage roll-up fails", async () => {
    loadConfig.mockResolvedValue({ ok: true, data: config });
    loadUsage.mockResolvedValueOnce({ ok: false, kind: "unavailable", retryable: true });
    loadUsage.mockResolvedValueOnce({ ok: true, data: usage });
    render(<AiSettings workspaceId={WORKSPACE_ID} />);

    expect(await screen.findByText(/Usage could not be loaded\./u)).toBeVisible();
    expect(screen.getByLabelText("Model")).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(
      await screen.findByRole("table", { name: "AI totals for this workspace" }),
    ).toBeVisible();
  });

  it("alerts and retries when the configuration cannot be loaded", async () => {
    loadUsage.mockResolvedValue({ ok: true, data: emptyUsage });
    loadConfig.mockResolvedValueOnce({ ok: false, kind: "unavailable", retryable: true });
    loadConfig.mockResolvedValueOnce({ ok: true, data: config });
    render(<AiSettings workspaceId={WORKSPACE_ID} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/unavailable right now\. Nothing was changed\./u);
    expect(screen.queryByLabelText("Model")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByLabelText("Model")).toHaveValue("gpt-4o-mini");
    expect(loadConfig).toHaveBeenCalledTimes(2);
  });

  it("names the missing permission rather than offering a pointless retry", async () => {
    loadConfig.mockResolvedValue({ ok: false, kind: "forbidden-or-not-found" });
    loadUsage.mockResolvedValue({ ok: false, kind: "forbidden-or-not-found" });
    render(<AiSettings workspaceId={WORKSPACE_ID} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You need to be a workspace admin to manage AI settings.",
    );
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});
