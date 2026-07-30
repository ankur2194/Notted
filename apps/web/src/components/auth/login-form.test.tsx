import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LoginForm } from "@/components/auth/login-form";
import { signInWithPassword } from "@/lib/auth/requests";

const replace = vi.fn();
const refresh = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, refresh }) }));
vi.mock("@/lib/auth/requests", () => ({ signInWithPassword: vi.fn() }));

describe("LoginForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses credential autocomplete semantics and links every recovery entry point", () => {
    render(<LoginForm redirectTo="/" />);

    expect(screen.getByLabelText("Email")).toHaveAttribute("autocomplete", "email");
    expect(screen.getByLabelText("Password")).toHaveAttribute("autocomplete", "current-password");
    expect(screen.getByLabelText(/Remember this browser for 30 days/i)).toBeEnabled();
    expect(screen.getByRole("link", { name: "Forgot password?" })).toHaveAttribute(
      "href",
      "/forgot-password",
    );
    expect(screen.getByRole("link", { name: "Create an account" })).toHaveAttribute(
      "href",
      "/register?redirect=%2F",
    );
  });

  it("shows associated field errors and moves focus to the error summary", async () => {
    const user = userEvent.setup();
    render(<LoginForm />);

    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveFocus());
    expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Password")).toHaveAccessibleDescription();
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it("submits normalized shared-schema data, disables controls, and refreshes the target", async () => {
    const user = userEvent.setup();
    vi.mocked(signInWithPassword).mockResolvedValue({ ok: true });
    render(<LoginForm redirectTo="/workspaces?view=recent" />);

    await user.type(screen.getByLabelText("Email"), " PERSON@EXAMPLE.TEST ");
    await user.type(screen.getByLabelText("Password"), "Valid1!Password");
    await user.click(screen.getByLabelText(/Remember this browser/i));
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(signInWithPassword).toHaveBeenCalledWith({
        email: "person@example.test",
        password: "Valid1!Password",
        rememberMe: true,
      });
    });
    expect(replace).toHaveBeenCalledWith("/workspaces?view=recent");
    expect(refresh).toHaveBeenCalled();
  });

  it("uses a generic credential error without echoing provider details", async () => {
    const user = userEvent.setup();
    vi.mocked(signInWithPassword).mockResolvedValue({ ok: false, kind: "rejected" });
    render(<LoginForm />);
    await user.type(screen.getByLabelText("Email"), "person@example.test");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText(/unable to sign in/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveFocus());
  });
});
