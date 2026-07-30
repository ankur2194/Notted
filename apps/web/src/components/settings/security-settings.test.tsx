import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SecuritySettings } from "@/components/settings/security-settings";
import {
  disableTwoFactor,
  enableTwoFactor,
  regenerateRecoveryCodes,
  verifyTotp,
} from "@/lib/auth/requests";
import {
  loadSecurityOverview,
  revokeOtherSessions,
  revokeRemoteSession,
} from "@/lib/auth/security-requests";

vi.mock("@/components/auth/reauthentication-dialog", () => ({
  ReauthenticationDialog: ({
    open,
    onConfirmed,
  }: {
    open: boolean;
    onConfirmed: (password: string) => Promise<boolean>;
  }) =>
    open ? (
      <button type="button" onClick={() => void onConfirmed("fixture-only")}>
        Mock confirm identity
      </button>
    ) : null,
}));
vi.mock("@/lib/auth/requests", () => ({
  addPasskey: vi.fn(),
  deletePasskey: vi.fn(),
  disableTwoFactor: vi.fn(),
  enableTwoFactor: vi.fn(),
  regenerateRecoveryCodes: vi.fn(),
  verifyTotp: vi.fn(),
}));
vi.mock("@/lib/auth/security-requests", () => ({
  loadSecurityOverview: vi.fn(),
  revokeOtherSessions: vi.fn(),
  revokeRemoteSession: vi.fn(),
}));

const capabilities = {
  oauthProviders: [],
  passkeyEnabled: true,
  twoFactorEnabled: true,
  nonRememberedSessionSeconds: 86_400,
  rememberedSessionSeconds: 2_592_000,
  recentAuthenticationSeconds: 600,
};

const overview = {
  twoFactorEnabled: true,
  sessions: [
    {
      id: "current",
      current: true,
      device: "Chrome on Linux",
      createdAt: "2026-07-29T10:00:00.000Z",
      updatedAt: "2026-07-29T11:00:00.000Z",
      expiresAt: "2026-08-28T10:00:00.000Z",
    },
    {
      id: "remote",
      current: false,
      device: "Firefox on Windows",
      createdAt: "2026-07-28T10:00:00.000Z",
      updatedAt: "2026-07-28T11:00:00.000Z",
      expiresAt: "2026-07-30T10:00:00.000Z",
    },
  ],
  passkeys: [
    {
      id: "passkey-id",
      name: "Work laptop",
      deviceType: "multiDevice",
      backedUp: true,
      createdAt: "2026-07-29T10:00:00.000Z",
    },
  ],
};

describe("SecuritySettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadSecurityOverview).mockResolvedValue(overview);
  });

  it("renders safe current/remote session and passkey summaries and revokes remotely", async () => {
    const user = userEvent.setup();
    vi.mocked(revokeRemoteSession).mockResolvedValue({ ok: true });
    render(<SecuritySettings capabilities={capabilities} />);
    expect(await screen.findByText("Chrome on Linux")).toHaveTextContent("current");
    expect(screen.getByText("Firefox on Windows")).toBeVisible();
    expect(screen.getByText("Work laptop")).toBeVisible();
    expect(screen.queryByText(/credential|public key|token/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Revoke session" }));
    await user.click(screen.getByRole("button", { name: "Mock confirm identity" }));
    await waitFor(() => expect(revokeRemoteSession).toHaveBeenCalledWith("remote"));
  });

  it("shows regenerated recovery codes once and clears them on acknowledgement", async () => {
    const user = userEvent.setup();
    vi.mocked(regenerateRecoveryCodes).mockResolvedValue({
      ok: true,
      recoveryCodes: ["[redacted]"],
    });
    render(<SecuritySettings capabilities={capabilities} />);
    await screen.findByRole("heading", { name: "Two-factor authentication" });
    await user.click(screen.getByRole("button", { name: "Regenerate recovery codes" }));
    await user.click(screen.getByRole("button", { name: "Mock confirm identity" }));
    expect(await screen.findByText("[redacted]")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "I saved these codes" }));
    expect(screen.queryByText("[redacted]")).not.toBeInTheDocument();
  });

  it("requires confirmation before disabling two-factor authentication", async () => {
    const user = userEvent.setup();
    vi.mocked(disableTwoFactor).mockResolvedValue({ ok: true });
    render(<SecuritySettings capabilities={capabilities} />);
    await user.click(
      await screen.findByRole("button", { name: "Disable two-factor authentication" }),
    );
    expect(disableTwoFactor).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Mock confirm identity" }));
    await waitFor(() => expect(disableTwoFactor).toHaveBeenCalledWith("fixture-only"));
  });

  it("presents QR and otpauth enrollment, confirms TOTP, then displays recovery codes", async () => {
    const user = userEvent.setup();
    vi.mocked(loadSecurityOverview).mockResolvedValue({ ...overview, twoFactorEnabled: false });
    vi.mocked(enableTwoFactor).mockResolvedValue({
      ok: true,
      totpURI: "otpauth://totp/Notted:user?secret=%5Bredacted%5D",
      recoveryCodes: ["[redacted]"],
    });
    vi.mocked(verifyTotp).mockResolvedValue({ ok: true });
    render(<SecuritySettings capabilities={capabilities} />);
    await user.click(
      await screen.findByRole("button", { name: "Enable two-factor authentication" }),
    );
    await user.click(screen.getByRole("button", { name: "Mock confirm identity" }));
    expect(await screen.findByRole("img", { name: "Authenticator setup QR code" })).toBeVisible();
    expect(screen.getByText(/^otpauth:\/\//u)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Authenticator code"), "123456");
    await user.click(screen.getByRole("button", { name: "Confirm authenticator" }));
    expect(await screen.findByText("[redacted]")).toBeVisible();
  });

  it("provides error and retry states without rendering stale security data", async () => {
    const user = userEvent.setup();
    vi.mocked(loadSecurityOverview).mockResolvedValueOnce(null).mockResolvedValueOnce(overview);
    render(<SecuritySettings capabilities={capabilities} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be loaded/i);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Chrome on Linux")).toBeVisible();
    expect(revokeOtherSessions).not.toHaveBeenCalled();
  });

  it("disables passkey registration with an accessible insecure-context state", async () => {
    render(<SecuritySettings capabilities={capabilities} />);
    await screen.findByRole("heading", { name: "Passkeys" });

    expect(screen.getByRole("button", { name: "Register passkey" })).toBeDisabled();
    expect(screen.getByText(/not in a secure context/i)).toHaveAttribute("role", "status");
  });
});
