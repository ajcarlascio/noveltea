/**
 * Inline SVG rather than emoji.
 *
 * Emoji are painted from whatever font the platform happens to ship: they look
 * different on every OS, they are sized inconsistently against text, and where the
 * font is missing they render as an empty box — which is what a headless Linux
 * container and a stripped-down Android webview both do. These follow
 * `currentColor`, so they also follow the theme.
 */

const base = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  focusable: false,
};

export function FolderIcon() {
  return (
    <svg {...base}>
      <path d="M1.75 4.25c0-.55.45-1 1-1h3.1c.32 0 .62.15.81.4l.78 1.05h5.81c.55 0 1 .45 1 1v6.05c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1z" />
    </svg>
  );
}

export function DocumentIcon() {
  return (
    <svg {...base}>
      <path d="M4 1.75h5l3 3v9.5c0 .14-.11.25-.25.25h-7.5a.25.25 0 0 1-.25-.25V2c0-.14.11-.25.25-.25z" />
      <path d="M9 1.75v3h3" />
    </svg>
  );
}

export function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg {...base} style={{ transform: open ? "rotate(90deg)" : undefined }}>
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}
