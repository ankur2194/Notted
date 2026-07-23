import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import DashboardPage from "@/app/(dashboard)/page";

describe("Dashboard page (Server Component)", () => {
  it("renders the welcome heading", async () => {
    const ui = await DashboardPage();
    render(ui);
    expect(
      screen.getByRole("heading", { level: 1, name: /welcome to notted/i }),
    ).toBeInTheDocument();
  });

  it("renders the Key Features section heading and feature cards", async () => {
    const ui = await DashboardPage();
    render(ui);
    expect(screen.getByRole("heading", { name: /key features/i })).toBeInTheDocument();
    expect(screen.getByText("Rich Text Editing")).toBeInTheDocument();
    expect(screen.getByText("Project Organization")).toBeInTheDocument();
    expect(screen.getByText("Team Collaboration")).toBeInTheDocument();
  });

  it("renders the interactive demo island trigger", async () => {
    const ui = await DashboardPage();
    render(ui);
    expect(screen.getByRole("button", { name: /open ui preview/i })).toBeInTheDocument();
  });

  it("does not advertise a deliberately unknown route", async () => {
    const ui = await DashboardPage();
    render(ui);
    expect(screen.queryByRole("link", { name: /unknown route/i })).not.toBeInTheDocument();
  });

  it("renders the skeleton placeholders section", async () => {
    const ui = await DashboardPage();
    const { container } = render(ui);
    const skeletons = container.querySelectorAll(".animate-pulse");
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it("links to the login page from the getting-started section", async () => {
    const ui = await DashboardPage();
    render(ui);
    const loginLink = screen.getByRole("link", { name: /go to login/i });
    expect(loginLink).toHaveAttribute("href", "/login");
  });
});
