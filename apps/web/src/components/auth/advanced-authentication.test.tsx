import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdvancedSignInMethods } from "@/components/auth/advanced-sign-in-methods";
import { ReauthenticationDialog } from "@/components/auth/reauthentication-dialog";
import { TwoFactorChallenge } from "@/components/auth/two-factor-challenge";
import {
  reauthenticate,
  signInWithOAuth,
  verifyRecoveryCode,
  verifyTotp,
} from "@/lib/auth/requests";

const replace = vi.fn();
const refresh = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, refresh }) }));
vi.mock("@/lib/auth/requests", () => ({
  reauthenticate: vi.fn(),
  signInWithOAuth: vi.fn(),
  signInWithPasskey: vi.fn(),
  verifyRecoveryCode: vi.fn(),
  verifyTotp: vi.fn(),
}));
vi.mock("@/lib/auth/security-requests", () => ({ loadPrincipal: vi.fn() }));

const capabilities = {
  oauthProviders: [
    { id: "google" as const, label: "Google" },
    { id: "microsoft" as const, label: "Microsoft" },
  ],
  passkeyEnabled: true,
  twoFactorEnabled: true,
  nonRememberedSessionSeconds: 86_400,
  rememberedSessionSeconds: 2_592_000,
  recentAuthenticationSeconds: 600,
};

describe("advanced authentication controls", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders only enabled OAuth providers and uses an allow-listed local callback", async () => {
    const user = userEvent.setup();
    vi.mocked(signInWithOAuth).mockResolvedValue({ ok: false, kind: "rejected" });
    render(<AdvancedSignInMethods capabilities={capabilities} redirectTo="/settings/security" />);
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Continue with Microsoft" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /GitHub/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue with Google" }));
    expect(signInWithOAuth).toHaveBeenCalledWith(
      "google",
      "http://localhost:3000/settings/security",
      "http://localhost:3000/login?oauth=error&redirect=%2Fsettings%2Fsecurity",
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be started/i);
  });

  it("has a clean provider-disabled state without an empty OAuth control", () => {
    render(
      <AdvancedSignInMethods
        capabilities={{ ...capabilities, oauthProviders: [] }}
        redirectTo="/"
      />,
    );
    expect(screen.queryByRole("button", { name: /Continue with/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /passkey/i })).toBeInTheDocument();
    expect(screen.getByText(/secure HTTPS context/i)).toBeVisible();
  });

  it("switches between TOTP and recovery, keeps errors generic, and moves focus", async () => {
    const user = userEvent.setup();
    vi.mocked(verifyTotp).mockResolvedValue({ ok: false, kind: "rejected" });
    vi.mocked(verifyRecoveryCode).mockResolvedValue({ ok: true });
    render(<TwoFactorChallenge redirectTo="/settings/security" />);
    await user.type(screen.getByLabelText("Authenticator code"), "123456");
    await user.click(screen.getByRole("button", { name: "Verify and continue" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveFocus());
    expect(screen.getByRole("alert")).not.toHaveTextContent("123456");
    await user.click(screen.getByRole("button", { name: "Use a recovery code" }));
    await user.type(screen.getByLabelText("Recovery code"), "ABCDE-FGHIJ");
    await user.click(screen.getByRole("button", { name: "Verify and continue" }));
    expect(replace).toHaveBeenCalledWith("/settings/security");
  });

  it("focuses the reauthentication credential, clears it, and supports Escape", async () => {
    const user = userEvent.setup();
    const cancel = vi.fn();
    const confirmed = vi.fn().mockResolvedValue(true);
    vi.mocked(reauthenticate).mockResolvedValue({ ok: true });
    const { rerender } = render(
      <ReauthenticationDialog
        open
        title="Confirm change"
        onCancel={cancel}
        onConfirmed={confirmed}
      />,
    );
    await waitFor(() => expect(screen.getByLabelText("Current password")).toHaveFocus());
    await user.type(screen.getByLabelText("Current password"), "not-retained");
    await user.click(screen.getByRole("button", { name: "Confirm with password" }));
    await waitFor(() => expect(cancel).toHaveBeenCalled());
    rerender(
      <ReauthenticationDialog
        open
        title="Confirm change"
        onCancel={cancel}
        onConfirmed={confirmed}
      />,
    );
    expect(screen.getByLabelText("Current password")).toHaveValue("");
    await user.keyboard("{Escape}");
    expect(cancel).toHaveBeenCalled();
  });
});
