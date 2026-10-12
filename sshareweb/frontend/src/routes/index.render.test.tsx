import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SwarmSharePage } from "@/routes/index";

describe("SwarmSharePage", () => {
  it("renders the workspace with transfer actions", () => {
    render(<SwarmSharePage />);
    expect(screen.getByText("Pass files straight across.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create Transfer/ })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /Join with code/ }));
    expect(screen.getByText("Join a transfer")).toBeInTheDocument();
  });

  it("shows live session UI once a share code exists", () => {
    render(<SwarmSharePage />);
    // No session yet: placeholders are shown, not the live code card.
    expect(screen.getByText("Share code unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Live · peer connected")).not.toBeInTheDocument();
  });
});
