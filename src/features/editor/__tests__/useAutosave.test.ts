import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutosave, type SaveState } from "../useAutosave";

/**
 * Autosave is where a writing app loses work, and it loses it silently: nothing
 * fails, the author just finds the last few minutes missing. Every test here is a
 * way that happens.
 */
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(save = vi.fn<(payload: unknown) => Promise<void>>().mockResolvedValue(undefined)) {
  const states: SaveState[] = [];
  const view = renderHook(() =>
    useAutosave(save, (state) => states.push(state), 700),
  );
  return { save, states, ...view };
}

describe("debouncing", () => {
  it("writes once for a burst of typing", async () => {
    const { result, save } = setup();

    for (const text of ["a", "ab", "abc", "abcd"]) {
      act(() => result.current.schedule(text));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });

    // Saving every keystroke would rewrite the whole body hundreds of times a minute.
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("abcd");
  });

  it("writes after the author pauses", async () => {
    const { result, save } = setup();
    act(() => result.current.schedule("one"));
    expect(save).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(save).toHaveBeenCalledWith("one");
  });
});

describe("flushing", () => {
  it("writes immediately instead of waiting out the timer", async () => {
    const { result, save } = setup();
    act(() => result.current.schedule("urgent"));

    await act(async () => {
      await result.current.flush();
    });

    // This is what runs when the editor moves to another document. Waiting for the
    // debounce there loses whatever was typed in the last second.
    expect(save).toHaveBeenCalledWith("urgent");
  });

  it("does nothing when there is nothing outstanding", async () => {
    const { result, save } = setup();
    await act(async () => {
      await result.current.flush();
    });
    expect(save).not.toHaveBeenCalled();
  });

  it("writes on unmount", async () => {
    const { result, save, unmount } = setup();
    act(() => result.current.schedule("last words"));

    unmount();
    await act(async () => {
      await Promise.resolve();
    });

    // Navigating away is the commonest way to lose the final edit.
    expect(save).toHaveBeenCalledWith("last words");
  });
});

describe("when a save fails", () => {
  it("keeps the payload so the next write still carries it", async () => {
    const save = vi
      .fn<(payload: unknown) => Promise<void>>()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue(undefined);
    const { result, states } = setup(save);

    act(() => result.current.schedule("precious"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(states).toContain("error");

    // Discarding a failed write would throw the words away at exactly the moment
    // the author most needs them kept.
    await act(async () => {
      await result.current.flush();
    });
    expect(save).toHaveBeenNthCalledWith(2, "precious");
  });

  it("reports the reason rather than a generic failure", async () => {
    const messages: (string | undefined)[] = [];
    const save = vi
      .fn<(payload: unknown) => Promise<void>>()
      .mockRejectedValue(new Error("UNIQUE constraint failed"));
    const { result } = renderHook(() =>
      useAutosave(save, (_state, message) => messages.push(message), 700),
    );

    act(() => result.current.schedule("x"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });

    expect(messages).toContain("UNIQUE constraint failed");
  });
});

describe("state reporting", () => {
  it("goes pending, then saving, then clean", async () => {
    const { result, states } = setup();
    act(() => result.current.schedule("x"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(states).toEqual(["pending", "saving", "clean"]);
  });

  it("stays pending when a change arrives while a save is in flight", async () => {
    let release: (() => void) | undefined;
    const save = vi.fn<(payload: unknown) => Promise<void>>().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { result, states } = setup(save);

    act(() => result.current.schedule("first"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });

    act(() => result.current.schedule("second"));
    await act(async () => {
      release?.();
      await Promise.resolve();
    });

    // Reporting "Saved" here would be a lie: "second" is not written yet.
    expect(states.at(-1)).toBe("pending");
  });
});
