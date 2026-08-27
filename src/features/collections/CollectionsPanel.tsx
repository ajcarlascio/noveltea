import { useEffect, useId, useState } from "react";
import { useDatabase } from "@/app/db/DatabaseContext";
import {
  addToCollection,
  createCollection,
  deleteCollection,
  loadMembershipsOf,
  removeFromCollection,
  renameCollection,
  saveCollectionQuery,
  type Collection,
  type CollectionQuery,
} from "@/data/collections";
import type { Taxonomy } from "@/data/taxonomy";
import type { DatabaseClient } from "@/db/client";
import "./collections.css";

/**
 * Making and editing collections.
 *
 * Two kinds, and the choice is made once: a **list** is filled by hand, a **search** is
 * a set of conditions saved under a name. Neither can become the other — see
 * `updateCollection` for why — so the kind is picked when the collection is created and
 * is stated in the interface rather than inferred from whether anything is on it.
 *
 * Everything here is a local write. A saved search is answered against the replica, so
 * it works with no server and no network; what syncs is the query, not its answer.
 */
export function CollectionsPanel({
  projectId,
  collections,
  taxonomy,
  selected,
  run,
}: {
  projectId: string;
  collections: readonly Collection[];
  taxonomy: Taxonomy;
  /** The binder item currently selected, for "add to a list". */
  selected: { id: string; title: string } | null;
  run: (action: (db: DatabaseClient) => Promise<unknown>) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"list" | "search">("list");
  const kindField = useId();

  const add = () => {
    const trimmed = name.trim();
    if (trimmed === "") return;
    setName("");
    // A new search starts with no conditions, which honestly means "everything". The
    // author narrows it from the row it appears in.
    void run((db) => createCollection(db, projectId, trimmed, kind === "search" ? {} : null));
  };

  return (
    <div className="collections">
      {collections.length === 0 ? (
        <p className="collections__empty">
          No collections yet. A list gathers scenes you choose; a search gathers the ones that
          match, and keeps up as you write.
        </p>
      ) : (
        <ul className="collections__list">
          {collections.map((collection) => (
            <li key={collection.id} className="collections__item">
              <CollectionRow
                projectId={projectId}
                collection={collection}
                taxonomy={taxonomy}
                selected={selected}
                run={run}
              />
            </li>
          ))}
        </ul>
      )}

      <form
        className="collections__add"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <label className="collections__add-field">
          <span>New collection</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Marlowe's scenes"
          />
        </label>
        <div className="collections__add-field">
          <label htmlFor={kindField}>Kind</label>
          <select
            id={kindField}
            value={kind}
            onChange={(event) => setKind(event.target.value === "search" ? "search" : "list")}
          >
            <option value="list">A list I fill</option>
            <option value="search">A search that fills itself</option>
          </select>
        </div>
        <button type="submit" className="button" disabled={name.trim() === ""}>
          Add
        </button>
      </form>
    </div>
  );
}

function CollectionRow({
  projectId,
  collection,
  taxonomy,
  selected,
  run,
}: {
  projectId: string;
  collection: Collection;
  taxonomy: Taxonomy;
  selected: { id: string; title: string } | null;
  run: (action: (db: DatabaseClient) => Promise<unknown>) => Promise<void>;
}) {
  const { db } = useDatabase();
  const [name, setName] = useState(collection.name);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [holds, setHolds] = useState(false);

  // Follows the stored value except while this row is the one being typed in.
  if (!editing && name !== collection.name) setName(collection.name);

  // Whether the selected item is already on this list, so one button can say which of
  // "add" and "remove" it does rather than an author guessing.
  useEffect(() => {
    if (selected === null || collection.isSmart) {
      setHolds(false);
      return;
    }
    let current = true;
    const check = () => {
      void loadMembershipsOf(db, projectId, selected.id).then((ids) => {
        if (current) setHolds(ids.has(collection.id));
      });
    };
    check();
    const stop = db.subscribeToChanges(check);
    return () => {
      current = false;
      stop();
    };
  }, [db, projectId, selected, collection.id, collection.isSmart]);

  return (
    <>
      <div className="collections__head">
        <input
          className="collections__name"
          value={name}
          aria-label={`Name of ${collection.name}`}
          onFocus={() => setEditing(true)}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => {
            setEditing(false);
            const next = name.trim();
            if (next !== "" && next !== collection.name) {
              void run((client) => renameCollection(client, projectId, collection.id, next));
            }
          }}
        />
        <span className="collections__kind">{collection.isSmart ? "Search" : "List"}</span>

        {!collection.isSmart && selected !== null && (
          <button
            type="button"
            className="button"
            onClick={() =>
              void run((client) =>
                holds
                  ? removeFromCollection(client, projectId, collection.id, selected.id)
                  : addToCollection(client, projectId, collection.id, selected.id),
              )
            }
          >
            {holds ? `Remove ${selected.title}` : `Add ${selected.title}`}
          </button>
        )}

        {confirming ? (
          <>
            <button
              type="button"
              className="button button--danger"
              onClick={() => {
                setConfirming(false);
                void run((client) => deleteCollection(client, projectId, collection.id));
              }}
            >
              {`Delete ${collection.name}`}
            </button>
            <button type="button" className="button" onClick={() => setConfirming(false)}>
              Keep
            </button>
          </>
        ) : (
          <button
            type="button"
            className="button"
            aria-label={`Delete ${collection.name}`}
            onClick={() => setConfirming(true)}
          >
            Delete
          </button>
        )}
      </div>

      {collection.isSmart && (
        <QueryEditor
          projectId={projectId}
          collection={collection}
          taxonomy={taxonomy}
          run={run}
        />
      )}
    </>
  );
}

