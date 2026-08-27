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

/* Toolbar icons. Same rules as the tree icons above: inline SVG, currentColor,
   aria-hidden at the point of use. They only replace words on a narrow screen;
   the button's aria-label still carries the full name. */

export function PanelIcon() {
  return (
    <svg {...base}>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1" />
      <path d="M6 2.75v10.5" />
    </svg>
  );
}

export function FolderPlusIcon() {
  return (
    <svg {...base}>
      <path d="M1.75 4.25c0-.55.45-1 1-1h3.1c.32 0 .62.15.81.4l.78 1.05h5.81c.55 0 1 .45 1 1v6.05c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1z" />
      <path d="M8 7v4M6 9h4" />
    </svg>
  );
}

export function DocumentPlusIcon() {
  return (
    <svg {...base}>
      <path d="M4 1.75h5l3 3v9.5c0 .14-.11.25-.25.25h-7.5a.25.25 0 0 1-.25-.25V2c0-.14.11-.25.25-.25z" />
      <path d="M9 1.75v3h3" />
      <path d="M8 7.5v4M6 9.5h4" />
    </svg>
  );
}

export function PencilIcon() {
  return (
    <svg {...base}>
      <path d="m9.9 2.6 3.5 3.5-7.9 7.9-4.3.8.8-4.3z" />
      <path d="m8.5 4 3.5 3.5" />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg {...base}>
      <path d="M2.5 4h11" />
      <path d="M5.5 4V2.75c0-.41.34-.75.75-.75h3.5c.41 0 .75.34.75.75V4" />
      <path d="M4 4l.7 9.1c.04.5.45.9.95.9h4.7c.5 0 .91-.4.95-.9L12 4" />
      <path d="M6.5 6.5v4.5M9.5 6.5v4.5" />
    </svg>
  );
}

export function ArrowToTopIcon() {
  return (
    <svg {...base}>
      <path d="M8 13V4" />
      <path d="M4.5 7.5 8 4l3.5 3.5" />
      <path d="M3.5 2.5h9" />
    </svg>
  );
}

export function ImportIcon() {
  return (
    <svg {...base}>
      {/* An arrow coming down into an open tray: bringing something in, which is the
          opposite of the compile panel's outward arrow. */}
      <path d="M8 2v7" />
      <path d="M4.5 5.5 8 9l3.5-3.5" />
      <path d="M2.5 10.5v2c0 .55.45 1 1 1h9c.55 0 1-.45 1-1v-2" />
    </svg>
  );
}
