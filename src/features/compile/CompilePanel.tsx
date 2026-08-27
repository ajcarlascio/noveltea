import type { CompilePlan } from "@noveltea/compile";
import { useEffect, useId, useState } from "react";
import { useDatabase } from "@/app/db/DatabaseContext";
import type { BinderNode } from "@/data/binder";
import {
  createCompilePreset,
  deleteCompilePreset,
  updateCompilePreset,
  type CompilePreset,
} from "@/data/compile-presets";
import { planProject } from "@/data/preflight";
import type { DatabaseClient } from "@/db/client";
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

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, index) => id === b[index]);

/**
 * Turning the binder into a manuscript.
 *
 * The export pipeline runs on the server, not on the device, so compiling is the one
 * thing here that genuinely needs one. Presets are not: they are local rows that sync
 * like everything else, so an author can set up a submission format on a train and
 * find it waiting on the other machine.
 *
 * What a preset holds is the format and the selection, because that is what the compile
 * worker reads — it loads `included_binder_items` from the preset and nothing else. The
 * destination is deliberately not part of it: `compile_preset` has no column for one,
 * and where a finished file goes is a decision about this export rather than about what
 * the manuscript is.
 */
export function CompilePanel({
  projectId,
  presets,
  items,
  run,
}: {
  projectId: string;
  presets: readonly CompilePreset[];
  /** The live binder, flattened — what a preset can choose from. */
  items: readonly BinderNode[];
  run: (action: (db: DatabaseClient) => Promise<unknown>) => Promise<void>;
}) {
  const { db } = useDatabase();
  const { formats, job, error, busy, possible, compile, download } = useCompile(projectId);
  const [presetId, setPresetId] = useState<string | null>(null);
  const [format, setFormat] = useState("md");
  const [destination, setDestination] = useState("download");
  const [included, setIncluded] = useState<readonly string[]>([]);
  const [name, setName] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [plan, setPlan] = useState<CompilePlan | null>(null);
  const presetField = useId();

  // The same panel serves every project. Without this, opening a second one leaves the
  // first project's preset chosen and its item ids in the selection — ids that name
  // nothing here, so the export would quietly be of nothing at all.
  useEffect(() => {
    setPresetId(null);
    setFormat("md");
    setIncluded([]);
    setName("");
  }, [projectId]);

  // Falls back to no preset when the chosen one is gone — deleted here, or deleted on
  // another device and arrived in a pull. The working format and selection are left
  // alone: they are what the author is looking at, and clearing them would undo a
  // selection because something unrelated was deleted elsewhere.
  const chosen = presets.find((preset) => preset.id === presetId) ?? null;
  const edited =
    chosen !== null && (chosen.format !== format || !sameIds(chosen.includedIds, included));

  // The plan is worked out from the local replica, so it costs nothing and is right
  // before anything is sent. It follows the binder: an author who trashes a chapter
  // and looks back here should not be reading a stale count. It also follows the
  // selection, or the panel would promise a whole book while exporting three chapters.
  const selectionKey = included.join(",");
  useEffect(() => {
    let current = true;
    const refresh = () => {
      void planProject(db, projectId, selectionKey === "" ? [] : selectionKey.split(",")).then(
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
  }, [db, projectId, selectionKey]);

  const choose = (id: string) => {
    setConfirming(false);
    const preset = presets.find((candidate) => candidate.id === id) ?? null;
    setPresetId(preset?.id ?? null);
    if (preset !== null) {
      setFormat(preset.format);
      setIncluded(preset.includedIds);
    } else {
      setIncluded([]);
    }
  };

  const toggle = (id: string) => {
    const next = new Set(included);
    if (!next.delete(id)) next.add(id);
    // Rebuilt in binder order rather than tap order, so the stored selection reads the
    // way the manuscript does.
    setIncluded(items.filter((item) => next.has(item.id)).map((item) => item.id));
  };

  const supported = formats?.supported ?? [];
  const unavailable = formats?.unavailable ?? [];
  const destinations = formats?.destinations ?? ["download"];
  const unavailableDestinations = formats?.unavailableDestinations ?? [];

  return (
    <section className="compile" aria-label="Compile">
      <h2 className="compile__heading">Compile</h2>

      <div className="compile__controls">
        {/* `htmlFor` rather than a wrapping label, unlike its siblings below: a label
            wrapped around a select takes every option's text into the accessible name,
            so this one would announce itself as "Preset The whole manuscript Agent
            submission" and be indistinguishable from the preset controls underneath. */}
        <div className="compile__field">
          <span className="compile__label">
            <label htmlFor={presetField}>Preset</label>
          </span>
          <select
            id={presetField}
            value={presetId ?? ""}
            onChange={(event) => choose(event.target.value)}
          >
            <option value="">The whole manuscript</option>
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </select>
        </div>

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
            {/* A preset can name a format this build cannot produce — it was made
                against an edition that could, or on another machine. Offered as the
                current value so the select shows the truth, and disabled so choosing
                it again is not the thing that fails. */}
            {!supported.includes(format) && !unavailable.includes(format) && (
              <option value={format} disabled>
                {label(format)}
              </option>
            )}
          </select>
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
          disabled={!possible || busy || supported.length === 0 || plan?.included.length === 0}
          onClick={() => compile(format, destination, presetId)}
        >
          {busy ? "Compiling…" : "Compile"}
        </button>
      </div>

      {/* Under the row rather than inside the Format field. The fields align on their
          bottoms so the three selects sit on one line; a note living inside one of them
          is part of its height, and lifted that select above its neighbours. */}
      {FORMAT_NOTES[format] !== undefined && (
        <p className="compile__note">{FORMAT_NOTES[format]}</p>
      )}

      <PresetControls
        projectId={projectId}
        items={items}
        included={included}
        chosen={chosen}
        edited={edited}
        format={format}
        name={name}
        confirming={confirming}
        onName={setName}
        onToggle={toggle}
        onConfirming={setConfirming}
        onSaved={(id) => {
          setName("");
          setPresetId(id);
        }}
        onDeleted={() => {
          setPresetId(null);
          setIncluded([]);
        }}
        run={run}
      />

      <PreflightNotice plan={plan} />

      {!possible && (
        <p className="compile__muted">
          Compiling happens on your server. Sign in to export this project — your writing,
          and the presets above, stay here either way.
        </p>
      )}

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

/**
 * Saving what is on screen, and choosing what goes into it.
 *
 * The selection lives behind a disclosure. It is a line per binder item, which for a
 * novel is the tallest thing in this panel, and an author sets it up once and exports
 * from it for months — the same reason the whole compile panel is folded away.
 */
function PresetControls({
  projectId,
  items,
  included,
  chosen,
  edited,
  format,
  name,
  confirming,
  onName,
  onToggle,
  onConfirming,
  onSaved,
  onDeleted,
  run,
}: {
  projectId: string;
  items: readonly BinderNode[];
  included: readonly string[];
  chosen: CompilePreset | null;
  edited: boolean;
  format: string;
  name: string;
  confirming: boolean;
  onName: (value: string) => void;
  onToggle: (id: string) => void;
  onConfirming: (value: boolean) => void;
  onSaved: (id: string) => void;
  onDeleted: () => void;
  run: (action: (db: DatabaseClient) => Promise<unknown>) => Promise<void>;
}) {
  const chosenIds = new Set(included);
  const nameField = useId();

  return (
    <div className="compile__presets">
      <details className="compile__selection">
        <summary>
          {included.length === 0
            ? "Including the whole manuscript"
            : `Including ${String(included.length)} of ${String(items.length)} items`}
        </summary>
        {items.length === 0 ? (
          <p className="compile__note">Nothing in the binder to choose from yet.</p>
        ) : (
          <ul className="compile__items">
            {items.map((item) => (
              <li key={item.id}>
                <label className="compile__item">
                  <input
                    type="checkbox"
                    checked={chosenIds.has(item.id)}
                    onChange={() => onToggle(item.id)}
                  />
                  <span>{item.title}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <p className="compile__note">
          Tick nothing to export the whole manuscript. Folders hold no text of their own,
          but ticking one includes its title as a heading.
        </p>
      </details>

      <div className="compile__preset-actions">
        {chosen === null ? (
          <>
            <div className="compile__field compile__field--name">
              <span className="compile__label">
                <label htmlFor={nameField}>Name this preset</label>
              </span>
              <input
                id={nameField}
                value={name}
                placeholder="Agent submission"
                onChange={(event) => onName(event.target.value)}
              />
            </div>
            <button
              type="button"
              className="button"
              disabled={name.trim() === ""}
              onClick={() =>
                void run(async (db) => {
                  const row = await createCompilePreset(
                    db,
                    projectId,
                    name,
                    format,
                    [...included],
                  );
                  onSaved(row.id);
                })
              }
            >
              Save preset
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="button"
              disabled={!edited}
              onClick={() =>
                void run((db) =>
                  updateCompilePreset(db, projectId, chosen.id, {
                    format,
                    includedIds: [...included],
                  }),
                )
              }
            >
              {edited ? `Save changes to ${chosen.name}` : `${chosen.name} is up to date`}
            </button>

            {confirming ? (
              <>
                <button
                  type="button"
                  className="button button--danger"
                  onClick={() => {
                    onConfirming(false);
                    void run((db) => deleteCompilePreset(db, projectId, chosen.id)).then(
                      onDeleted,
                    );
                  }}
                >
                  {`Delete ${chosen.name}`}
                </button>
                <button type="button" className="button" onClick={() => onConfirming(false)}>
                  Keep
                </button>
              </>
            ) : (
              <button
                type="button"
                className="button"
                aria-label={`Delete ${chosen.name}`}
                onClick={() => onConfirming(true)}
              >
                Delete
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
