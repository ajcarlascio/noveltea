import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ToolbarButton } from "@/ui/ToolbarButton";

describe("ToolbarButton", () => {
  it("speaks the full label whatever the viewport is doing", () => {
    render(<ToolbarButton label="Move to trash" short="Trash" onClick={() => {}} />);
    expect(screen.getByRole("button", { name: "Move to trash" })).toBeInTheDocument();
  });

  it("shows the short label in the narrow-screen slot", () => {
    render(<ToolbarButton label="Move to trash" short="Trash" onClick={() => {}} />);
    expect(screen.getByText("Trash")).toBeInTheDocument();
  });

  it("falls back to the full label when no short one is given", () => {
    render(<ToolbarButton label="Rename" onClick={() => {}} />);
    expect(screen.getAllByText("Rename")).toHaveLength(2);
  });

  it("renders the icon as decoration, never as the accessible name", () => {
    render(
      <ToolbarButton
        label="New folder"
        short="Folder"
        icon={<svg data-testid="folder-icon" aria-hidden="true" />}
        onClick={() => {}}
      />,
    );
    const icon = screen.getByTestId("folder-icon");
    expect(icon.closest(".button__icon")).toHaveAttribute("aria-hidden", "true");
    // The button's name still comes from aria-label alone.
    expect(screen.getByRole("button", { name: "New folder" })).toBeInTheDocument();
  });

  it("marks itself icon-capable so CSS can swap the label out on phones", () => {
    render(
      <ToolbarButton label="Rename" icon={<svg aria-hidden="true" />} onClick={() => {}} />,
    );
    expect(screen.getByRole("button", { name: "Rename" })).toHaveClass("button--icon");
  });

  it("leaves plain buttons without the icon class", () => {
    render(<ToolbarButton label="Rename" onClick={() => {}} />);
    expect(screen.getByRole("button", { name: "Rename" })).not.toHaveClass("button--icon");
  });

  it("keeps the danger variant alongside the icon class", () => {
    render(
      <ToolbarButton
        label="Move to trash"
        variant="danger"
        icon={<svg aria-hidden="true" />}
        onClick={() => {}}
      />,
    );
    const button = screen.getByRole("button", { name: "Move to trash" });
    expect(button).toHaveClass("button--danger");
    expect(button).toHaveClass("button--icon");
  });

  it("fires the click", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<ToolbarButton label="New folder" onClick={onClick} />);
    await user.click(screen.getByRole("button", { name: "New folder" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not fire when disabled", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<ToolbarButton label="Rename" disabled onClick={onClick} />);
    await user.click(screen.getByRole("button", { name: "Rename" }));
    expect(onClick).not.toHaveBeenCalled();
  });
});
