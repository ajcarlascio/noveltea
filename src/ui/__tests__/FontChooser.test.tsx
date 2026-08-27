import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { FontChooser } from "@/ui/FontChooser";
import {
  CUSTOM_FONTS_STORAGE_KEY,
  type ByteStore,
  type CustomFontAdapters,
} from "@/app/typography/customFonts";
import { FONT_STORAGE_KEY } from "@/app/typography/fonts";

function memoryByteStore(): ByteStore & { files: Map<string, ArrayBuffer> } {
  const files = new Map<string, ArrayBuffer>();
  return {
    kind: "opfs",
    files,
    write(id, bytes) {
      files.set(id, bytes);
      return Promise.resolve();
    },
    read(id) {
      return Promise.resolve(files.get(id) ?? null);
    },
    remove(id) {
      files.delete(id);
      return Promise.resolve();
    },
  };
}

function testAdapters(): CustomFontAdapters & { addedFaces: unknown[] } {
  const addedFaces: unknown[] = [];
  return {
    storage: window.localStorage,
    byteStore: () => Promise.resolve(memoryByteStore()),
    fontFace: { create: () => ({ load: () => Promise.resolve(undefined) }) },
    addFace: (face) => void addedFaces.push(face),
    now: () => 1_700_000_000_000,
    addedFaces,
  };
}

const WOFF2 = new File([new Uint8Array([1, 2, 3, 4])], "Crimson-Pro.woff2", {
  type: "font/woff2",
});

beforeEach(() => {
  document.documentElement.removeAttribute("data-font");
  document.documentElement.style.removeProperty("--font-prose");
  window.localStorage.clear();
});

describe("FontChooser custom fonts", () => {
  it("shows the bundled faces and the import control", () => {
    render(<FontChooser adapters={testAdapters()} />);
    expect(screen.getByRole("radio", { name: /EB Garamond/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import font…" })).toBeInTheDocument();
  });

  it("imports a font file, lists it and selects it", async () => {
    const user = userEvent.setup();
    const adapters = testAdapters();
    render(<FontChooser adapters={adapters} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, WOFF2);

    await waitFor(() => {
      expect(screen.getByRole("radio", { name: /Crimson Pro/ })).toBeChecked();
    });
    // The selection is stamped on <html> as the custom marker with an inline stack.
    expect(document.documentElement.getAttribute("data-font")).toBe("custom");
    expect(document.documentElement.style.getPropertyValue("--font-prose")).toContain(
      '"Crimson Pro"',
    );
    expect(window.localStorage.getItem(FONT_STORAGE_KEY)).toMatch(/^custom:/);
    expect(window.localStorage.getItem(CUSTOM_FONTS_STORAGE_KEY)).toContain("Crimson Pro");
  });

  it("refuses a file that is not a font and says why", async () => {
    render(<FontChooser adapters={testAdapters()} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    // fireEvent, not user.upload: user-event applies the input's `accept` filter
    // itself and drops the file before the app ever sees it. That filter is the
    // browser's courtesy, not a guarantee — a drag, a paste, or a platform that
    // ignores `accept` all deliver whatever was chosen — so the refusal has to be
    // exercised with the filter out of the way.
    fireEvent.change(input, {
      target: { files: [new File(["hello"], "manuscript.txt", { type: "text/plain" })] },
    });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/not a font file/);
    });
    expect(window.localStorage.getItem(CUSTOM_FONTS_STORAGE_KEY)).toBeNull();
  });

  it("refuses a font-shaped file that is empty", async () => {
    // Reaches the same refusal through the path `accept` does not filter, so the
    // guard is covered even where the browser cooperated.
    const user = userEvent.setup();
    render(<FontChooser adapters={testAdapters()} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File([], "Empty.woff2", { type: "font/woff2" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/is empty/);
    });
    expect(window.localStorage.getItem(CUSTOM_FONTS_STORAGE_KEY)).toBeNull();
  });

  it("removes an imported font and reverts the selection", async () => {
    const user = userEvent.setup();
    const adapters = testAdapters();
    render(<FontChooser adapters={adapters} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, WOFF2);
    await waitFor(() => {
      expect(screen.getByRole("radio", { name: /Crimson Pro/ })).toBeChecked();
    });

    await user.click(screen.getByRole("button", { name: "Remove Crimson Pro" }));

    await waitFor(() => {
      expect(screen.queryByRole("radio", { name: /Crimson Pro/ })).not.toBeInTheDocument();
    });
    // The selection reverted to the default, which stamps nothing.
    expect(document.documentElement.hasAttribute("data-font")).toBe(false);
    expect(document.documentElement.style.getPropertyValue("--font-prose")).toBe("");
    expect(window.localStorage.getItem(FONT_STORAGE_KEY)).toBeNull();
  });

  it("switching back to a bundled face clears the inline custom stack", async () => {
    const user = userEvent.setup();
    const adapters = testAdapters();
    render(<FontChooser adapters={adapters} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, WOFF2);
    await waitFor(() => {
      expect(screen.getByRole("radio", { name: /Crimson Pro/ })).toBeChecked();
    });

    await user.click(screen.getByRole("radio", { name: /Georgia/ }));

    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-font")).toBe("georgia");
    });
    expect(document.documentElement.style.getPropertyValue("--font-prose")).toBe("");
  });

  it("shows a stored custom font on mount", () => {
    window.localStorage.setItem(
      CUSTOM_FONTS_STORAGE_KEY,
      JSON.stringify([{ id: "f1", family: "Crimson Pro", fileName: "crimson.woff2", addedAt: 1 }]),
    );
    window.localStorage.setItem(FONT_STORAGE_KEY, "custom:f1");
    render(<FontChooser adapters={testAdapters()} />);
    expect(screen.getByRole("radio", { name: /Crimson Pro/ })).toBeChecked();
  });

  it("tells the author imported fonts never leave the device", () => {
    render(<FontChooser adapters={testAdapters()} />);
    expect(screen.getByText(/stay on this device only/)).toBeInTheDocument();
  });
});
