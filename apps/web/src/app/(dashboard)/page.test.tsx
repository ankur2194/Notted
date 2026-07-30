import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import DashboardPage from "@/app/(dashboard)/page";

describe("dashboard home", () => {
  it("renders one honest heading hierarchy without the obsolete demo", () => {
    render(<DashboardPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Welcome back" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: "Workspace content" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/note tree and note APIs arrive/i)).toBeInTheDocument();
    expect(screen.queryByText(/interactive demo/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /open ui preview/i })).not.toBeInTheDocument();
  });
});
