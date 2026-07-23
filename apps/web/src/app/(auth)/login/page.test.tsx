import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import LoginPage from "@/app/(auth)/login/page";

describe("Login page (Server Component)", () => {
  it("renders the Sign in heading", async () => {
    const ui = await LoginPage();
    render(ui);
    expect(screen.getByRole("heading", { level: 1, name: /sign in/i })).toBeInTheDocument();
  });

  it("renders the non-functional scaffold notice in the page body", async () => {
    const ui = await LoginPage();
    render(ui);
    expect(screen.getByText(/implemented with authentication in Part 22/i)).toBeInTheDocument();
  });

  it("renders the LoginForm island with its inputs", async () => {
    const ui = await LoginPage();
    render(ui);
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeDisabled();
  });

  it("does not link to /register (route does not exist yet)", async () => {
    const ui = await LoginPage();
    render(ui);
    expect(screen.queryByRole("link", { name: /sign up/i })).not.toBeInTheDocument();
  });
});
