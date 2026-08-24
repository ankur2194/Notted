"use client";

import { AI_PROVIDER_NAMES } from "@notted/shared-types";
import {
  AI_DEFAULT_DAILY_TOKEN_QUOTA,
  AI_DEFAULT_RATE_LIMIT_PER_MINUTE,
  AI_MAX_DAILY_TOKEN_QUOTA,
  AI_MAX_RATE_LIMIT_PER_MINUTE,
  aiConfigUpdateSchema,
} from "@notted/shared-validators";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ApiRequestFailure, ApiRequestFailureKind } from "@/lib/api/request-json";
import type { AiConfigView, AiProviderName, AiUsageSummary } from "@notted/shared-types";
import type { AiConfigUpdateInput } from "@notted/shared-validators";
import type { FormEvent } from "react";

import { ErrorSummary, FormField, FormStatus } from "@/components/ui/form-controls";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchAiConfig, fetchAiUsage, updateAiConfig } from "@/lib/ai/requests";

/**
 * Part 67 — workspace AI provider configuration, governance, and usage.
 *
 * Modelled on `ApiKeys` and `WebhookSettings`: a workspace-settings island with
 * local state and no TanStack Query. There is one reader, no cache to share and
 * nothing to invalidate beyond re-running this component's own load.
 *
 * ponytail: local state, no query client. Upgrade path is the same as its two
 * neighbours — move onto the query client when a second surface (an editor AI
 * panel reading the same config) needs it.
 *
 * PERMISSION: the settings page renders this only for a workspace admin, and
 * that gate is presentation only — both routes below re-authorize server-side,
 * so a member who forces the component to render gets a 403 and the permission
 * copy rather than a configuration.
 *
 * THE CREDENTIAL IS NEVER RENDERED. The API has no field that could carry it;
 * all this component ever learns is `hasCredentials`, and the key input starts
 * empty on every load precisely so a blank submit means "keep what is stored".
 */

const USAGE_WINDOW_DAYS = 30;

const PERMISSION_MESSAGE = "You need to be a workspace admin to manage AI settings.";

/**
 * Provider display names.
 *
 * `disabled` deliberately reads as "the provider" rather than "Disabled": its
 * only use is inside the data-retention sentence, where "sent to Disabled for
 * processing" would be nonsense.
 */
const PROVIDER_LABELS: Readonly<Record<AiProviderName, string>> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  disabled: "the provider",
};

const PROVIDER_CHOICES: Readonly<Record<AiProviderName, string>> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  disabled: "Disable AI",
};

/**
 * Copy keyed by the stable `ApiErrorCode`, for the one failure whose remedy is
 * not implied by its status.
 *
 * `requestJson` maps 422 to `kind: "invalid"` and carries the envelope code
 * through, so a rejected provider switch arrives as `invalid` +
 * `AI_CREDENTIAL_REQUIRED` — indistinguishable from a malformed model name
 * without consulting the code, and the two ask for opposite actions.
 */
const CODE_MESSAGES: Readonly<Record<string, string>> = {
  AI_CREDENTIAL_REQUIRED:
    "Enter an API key for the new provider before saving. The stored key belongs to the previous provider and cannot be reused.",
};

/** Our own copy, always: an error envelope is a lookup key here, never text to echo. */
const KIND_MESSAGES: Readonly<Record<ApiRequestFailureKind, string>> = {
  invalid: "That configuration was rejected. Check the model name, quota, and rate limit.",
  "forbidden-or-not-found": PERMISSION_MESSAGE,
  conflict: "Someone else changed these settings first. Reload the page and try again.",
  "version-conflict": "Someone else changed these settings first. Reload the page and try again.",
  unavailable: "AI settings are unavailable right now. Nothing was changed.",
};

function failureMessage(failure: ApiRequestFailure): string {
  const named = failure.code === undefined ? undefined : CODE_MESSAGES[failure.code];
  return named ?? KIND_MESSAGES[failure.kind];
}