/**
 * The conditions a saved search is made of.
 *
 * Deliberately four controls and no expression builder. The query is stored as opaque
 * jsonb and travels between clients, so what keeps two of them agreeing about what a
 * saved search *means* is that the shape stays small enough to implement twice. Every
 * condition is combined with AND; a search with none of them holds the whole manuscript,
 * which is what it says on the row.
 */
function QueryEditor({
  projectId,
  collection,
  taxonomy,
  run,
}: {
  projectId: string;
  collection: Collection;
  taxonomy: Taxonomy;
  run: (action: (db: DatabaseClient) => Promise<unknown>) => Promise<void>;
}) {
  const query = collection.query ?? {};
  const textField = useId();
  const labelField = useId();
  const statusField = useId();
  const typeField = useId();

  const [text, setText] = useState(query.text ?? "");
  const [editing, setEditing] = useState(false);
  if (!editing && text !== (query.text ?? "")) setText(query.text ?? "");

  const save = (next: CollectionQuery) =>
    void run((db) => saveCollectionQuery(db, projectId, collection.id, next));

  return (
    <div className="collections__query">
      <div className="collections__query-field">
        <label htmlFor={textField}>Words</label>
        <input
          id={textField}
          value={text}
          placeholder="marlowe"
          onFocus={() => setEditing(true)}
          onChange={(event) => setText(event.target.value)}
          onBlur={() => {
            setEditing(false);
            // Saved on leaving the field, not per keystroke: each save is a queue entry
            // the next sync carries, and a search term is retyped several times.
            if (text !== (query.text ?? "")) save({ ...query, text });
          }}
        />
      </div>

      <div className="collections__query-field">
        <label htmlFor={labelField}>Label</label>
        <select
          id={labelField}
          value={query.labelIds?.[0] ?? ""}
          onChange={(event) =>
            save({
              ...query,
              labelIds: event.target.value === "" ? [] : [event.target.value],
            })
          }
        >
          <option value="">Any label</option>
          {taxonomy.labels.map((label) => (
            <option key={label.id} value={label.id}>
              {label.name}
            </option>
          ))}
        </select>
      </div>

      <div className="collections__query-field">
        <label htmlFor={statusField}>Status</label>
        <select
          id={statusField}
          value={query.statusIds?.[0] ?? ""}
          onChange={(event) =>
            save({
              ...query,
              statusIds: event.target.value === "" ? [] : [event.target.value],
            })
          }
        >
          <option value="">Any status</option>
          {taxonomy.statuses.map((status) => (
            <option key={status.id} value={status.id}>
              {status.name}
            </option>
          ))}
        </select>
      </div>

      <div className="collections__query-field">
        <label htmlFor={typeField}>Kind</label>
        <select
          id={typeField}
          value={query.types?.[0] ?? ""}
          onChange={(event) =>
            save({
              ...query,
              types: event.target.value === "" ? [] : [event.target.value as "folder" | "document"],
            })
          }
        >
          <option value="">Anything</option>
          <option value="document">Documents</option>
          <option value="folder">Folders</option>
        </select>
      </div>
    </div>
  );
}
