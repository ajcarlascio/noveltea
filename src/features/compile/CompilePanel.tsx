import type { CompilePlan } from "@noveltea/compile";
import { useEffect, useState } from "react";
import { useDatabase } from "@/app/db/DatabaseContext";
import { planProject } from "@/data/preflight";
import { PreflightNotice } from "./PreflightNotice";
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
 * What each format does about page layout.
 *
 * Standard manuscript format — US Letter, one-inch margins, 12pt, double-spaced,
 * ragged right, half-inch first-line indent, a running head — is what a fiction
 * submission is expected to look like, and it is what the HTML export already
 * produces. Saying so is worth a line: an author who does not know their export
 * is already in the shape an agent asks for will go and reformat it by hand.
 *
 * The other two say the opposite just as plainly, because they have to. Plain
 * text and Markdown have no page to lay out, and claiming a manuscript format
 * for them would be the one thing this interface does not do — sound certain
 * about something that is not true. A format with nothing to promise says
 * nothing rather than being given a reassuring sentence.
 */
const FORMAT_NOTES: Record<string, string> = {
  html:
    "Standard manuscript format: 12pt, double-spaced, one-inch margins, with your " +
    "project title and a page number in the footer — what agents and publishers ask " +
    "for. Print it, or save it as PDF, to submit.",
  txt: "Plain text carries no page layout. Choose HTML if you need manuscript formatting.",
  md: "Markdown carries no page layout. Choose HTML if you need manuscript formatting.",
};

const DESTINATION_LABELS: Record<string, string> = {
  download: "Download to this device",
  server: "Keep on the server",
  cloud: "Cloud storage",
};

const destinationLabel = (value: string) => DESTINATION_LABELS[value] ?? value;

/**
 * Turning the binder into a manuscript.
 *
 * The only part of the app that needs a server: the export pipeline runs there, not
 * on the device. Everything else keeps working without one, so this says what it
 * needs rather than appearing broken.
 */
export function CompilePanel({ projectId }: { projectId: string }) {
  const { db } = useDatabase();
  const { formats, job, error, busy, possible, compile, download } = useCompile(projectId);
  const [format, setFormat] = useState("md");
  const [destination, setDestination] = useState("download");
  const [plan, setPlan] = useState<CompilePlan | null>(null);

  // The plan is worked out from the local replica, so it costs nothing and is right
  // before anything is sent. It follows the binder: an author who trashes a chapter
  // and looks back here should not be reading a stale count.
  useEffect(() => {
    let current = true;
    const refresh = () => {
      void planProject(db, projectId).then(
        (next) => {
          if (current) setPlan(next);
        },
        () => {
          if (current) setPlan(null);
        },
      );
    };
    refresh();
    const stop = db.subscribeToChanges(refresh);
    return () => {
      current = false;
      stop();
    };
  }, [db, projectId]);

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
  const destinations = formats?.destinations ?? ["download"];
  const unavailableDestinations = formats?.unavailableDestinations ?? [];

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
          {FORMAT_NOTES[format] !== undefined && (
            <p className="compile__note">{FORMAT_NOTES[format]}</p>
          )}
        </label>

        <label className="compile__field">
          <span className="compile__label">Put it</span>
          <select value={destination} onChange={(event) => setDestination(event.target.value)}>
            {destinations.map((value) => (
              <option key={value} value={value}>
                {destinationLabel(value)}
              </option>
            ))}
            {/* Same rule as the formats above. A destination this edition does not
                offer is an upgrade, and omitting it would claim the software cannot
                do something it can. */}
            {unavailableDestinations.map((value) => (
              <option key={value} value={value} disabled>
                {destinationLabel(value)} — not in this edition
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className="button button--confirm"
          disabled={busy || supported.length === 0 || plan?.included.length === 0}
          onClick={() => compile(format, destination)}
        >
          {busy ? "Compiling…" : "Compile"}
        </button>
      </div>

      <PreflightNotice plan={plan} />

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
