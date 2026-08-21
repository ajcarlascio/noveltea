import { useState } from "react";
import { useParams } from "react-router-dom";
import {
  createDocument,
  createFolder,
  emptyTrash,
  moveItem,
  renameItem,
  restoreItem,
  trashItem,
  flatten,
  type BinderNode,
} from "@/data/binder";
import { BinderTree } from "@/features/binder/BinderTree";
import { useBinder } from "@/features/binder/useBinder";
import { StorageWarning } from "@/ui/StorageWarning";
import "./Project.css";

export function Project() {
  const { projectId = "" } = useParams();
  const { binder, error, run } = useBinder(projectId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());
  const [renaming, setRenaming] = useState(false);

  const nodes = binder?.roots ?? [];
  const selected = flatten(nodes).find((node) => node.id === selectedId) ?? null;
  // A document is a leaf, so new items go beside it rather than inside it.
  const parentForNew = selected === null ? null : selected.type === "folder" ? selected.id : selected.parentId;

  const toggle = (id: string) =>
    setExpandedIds((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const afterCreate = (parentId: string | null) => {
    if (parentId !== null) setExpandedIds((current) => new Set(current).add(parentId));
  };

  return (
    <section className="page">
      <h1>Binder</h1>
      <StorageWarning />

      {error !== null && (
        <p className="project__error" role="alert">
          {error}
        </p>
      )}

      <div className="project__toolbar" role="toolbar" aria-label="Binder actions">
        <button
          type="button"
          onClick={() =>
            void run(async (db) => {
              await createFolder(db, projectId, parentForNew, "New folder");
              afterCreate(parentForNew);
            })
          }
        >
          New folder
        </button>
        <button
          type="button"
          onClick={() =>
            void run(async (db) => {
              await createDocument(db, projectId, parentForNew, "Untitled");
              afterCreate(parentForNew);
            })
          }
        >
          New document
        </button>
        <button type="button" disabled={selected === null} onClick={() => setRenaming(true)}>
          Rename
        </button>
        <button
          type="button"
          disabled={selected === null}
          onClick={() =>
            void run(async (db) => {
              if (selected) await trashItem(db, projectId, selected.id);
              setSelectedId(null);
            })
          }
        >
          Move to trash
        </button>
        <button
          type="button"
          disabled={selected === null || selected.parentId === null}
          onClick={() =>
            void run(async (db) => {
              if (selected) await moveItem(db, projectId, selected.id, null, null);
            })
          }
        >
          Move to top level
        </button>
      </div>

      {renaming && selected !== null && (
        <RenameForm
          node={selected}
          onCancel={() => setRenaming(false)}
          onSubmit={(title) => {
            setRenaming(false);
            void run((db) => renameItem(db, projectId, selected.id, title));
          }}
        />
      )}

      <BinderTree
        label="Binder"
        nodes={nodes}
        selectedId={selectedId}
        onSelect={setSelectedId}
        expandedIds={expandedIds}
        onToggle={toggle}
        emptyMessage="This binder is empty. Start with a folder or a document."
      />

      <h2 className="project__trash-heading">Trash</h2>
      {binder !== null && binder.trash.length === 0 ? (
        <p className="page__note">Nothing in the trash.</p>
      ) : (
        <>
          <ul className="project__trash">
            {(binder?.trash ?? []).map((node) => (
              <li key={node.id}>
                <span>{node.title}</span>
                <button
                  type="button"
                  onClick={() => void run((db) => restoreItem(db, projectId, node.id))}
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="project__danger"
            onClick={() => void run((db) => emptyTrash(db, projectId))}
          >
            Empty trash
          </button>
        </>
      )}
    </section>
  );
}

function RenameForm({
  node,
  onSubmit,
  onCancel,
}: {
  node: BinderNode;
  onSubmit: (title: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(node.title);
  return (
    <form
      className="project__rename"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(value);
      }}
    >
      <label htmlFor="rename-title">New title</label>
      <input
        id="rename-title"
        value={value}
        autoFocus
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
        }}
      />
      <button type="submit">Save</button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}
