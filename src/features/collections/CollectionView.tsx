import { useCallback, useEffect, useRef, useState } from "react";
import { useDatabase } from "@/app/db/DatabaseContext";
import {
  loadCollectionMembers,
  type Collection,
  type CollectionMember,
} from "@/data/collections";
import type { Taxonomy } from "@/data/taxonomy";
import { DocumentIcon, FolderIcon } from "@/features/binder/icons";
import { TermMarks } from "@/features/taxonomy/TermMarks";
import "./collections.css";

/**
 * One collection's contents, in the place the binder tree usually sits.
 *
 * A flat list, not a tree: a collection cuts across the manuscript's shape on purpose —
 * "every scene Marlowe appears in" is exactly the set the folders do *not* group — so
 * drawing it with indentation would suggest a hierarchy that is not there.
 *
 * It reads its own members rather than taking them as a prop, and follows the database
 * the way every other view does. That matters most for a smart collection: it has no
 * membership rows, so what it holds changes when the prose changes, and an author who
 * types a name into a scene should see it join the list without asking for a refresh.
 */
export function CollectionView({
  projectId,
  collection,
  taxonomy,
  selectedId,
  onSelect,
}: {
  projectId: string;
  collection: Collection;
  taxonomy: Taxonomy;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { db } = useDatabase();
  const [members, setMembers] = useState<CollectionMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A read started before the author picked another collection must not land on it.
  const onScreen = useRef(true);
  useEffect(() => {
    onScreen.current = true;
    return () => {
      onScreen.current = false;
    };
  }, []);

  const reload = useCallback(() => {
    loadCollectionMembers(db, projectId, collection)
      .then((loaded) => {
        if (!onScreen.current) return;
        setMembers(loaded);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!onScreen.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    // The collection object is rebuilt on every binder reload, so depending on it
    // directly would re-read on every keystroke's autosave. Its id and its query are
    // the only parts this reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, projectId, collection.id, collection.isSmart, JSON.stringify(collection.query)]);

  useEffect(reload, [reload]);
  useEffect(() => db.subscribeToChanges(reload), [db, reload]);

  if (error !== null) {
    return (
      <p className="collection__error" role="alert">
        {error}
      </p>
    );
  }

  if (members !== null && members.length === 0) {
    return (
      <p className="collection__empty">
        {collection.isSmart
          ? "Nothing matches this search yet."
          : "Nothing on this list yet. Select something in the binder and add it."}
      </p>
    );
  }

  return (
    <ul className="collection" aria-label={collection.name}>
      {(members ?? []).map((member) => (
        <li key={member.id}>
          <button
            type="button"
            className="collection__row"
            aria-current={member.id === selectedId ? "true" : undefined}
            onClick={() => onSelect(member.id)}
          >
            <span className="collection__icon" aria-hidden="true">
              {member.type === "folder" ? <FolderIcon /> : <DocumentIcon />}
            </span>
            <span className="collection__title">{member.title}</span>
            <span className="collection__marks">
              <TermMarks
                taxonomy={taxonomy}
                labelId={member.labelId}
                statusId={member.statusId}
                compact
              />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
