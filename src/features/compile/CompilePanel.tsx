import { useState } from "react";
import { useCompile } from "./useCompile";
import "./CompilePanel.css";

const FORMAT_LABELS: Record<string, string> = {
  txt: "Plain text",
  md: "Markdown",
  html: "HTML",
  rtf: "Rich text (RTF)",
  docx: "Word (DOCX)",
  odt: "OpenDocument",
  epub: "EPUB",
  pdf: "PDF",
};

const label = (format: string) => FORMAT_LABELS[format] ?? format.toUpperCase();

/**
 * Turning the binder into a manuscript.
 *
 * The only part of the app that needs a server: the export pipeline runs there, not
 * on the device. Everything else keeps working without one, so this says what it
 * needs rather than appearing broken.
 */
export function CompilePanel({ projectId }: { projectId: string }) {
  const { formats, job, error, busy, possible, compile, download } = useCompile(projectId);
  const [format, setFormat] = useState("md");

  if (!possible) {
    return (
      <p className="compile compile--muted">
        Compiling happens on your server. Sign in to export this project — your writing
        stays here either way.
      </p>
    );
  }

  const supported = formats?.supported ?? [];
  const unavailable = formats?.unavailable ?? [];

  return (
    <section className="compile" aria-label="Compile">
      <h2 className="compile__heading">Compile</h2>

      <div className="compile__controls">
        <label className="compile__field">
          <span className="compile__label">Format</span>
          <select value={format} onChange={(event) => setFormat(event.target.value)}>
            {supported.map((value) => (
              <option key={value} value={value}>
                {label(value)}
              </option>
            ))}
            {/* Listed and disabled, not hidden. A format this edition does not ship is
                an upgrade, and an interface that omitted it would be claiming the
                software cannot do something it can. */}
            {unavailable.map((value) => (
              <option key={value} value={value} disabled>
                {label(value)} — not in this edition
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className="button button--confirm"
          disabled={busy || supported.length === 0}
          onClick={() => compile(format, "download")}
        >
          {busy ? "Compiling…" : "Compile"}
        </button>
      </div>

      {job !== null && job.status !== "failed" && (
        <p className="compile__status" role="status">
          {job.status === "done"
            ? `Ready${job.wordCount === null ? "" : ` — ${String(job.wordCount)} words`}.`
            : "Working. You can keep writing; this runs on the server."}
          {job.status === "done" && (
            <button type="button" className="button compile__download" onClick={download}>
              Download {job.outputFilename ?? label(job.format)}
            </button>
          )}
        </p>
      )}

      {error !== null && (
        <p className="compile__error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
