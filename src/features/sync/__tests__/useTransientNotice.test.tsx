import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTICE_LIFETIME_MS, useTransientNotice } from "../useTransientNotice";

/** Renders the word "notice" for as long as the hook says to. */
function Harness() {
  return useTransientNotice() ? <p>notice</p> : null;
}

function stubMatchMedia(matches: boolean | (() => never)) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => {
      if (typeof matches === "function") matches();
      return { matches, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    }),
  );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useTransientNotice", () => {
  it("stands the notice down on a small screen once its time is up", () => {
    stubMatchMedia(true);
    render(<Harness />);
    expect(screen.getByText("notice")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(NOTICE_LIFETIME_MS);
    });
    expect(screen.queryByText("notice")).not.toBeInTheDocument();
  });

  it("is still there a moment before", () => {
    // Otherwise a test that only advanced past the end would pass against a hook
    // that hid the notice immediately.
    stubMatchMedia(true);
    render(<Harness />);
    act(() => {
      vi.advanceTimersByTime(NOTICE_LIFETIME_MS - 1);
    });
    expect(screen.getByText("notice")).toBeInTheDocument();
  });

  it("keeps it on a large screen, where it costs nothing", () => {
    stubMatchMedia(false);
    render(<Harness />);
    act(() => {
      vi.advanceTimersByTime(NOTICE_LIFETIME_MS * 10);
    });
    expect(screen.getByText("notice")).toBeInTheDocument();
  });

  it("keeps it when matchMedia is missing", () => {
    // Some embedded webviews have none. An author who never learns their work is
    // device-only has more to lose than one who reads the sentence twice.
    vi.stubGlobal("matchMedia", undefined);
    render(<Harness />);
    act(() => {
      vi.advanceTimersByTime(NOTICE_LIFETIME_MS * 10);
    });
    expect(screen.getByText("notice")).toBeInTheDocument();
  });

  it("keeps it when matchMedia throws", () => {
    stubMatchMedia(() => {
      throw new Error("no media queries here");
    });
    render(<Harness />);
    act(() => {
      vi.advanceTimersByTime(NOTICE_LIFETIME_MS * 10);
    });
    expect(screen.getByText("notice")).toBeInTheDocument();
  });
});
