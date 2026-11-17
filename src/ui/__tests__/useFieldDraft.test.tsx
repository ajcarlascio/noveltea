import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useFieldDraft } from "../useFieldDraft";

/** The field as a component holds it: the stored value arrives as a prop and can move. */
const field = (stored: string) => renderHook(({ value }) => useFieldDraft(value), { initialProps: { value: stored } });

describe("a field saved when the author leaves it", () => {
  it("follows the stored value while nobody is in it", () => {
    const { result, rerender } = field("Old");
    rerender({ value: "From the other device" });
    expect(result.current.draft).toBe("From the other device");
  });

  it("has nothing to save when it was only looked at", () => {
    const { result } = field("Old");
    act(() => result.current.enter());
    let typed: string | null = "unset";
    act(() => void (typed = result.current.leave()));
    expect(typed).toBeNull();
  });

  it("has nothing to save when the stored value moved under an untouched field", () => {
    // The case the old comparison got wrong: the draft still says "Old", the store now
    // says something else, and "they differ" was taken for an edit.
    const { result, rerender } = field("Old");
    act(() => result.current.enter());
    rerender({ value: "From the other device" });
    expect(result.current.draft).toBe("Old");

    let typed: string | null = "unset";
    act(() => void (typed = result.current.leave()));
    expect(typed).toBeNull();
    rerender({ value: "From the other device" });
    expect(result.current.draft).toBe("From the other device");
  });

  it("keeps what is being typed when the stored value moves, and hands it over on leaving", () => {
    const { result, rerender } = field("Old");
    act(() => result.current.enter());
    act(() => result.current.setDraft("Mine"));
    rerender({ value: "From the other device" });
    expect(result.current.draft).toBe("Mine");

    let typed: string | null = null;
    act(() => void (typed = result.current.leave()));
    expect(typed).toBe("Mine");
  });

  it("measures the next visit from what was there when it began", () => {
    const { result, rerender } = field("Old");
    act(() => result.current.enter());
    act(() => void result.current.leave());
    rerender({ value: "Newer" });
    act(() => result.current.enter());
    act(() => result.current.setDraft("Newer still"));
    let typed: string | null = null;
    act(() => void (typed = result.current.leave()));
    expect(typed).toBe("Newer still");
  });
});