/** `costMicros` is millionths of a US dollar; four fraction digits keep a sub-cent spend visible. */
function formatCost(costMicros: number): string {
  return (costMicros / 1_000_000).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

function formatCount(value: number): string {
  return value.toLocaleString();
}

type AiFieldName =
  | "provider"
  | "model"
  | "apiKey"
  | "isEnabled"
  | "dailyTokenQuota"
  | "rateLimitPerMinute"
  | "contentConsent";

const FIELD_NAMES: readonly AiFieldName[] = [
  "provider",
  "model",
  "apiKey",
  "isEnabled",
  "dailyTokenQuota",
  "rateLimitPerMinute",
  "contentConsent",
];

type FieldErrors = Partial<Record<AiFieldName, string>>;

function isFieldName(value: unknown): value is AiFieldName {
  return typeof value === "string" && (FIELD_NAMES as readonly string[]).includes(value);
}

/** A whole non-negative integer typed into a number input, or `null` for anything else. */
function wholeNumber(raw: string): number | null {
  if (!/^\d+$/u.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) ? value : null;
}

export default function AiSettings({ workspaceId }: { readonly workspaceId: string }) {
  const [config, setConfig] = useState<AiConfigView | null>(null);
  const [usage, setUsage] = useState<AiUsageSummary | null>(null);
  const [loadFailure, setLoadFailure] = useState<ApiRequestFailureKind | null>(null);
  const [usageFailed, setUsageFailed] = useState(false);

  const [provider, setProvider] = useState<AiProviderName>("disabled");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [quota, setQuota] = useState(String(AI_DEFAULT_DAILY_TOKEN_QUOTA));
  const [rateLimit, setRateLimit] = useState(String(AI_DEFAULT_RATE_LIMIT_PER_MINUTE));
  const [consent, setConsent] = useState(false);
  const [enabled, setEnabled] = useState(false);

  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const errorSummaryRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoadFailure(null);
    setUsageFailed(false);
    // Both reads are admin-only and independent, so they go out together rather
    // than making the reader wait for two sequential round trips.
    const [configResult, usageResult] = await Promise.all([
      fetchAiConfig(workspaceId),
      fetchAiUsage(workspaceId, USAGE_WINDOW_DAYS),
    ]);

    if (!configResult.ok) {
      setConfig(null);
      setUsage(null);
      setLoadFailure(configResult.kind);
      return;
    }

    const loaded = configResult.data;
    setConfig(loaded);
    setProvider(loaded.provider);
    setModel(loaded.model ?? "");
    // Always blank: the key is not in the response, and an empty field is what
    // tells the server to keep the stored credential.
    setApiKey("");
    setQuota(String(loaded.dailyTokenQuota));
    setRateLimit(String(loaded.rateLimitPerMinute));
    setConsent(loaded.contentConsent);
    setEnabled(loaded.isEnabled);

    if (usageResult.ok) setUsage(usageResult.data);
    else {
      setUsage(null);
      // A usage outage is not a configuration outage: the form stays usable.
      setUsageFailed(true);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The summary is the thing a screen reader has to reach after a rejected
  // submit, and it is only in the tree once there is something to say.
  useEffect(() => {
    if (submitError !== null) errorSummaryRef.current?.focus();
  }, [submitError]);

  function reject(errors: FieldErrors, summary: string): void {
    setFieldErrors(errors);
    setSubmitError(summary);
    setStatus("");
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    const dailyTokenQuota = wholeNumber(quota);
    const rateLimitPerMinute = wholeNumber(rateLimit);
    // Checked before Zod so an empty or malformed number field gets copy about
    // this form rather than the schema's "expected number, received nan".
    if (dailyTokenQuota === null || rateLimitPerMinute === null) {
      reject(
        {
          dailyTokenQuota:
            dailyTokenQuota === null
              ? `Enter a whole number of tokens between 0 and ${AI_MAX_DAILY_TOKEN_QUOTA}.`
              : undefined,
          rateLimitPerMinute:
            rateLimitPerMinute === null
              ? `Enter a whole number of requests between 1 and ${AI_MAX_RATE_LIMIT_PER_MINUTE}.`
              : undefined,
        },
        "Check the daily token quota and the requests-per-minute limit.",
      );
      return;
    }

    // Choosing "Disable AI" is a single decision, not three: it cannot carry a
    // model and cannot leave the feature enabled, so the form states that
    // outright instead of bouncing the reader off a refinement.
    const disabled = provider === "disabled";
    const trimmedModel = model.trim();
    const trimmedKey = apiKey.trim();
    const input: AiConfigUpdateInput = {
      provider,
      model: disabled || trimmedModel === "" ? null : trimmedModel,
      isEnabled: disabled ? false : enabled,
      dailyTokenQuota,
      rateLimitPerMinute,
      contentConsent: consent,
      // A blank field means "keep the stored credential", which the contract
      // expresses as an ABSENT property. `""` would be a rejected value.
      ...(trimmedKey === "" ? {} : { apiKey: trimmedKey }),
    };

    const parsed = aiConfigUpdateSchema.safeParse(input);
    if (!parsed.success) {
      const errors: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const [head] = issue.path;
        if (isFieldName(head) && errors[head] === undefined) errors[head] = issue.message;
      }
      reject(errors, parsed.error.issues.map((issue) => issue.message).join(" "));
      return;
    }

    setSubmitting(true);
    setFieldErrors({});
    setSubmitError(null);
    setStatus("");
    const result = await updateAiConfig(workspaceId, input);
    setSubmitting(false);

    if (!result.ok) {
      // Keyed to the key field when that is the thing to fix, so the fix is
      // announced where the reader's focus is going.
      const message = failureMessage(result);
      reject(result.code === "AI_CREDENTIAL_REQUIRED" ? { apiKey: message } : {}, message);
      return;
    }

    setConfig(result.data);
    setApiKey("");
    setSubmitError(null);
    setStatus(
      result.data.isEnabled
        ? `AI features are on for this workspace using ${PROVIDER_CHOICES[result.data.provider]}.`
        : "AI settings saved. AI features are off for this workspace.",
    );
  }

  if (loadFailure !== null) {
    return (
      <section aria-labelledby="ai-settings-heading" className="space-y-4 rounded-md border p-4">
        <h2 id="ai-settings-heading" className="text-lg font-semibold">
          AI features
        </h2>
        <div role="alert" className="space-y-2 text-sm">
          <p>{KIND_MESSAGES[loadFailure]}</p>
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
      </section>
    );
  }

  if (config === null) {
    return (
      <section aria-labelledby="ai-settings-heading" className="space-y-4 rounded-md border p-4">
        <h2 id="ai-settings-heading" className="text-lg font-semibold">
          AI features
        </h2>
        <p className="text-sm text-muted-foreground">Loading AI settings…</p>
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-24 w-full" />
      </section>
    );
  }

  const providerDisabled = provider === "disabled";
  const retentionSentence = `Note content you use AI features on is sent to ${PROVIDER_LABELS[provider]} for processing. Notted does not store prompts or outputs.`;

  return (
    <section aria-labelledby="ai-settings-heading" className="space-y-4 rounded-md border p-4">
      <h2 id="ai-settings-heading" className="text-lg font-semibold">
        AI features
      </h2>
      <p className="text-sm text-muted-foreground">
        AI is off until an admin turns it on. Usage is charged to the key stored here, so the quota
        and rate limit below are the spend controls for this workspace.
      </p>

      <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
        {submitError === null ? null : <ErrorSummary ref={errorSummaryRef} message={submitError} />}

        {/*
          A native fieldset of radios, not a hand-built `role="radiogroup"`: the
          browser already gives arrow-key selection, roving focus, and the group
          name for free, and there is no ARIA reimplementation to keep correct.
          `aria-describedby` is global, so the group error is announced without
          claiming an ARIA property a group does not support.
        */}
        <fieldset
          className="space-y-1"
          aria-describedby={fieldErrors.provider === undefined ? undefined : "ai-provider-error"}
        >
          <legend className="text-sm font-medium">AI provider</legend>
          {AI_PROVIDER_NAMES.map((name) => (
            <div key={name} className="flex min-h-11 items-center gap-3">
              <input
                id={`ai-provider-${name}`}
                type="radio"
                name="ai-provider"
                value={name}
                checked={provider === name}
                disabled={submitting}
                onChange={() => setProvider(name)}
                className="size-4"
              />
              <label htmlFor={`ai-provider-${name}`} className="text-sm">
                {PROVIDER_CHOICES[name]}
              </label>
            </div>
          ))}
          {fieldErrors.provider === undefined ? null : (
            <p id="ai-provider-error" className="text-sm text-destructive">
              {fieldErrors.provider}
            </p>
          )}
        </fieldset>

        <FormField
          id="ai-model"
          label="Model"
          type="text"
          maxLength={100}
          value={model}
          disabled={submitting || providerDisabled}
          error={fieldErrors.model}
          hint={
            providerDisabled
              ? "Choose a provider above to set a model."
              : "The provider's model identifier, for example gpt-4o-mini or claude-sonnet-4."
          }
          onChange={(event) => setModel(event.target.value)}
        />

        <FormField
          id="ai-api-key"
          label="API key"
          type="password"
          autoComplete="off"
          value={apiKey}
          disabled={submitting}
          error={fieldErrors.apiKey}
          placeholder={config.hasCredentials ? "Leave blank to keep the stored key" : ""}
          hint={
            config.hasCredentials
              ? "A key is stored for this workspace. It is never shown again — leave this blank to keep it, or paste a new key to replace it. Switching provider always needs a new key."
              : "No key is stored yet. A key is required before AI features can be turned on."
          }
          onChange={(event) => setApiKey(event.target.value)}
        />

        <FormField
          id="ai-daily-quota"
          label="Daily token quota"
          type="number"
          inputMode="numeric"
          min={0}
          max={AI_MAX_DAILY_TOKEN_QUOTA}
          step={1}
          value={quota}
          disabled={submitting}
          error={fieldErrors.dailyTokenQuota}
          hint="Tokens this workspace may spend per UTC day. Requests are refused once it is reached."
          onChange={(event) => setQuota(event.target.value)}
        />

        <FormField
          id="ai-rate-limit"
          label="Requests per minute"
          type="number"
          inputMode="numeric"
          min={1}
          max={AI_MAX_RATE_LIMIT_PER_MINUTE}
          step={1}
          value={rateLimit}
          disabled={submitting}
          error={fieldErrors.rateLimitPerMinute}
          hint="Ceiling on AI requests per minute across the whole workspace."
          onChange={(event) => setRateLimit(event.target.value)}
        />

        <div className="space-y-1">
          <div className="flex min-h-11 items-start gap-3">
            <input
              id="ai-consent"
              type="checkbox"
              checked={consent}
              disabled={submitting}
              aria-invalid={fieldErrors.contentConsent === undefined ? undefined : true}
              aria-describedby={
                fieldErrors.contentConsent === undefined
                  ? "ai-consent-hint"
                  : "ai-consent-hint ai-consent-error"
              }
              onChange={(event) => setConsent(event.target.checked)}
              className="mt-3 size-4"
            />
            <label htmlFor="ai-consent" className="mt-2 text-sm">
              Consent to sending note content to this provider
            </label>
          </div>
          <p id="ai-consent-hint" className="text-sm text-muted-foreground">
            {retentionSentence}
          </p>
          {fieldErrors.contentConsent === undefined ? null : (
            <p id="ai-consent-error" className="text-sm text-destructive">
              {fieldErrors.contentConsent}
            </p>
          )}
        </div>

        <div className="flex min-h-11 items-center gap-3">
          <input
            id="ai-enabled"
            type="checkbox"
            checked={enabled && !providerDisabled}
            disabled={submitting || providerDisabled}
            onChange={(event) => setEnabled(event.target.checked)}
            className="size-4"
          />
          <label htmlFor="ai-enabled" className="text-sm">
            Enable AI features for this workspace
          </label>
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="inline-flex min-h-11 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-60"
        >
          {submitting ? "Saving…" : "Save AI settings"}
        </button>
      </form>

      {status === "" ? null : <FormStatus>{status}</FormStatus>}

      <h3 className="text-base font-semibold">Usage in the last {USAGE_WINDOW_DAYS} days</h3>
      {usageFailed ? (
        <div role="alert" className="space-y-2 text-sm">
          <p>Usage could not be loaded. The settings above are unaffected.</p>
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex min-h-11 items-center rounded-md border px-3 text-sm font-medium"
          >
            Try again
          </button>
        </div>
      ) : usage === null || usage.totalRequests === 0 ? (
        <p className="text-sm text-muted-foreground">
          No AI usage recorded yet. Requests appear here once someone uses an AI feature.
        </p>
      ) : (
        <div className="space-y-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="mb-2 text-left text-sm text-muted-foreground">
              AI totals for this workspace
            </caption>
            <tbody>
              {[
                ["Requests", formatCount(usage.totalRequests)],
                ["Succeeded", formatCount(usage.successfulRequests)],
                ["Failed", formatCount(usage.failedRequests)],
                ["Rate limited", formatCount(usage.rateLimitedRequests)],
                ["Prompt tokens", formatCount(usage.promptTokens)],
                ["Completion tokens", formatCount(usage.completionTokens)],
                ["Total tokens", formatCount(usage.totalTokens)],
                ["Cost", formatCost(usage.costMicros)],
                [
                  "Tokens used today",
                  `${formatCount(usage.tokensUsedToday)} of ${formatCount(usage.dailyTokenQuota)}`,
                ],
              ].map(([label, value]) => (
                <tr key={label} className="border-b last:border-0">
                  <th scope="row" className="py-2 pr-4 font-medium">
                    {label}
                  </th>
                  <td className="py-2">{value}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <table className="w-full text-left text-sm">
            <caption className="mb-2 text-left text-sm text-muted-foreground">
              AI usage by feature
            </caption>
            <thead>
              <tr className="border-b">
                <th scope="col" className="py-2 pr-4 font-medium">
                  Feature
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Requests
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Tokens
                </th>
                <th scope="col" className="py-2 font-medium">
                  Cost
                </th>
              </tr>
            </thead>
            <tbody>
              {usage.features.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-2 text-muted-foreground">
                    No feature breakdown yet.
                  </td>
                </tr>
              ) : (
                usage.features.map((feature) => (
                  <tr key={feature.feature} className="border-b last:border-0">
                    <th scope="row" className="py-2 pr-4 font-medium">
                      {feature.feature}
                    </th>
                    <td className="py-2 pr-4">{formatCount(feature.requests)}</td>
                    <td className="py-2 pr-4">{formatCount(feature.totalTokens)}</td>
                    <td className="py-2">{formatCost(feature.costMicros)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
