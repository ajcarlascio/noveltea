import type { Platform } from "@/features/auth/api";

/**
 * Which shell the app is running in.
 *
 * Used for the device name the server records, so an author can tell their laptop
 * from their phone in a device list — not for deciding what the interface does.
 * Layout follows the viewport and the pointer; behaviour follows capability
 * detection. A shell check standing in for either is how an app ends up wrong on the
 * device nobody tested.
 */
export function currentPlatform(): Platform {
  if (typeof window === "undefined") return "web";
  // Tauri v2 exposes this on the window it creates.
  if ("__TAURI_INTERNALS__" in window || "__TAURI__" in window) return "tauri";
  return "web";
}

/** A name the author will recognise in a list of their own devices. */
export function suggestDeviceName(): string {
  if (typeof navigator === "undefined") return "This device";
  const agent = navigator.userAgent;
  const os = /Android/i.test(agent)
    ? "Android"
    : /iPhone|iPad|iPod/i.test(agent)
      ? "iOS"
      : /Macintosh|Mac OS/i.test(agent)
        ? "Mac"
        : /Windows/i.test(agent)
          ? "Windows"
          : /Linux/i.test(agent)
            ? "Linux"
            : "Device";
  return currentPlatform() === "tauri" ? `${os} desktop` : `${os} browser`;
}
