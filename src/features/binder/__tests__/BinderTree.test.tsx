import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { BinderNode } from "@/data/binder";
import { BinderTree } from "../BinderTree";

const node = (id: string, children: BinderNode[] = [], type: BinderNode["type"] = "folder"): BinderNode => ({
  id,
  parentId: null,
  type,
  title: id,
  orderKey: "V",
  trashedFromParentId: null,
  children,
});

const TREE = [
  node("Act I", [node("Scene 1", [], "document"), node("Scene 2", [], "document")]),
  node("Act II", [node("Scene 3", [], "document")]),
];

/** Drives the tree with real state, the way the page does. */
function Harness({
  nodes = TREE,
  initialExpanded = [],
  onSelect,
}: {
  nodes?: BinderNode[];
  initialExpanded?: string[];
  onSelect?: (id: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set(initialExpanded));
  return (
    <BinderTree
      label="Binder"
      nodes={nodes}
      selectedId={selectedId}
      onSelect={(id) => {
        setSelectedId(id);
        onSelect?.(id);
      }}
      expandedIds={expandedIds}
      onToggle={(id) =>
        setExpandedIds((current) => {
          const next = new Set(current);
          if (!next.delete(id)) next.add(id);
          return next;
        })
      }
      emptyMessage="This binder is empty."
    />
  );
}

const rows = () => screen.getAllByRole("treeitem").map((el) => el.textContent ?? "");

/** The treeitem containing this title. Typed via the generic so it is focusable. */
const rowFor = (title: string) =>
  screen.getByText(title).closest<HTMLElement>("[role=treeitem]")!;

describe("structure", () => {
  it("hides the children of a collapsed folder", () => {
    render(<Harness />);
    expect(rows()).toEqual(["Act I", "Act II"]);
  });

  it("shows the children of an expanded folder, in order", () => {
    render(<Harness initialExpanded={["Act I"]} />);
    expect(rows()).toEqual(["Act I", "Scene 1", "Scene 2", "Act II"]);
  });

  it("reports depth so a screen reader can announce it", () => {
    render(<Harness initialExpanded={["Act I"]} />);
    expect(screen.getByText("Act I").closest("[role=treeitem]")).toHaveAttribute("aria-level", "1");
    expect(screen.getByText("Scene 1").closest("[role=treeitem]")).toHaveAttribute("aria-level", "2");
  });

  it("marks aria-expanded only on rows that have children", () => {
    render(<Harness initialExpanded={["Act I"]} />);
    // A leaf carrying aria-expanded=false tells a screen reader there is something
    // to open when there is not.
    expect(screen.getByText("Act I").closest("[role=treeitem]")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Scene 1").closest("[role=treeitem]")).not.toHaveAttribute("aria-expanded");
  });

  it("says so when there is nothing in it", () => {
    render(<Harness nodes={[]} />);
    expect(screen.getByText("This binder is empty.")).toBeInTheDocument();
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
  });
});

describe("the tab stop", () => {
  it("keeps exactly one row tabbable so Tab leaves the whole binder", () => {
    render(<Harness initialExpanded={["Act I", "Act II"]} />);
    const tabbable = screen.getAllByRole("treeitem").filter((el) => el.getAttribute("tabindex") === "0");
    // Without a roving tabindex, tabbing through a novel means one press per chapter.
    expect(tabbable).toHaveLength(1);
  });

  it("moves the tab stop to the selected row", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByText("Act II"));
    expect(screen.getByText("Act II").closest("[role=treeitem]")).toHaveAttribute("tabindex", "0");
    expect(screen.getByText("Act I").closest("[role=treeitem]")).toHaveAttribute("tabindex", "-1");
  });
});

describe("keyboard navigation", () => {
  it("moves down and up the visible rows", async () => {
    render(<Harness initialExpanded={["Act I"]} />);
    const first = rowFor("Act I");
    first.focus();

    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByText("Scene 1").closest("[role=treeitem]")).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByText("Scene 2").closest("[role=treeitem]")).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    expect(screen.getByText("Scene 1").closest("[role=treeitem]")).toHaveFocus();
  });

  it("does not fall off either end", async () => {
    render(<Harness />);
    const first = rowFor("Act I");
    first.focus();
    await userEvent.keyboard("{ArrowUp}");
    expect(first).toHaveFocus();

    const last = rowFor("Act II");
    last.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(last).toHaveFocus();
  });

  it("expands with ArrowRight, then steps into the folder", async () => {
    render(<Harness />);
    const act = rowFor("Act I");
    act.focus();

    await userEvent.keyboard("{ArrowRight}");
    expect(act).toHaveAttribute("aria-expanded", "true");
    expect(act).toHaveFocus();

    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByText("Scene 1").closest("[role=treeitem]")).toHaveFocus();
  });

  it("collapses with ArrowLeft, and from a child steps out to the parent", async () => {
    render(<Harness initialExpanded={["Act I"]} />);
    const scene = rowFor("Scene 1");
    scene.focus();

    await userEvent.keyboard("{ArrowLeft}");
    const act = rowFor("Act I");
    expect(act).toHaveFocus();

    await userEvent.keyboard("{ArrowLeft}");
    expect(act).toHaveAttribute("aria-expanded", "false");
  });

  it("jumps to the first and last visible rows", async () => {
    render(<Harness initialExpanded={["Act I"]} />);
    const act = rowFor("Act I");
    act.focus();

    await userEvent.keyboard("{End}");
    expect(screen.getByText("Act II").closest("[role=treeitem]")).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(screen.getByText("Act I").closest("[role=treeitem]")).toHaveFocus();
  });

  it("leaves unhandled keys to the page", async () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const act = rowFor("Act I");
    act.focus();
    onSelect.mockClear();

    // Swallowing every key would break browser shortcuts and type-ahead.
    await userEvent.keyboard("x");
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("the disclosure triangle", () => {
  it("opens a folder without changing the selection", async () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const twisty = rowFor("Act I").querySelector(".binder__twisty")!;

    await userEvent.click(twisty);
    expect(rows()).toEqual(["Act I", "Scene 1", "Scene 2", "Act II"]);
    // Opening a folder to look inside is not the same as choosing it, and the
    // toolbar acts on the selection.
    expect(onSelect).not.toHaveBeenCalled();
  });
});
