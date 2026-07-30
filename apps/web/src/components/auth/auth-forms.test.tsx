import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";
import { RegisterForm } from "@/components/auth/register-form";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { registerWithPassword, requestPasswordReset, resetPassword } from "@/lib/auth/requests";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/auth/requests", () => ({
  registerWithPassword: vi.fn(),
  requestPasswordReset: vi.fn(),
  resetPassword: vi.fn(),
}));

describe("authentication forms", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the shared registration password policy and confirms passwords separately", async () => {
    const user = userEvent.setup();
    render(<RegisterForm redirectTo="/" />);
    expect(screen.getByLabelText("Password")).toHaveAttribute("autocomplete", "new-password");
    expect(screen.getByLabelText("Confirm password")).toHaveAttribute(
      "autocomplete",
      "new-password",
    );

    await user.type(screen.getByLabelText("Name"), "Fresh Person");
    await user.type(screen.getByLabelText("Email"), "fresh@example.test");
    await user.type(screen.getByLabelText("Password"), "weak");
    await user.type(screen.getByLabelText("Confirm password"), "different");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveFocus());
    expect(screen.getAllByText("Passwords must match")).toHaveLength(2);
    expect(registerWithPassword).not.toHaveBeenCalled();
  });

  it("returns the same forgot-password response for any accepted address", async () => {
    const user = userEvent.setup();
    vi.mocked(requestPasswordReset).mockResolvedValue({ ok: true });
    render(<ForgotPasswordForm />);
    await user.type(screen.getByLabelText("Email"), "unknown@example.test");
    await user.click(screen.getByRole("button", { name: "Request password reset" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/if an account exists/i);
  });

  it("shows an expired-link response without exposing the provider error", async () => {
    const user = userEvent.setup();
    vi.mocked(resetPassword).mockResolvedValue({ ok: false, kind: "rejected" });
    render(<ResetPasswordForm token="a-secure-reset-token-with-more-than-32-characters" />);
    await user.type(screen.getByLabelText("New password"), "Strong1!Password");
    await user.type(screen.getByLabelText("Confirm new password"), "Strong1!Password");
    await user.click(screen.getByRole("button", { name: "Reset password" }));
    expect(await screen.findByText(/invalid or expired/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveFocus());
  });
});
