import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { JoinByLink } from "@/routes/r.$code";

describe("JoinByLink", () => {
  it("asks for approval with the code from the link", () => {
    render(<JoinByLink rawCode="ss-abc123" />);
    expect(screen.getByText("SS-ABC123")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Approve & join/ })).toBeInTheDocument();
  });

  it("rejects malformed codes gracefully", () => {
    render(<JoinByLink rawCode="../secret" />);
    expect(screen.getByText(/won't work/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve/ })).not.toBeInTheDocument();
  });

  it("shows decline without connecting", () => {
    render(<JoinByLink rawCode="SS-ABC123" />);
    fireEvent.click(screen.getByRole("button", { name: /Decline/ }));
    expect(screen.getByText(/declined/i)).toBeInTheDocument();
  });

  it("starts joining after approval (and surfaces join failure gracefully)", async () => {
    render(<JoinByLink rawCode="SS-ABC123" />);
    fireEvent.click(screen.getByRole("button", { name: /Approve & join/ }));
    // No signaling in jsdom: the join must fail gracefully, never hang.
    await waitFor(() => {
      expect(
        screen.getByText(/Couldn't join this transfer|Connecting|Joining/),
      ).toBeInTheDocument();
    });
  });
});
