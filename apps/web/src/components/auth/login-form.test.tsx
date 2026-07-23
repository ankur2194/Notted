import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LoginForm } from "@/components/auth/login-form";

describe("LoginForm", () => {
  it("labels and disables every authentication control", () => {
    render(
      <>
        <p id="login-availability">Available in Part 22.</p>
        <LoginForm />
      </>,
    );

    const controls = [
      screen.getByLabelText("Email"),
      screen.getByLabelText("Password"),
      screen.getByRole("button", { name: "Sign in" }),
      screen.getByRole("button", { name: "Google" }),
      screen.getByRole("button", { name: "GitHub" }),
    ];

    for (const control of controls) {
      expect(control).toBeDisabled();
      expect(control).toHaveAccessibleDescription("Available in Part 22.");
    }
  });

  it("cannot submit or schedule deferred work", () => {
    const submit = vi.fn();
    const timer = vi.spyOn(globalThis, "setTimeout");
    const { container } = render(
      <>
        <p id="login-availability">Available in Part 22.</p>
        <div onSubmit={submit}>
          <LoginForm />
        </div>
      </>,
    );

    screen.getByRole("button", { name: "Sign in" }).click();

    expect(submit).not.toHaveBeenCalled();
    expect(timer).not.toHaveBeenCalled();
    expect(container).not.toHaveTextContent(/signing in|error/i);
    timer.mockRestore();
  });

  it("does not expose a registration route", () => {
    render(
      <>
        <p id="login-availability">Available in Part 22.</p>
        <LoginForm />
      </>,
    );
    expect(screen.queryByRole("link", { name: /sign up/i })).not.toBeInTheDocument();
  });
});
