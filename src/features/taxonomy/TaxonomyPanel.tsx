import { useState } from "react";
import {
  createTerm,
  deleteTerm,
  updateTerm,
  type Taxonomy,
  type TaxonomyKind,
  type TaxonomyTerm,
} from "@/data/taxonomy";
import type { DatabaseClient } from "@/db/client";
import "./taxonomy.css";

/**
 * The project's labels and statuses, and the only place they are made and unmade.
 *
 * A label is a colour and a word ("Bob's POV"); a status is a word ("First draft").
 * Both belong to the project, not to the device and not to the account, because they
 * are part of how this particular book is organised.
 *
 * Deleting one takes it off every item wearing it — that is what the command does,
 * and it is why the button asks twice. Nothing else in the binder loses work on a
 * single mis-tap, and a label spread over forty scenes is an afternoon to put back.
 */
export function TaxonomyPanel({
  projectId,
  taxonomy,
  run,
}: {
  projectId: string;
  taxonomy: Taxonomy;
  run: (action: (db: DatabaseClient) => Promise<unknown>) => Promise<void>;
}) {
  return (
    <div className="taxonomy">
      <TermList
        kind="label"
        heading="Labels"
        terms={taxonomy.labels}
        projectId={projectId}
        run={run}
        empty="No labels yet. A label marks what a scene is — a viewpoint, a strand, a place."
      />
      <TermList
        kind="status"
        heading="Statuses"
        terms={taxonomy.statuses}
        projectId={projectId}
        run={run}
        empty="No statuses yet. A status marks how far along a scene is."
      />
    </div>
  );
}

function TermList({
  kind,
  heading,
  terms,
  projectId,
  run,
  empty,
}: {
  kind: TaxonomyKind;
  heading: string;
  terms: readonly TaxonomyTerm[];
  projectId: string;
  run: (action: (db: DatabaseClient) => Promise<unknown>) => Promise<void>;
  empty: string;
}) {
  const [draft, setDraft] = useState("");
  // Which row has been asked to delete once. One at a time, and cleared by any other
  // click, so an armed button never sits waiting through a scroll.
  const [confirming, setConfirming] = useState<string | null>(null);

  const add = () => {
    const name = draft.trim();
    if (name === "") return;
    setDraft("");
    // A first colour rather than none, so a new label is visible in the tree the
    // moment it is used. The author changes it from the swatch beside the name.
    void run((db) => createTerm(db, projectId, kind, name, kind === "label" ? "#3d6b8e" : null));
  };

  return (
    <section className="taxonomy__kind">
      <h3 className="taxonomy__heading">{heading}</h3>

      {terms.length === 0 ? (
        <p className="taxonomy__empty">{empty}</p>
      ) : (
        <ul className="taxonomy__list">
          {terms.map((item) => (
            <li key={item.id} className="taxonomy__row">
              <TermRow
                item={item}
                projectId={projectId}
                run={run}
                confirming={confirming === item.id}
                onArm={() => setConfirming(item.id)}
                onDisarm={() => setConfirming(null)}
              />
            </li>
          ))}
        </ul>
      )}

      <form
        className="taxonomy__add"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <label className="taxonomy__add-field">
          <span>{kind === "label" ? "New label" : "New status"}</span>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={kind === "label" ? "Bob's POV" : "First draft"}
          />
        </label>
        {/* Named for its kind, not just "Add": there are two of these on the page,
            and a screen reader reading "Add, Add" cannot tell which list it is in. */}
        <button
          type="submit"
          className="button"
          aria-label={kind === "label" ? "Add label" : "Add status"}
          disabled={draft.trim() === ""}
        >
          Add
        </button>
      </form>
    </section>
  );
}

/**
 * One term: its colour, its name, and the button that removes it.
 *
 * The name is saved when the field is left rather than on every keystroke — the same
 * rule the index card's synopsis follows, and for the same reason: each save is a
 * queue entry the next sync has to carry, and a name is retyped several times before
 * it is right.
 */
function TermRow({
  item,
  projectId,
  run,
  confirming,
  onArm,
  onDisarm,
}: {
  item: TaxonomyTerm;
  projectId: string;
  run: (action: (db: DatabaseClient) => Promise<unknown>) => Promise<void>;
  confirming: boolean;
  onArm: () => void;
  onDisarm: () => void;
}) {
  const [name, setName] = useState(item.name);
  const [editing, setEditing] = useState(false);

  // Follows the stored value, except while this row is the one being typed in —
  // where replacing what someone is halfway through writing is worse than showing
  // them a name a moment out of date.
  if (!editing && name !== item.name) setName(item.name);

  const save = (nextName: string, nextColor: string | null) => {
    if (nextName.trim() === "" || (nextName === item.name && nextColor === item.color)) return;
    void run((db) => updateTerm(db, projectId, item.id, nextName, nextColor));
  };

  return (
    <>
      {item.kind === "label" && (
        <input
          type="color"
          className="taxonomy__color"
          value={item.color ?? "#3d6b8e"}
          aria-label={`Colour of ${item.name}`}
          onChange={(event) => save(item.name, event.target.value)}
        />
      )}

      <input
        className="taxonomy__name"
        value={name}
        aria-label={`Name of ${item.name}`}
        onFocus={() => setEditing(true)}
        onChange={(event) => setName(event.target.value)}
        onBlur={() => {
          setEditing(false);
          save(name.trim(), item.color);
        }}
      />

      {confirming ? (
        <>
          <button
            type="button"
            className="button button--danger"
            onClick={() => {
              onDisarm();
              void run((db) => deleteTerm(db, projectId, item.id));
            }}
          >
            {`Delete ${item.name} everywhere`}
          </button>
          <button type="button" className="button" onClick={onDisarm}>
            Keep
          </button>
        </>
      ) : (
        <button
          type="button"
          className="button"
          aria-label={`Delete ${item.name}`}
          onClick={onArm}
        >
          Delete
        </button>
      )}
    </>
  );
}
