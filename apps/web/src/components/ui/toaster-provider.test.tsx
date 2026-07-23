import { act, render, screen } from "@testing-library/react";
import { toast } from "sonner";
import { describe, expect, it } from "vitest";

import { ToasterProvider } from "@/components/ui/toaster-provider";

describe("ToasterProvider", () => {
  it("renders notification text in Sonner's polite live region", async () => {
    render(<ToasterProvider />);

    act(() => {
      toast("Preview notification");
    });

    expect(await screen.findByText("Preview notification")).toBeInTheDocument();
    expect(screen.getByText("Preview notification").closest("[aria-live]")).toHaveAttribute(
      "aria-live",
      "polite",
    );
  });
});
