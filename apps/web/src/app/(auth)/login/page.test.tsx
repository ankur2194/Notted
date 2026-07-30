import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import LoginPage from "@/app/(auth)/login/page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/auth/auth-page-guard", () => ({
  redirectAuthenticatedFromAuthPage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/auth/server-capabilities", () => ({
  getAuthCapabilities: vi.fn().mockResolvedValue({
    status: "available",
    value: {
      oauthProviders: [],
      passkeyEnabled: true,
      twoFactorEnabled: true,
      nonRememberedSessionSeconds: 86_400,
      rememberedSessionSeconds: 2_592_000,
      recentAuthenticationSeconds: 600,
    },
  }),
}));

describe("Login page", () => {
  it("renders functional password and magic-link entry points with a safe target", async () => {
    render(
      await LoginPage({
        searchParams: Promise.resolve({ redirect: "/workspaces?view=recent" }),
      }),
    );

    expect(screen.getByRole("heading", { level: 1, name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
    expect(screen.getByText("Email me a sign-in link")).toBeInTheDocument();
    expect(screen.queryByText(/preview|part 22/i)).not.toBeInTheDocument();
  });

  it("renders a generic OAuth callback failure without provider details", async () => {
    render(
      await LoginPage({
        searchParams: Promise.resolve({
          oauth: "error",
          error_description: "provider-secret-detail",
          redirect: "/settings/security",
        }),
      }),
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Social sign-in could not be completed");
    expect(screen.queryByText("provider-secret-detail")).not.toBeInTheDocument();
  });
});
