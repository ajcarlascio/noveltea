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
import { DocumentEditor } from "@/features/editor/DocumentEditor";
import { SyncStatus } from "@/features/sync/SyncStatus";
import { useBinder } from "@/features/binder/useBinder";
import { StorageWarning } from "@/ui/StorageWarning";
import { ToolbarButton } from "@/ui/ToolbarButton";
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
      <SyncStatus projectId={projectId} />

      {error !== null && (
        <p className="project__error" role="alert">
          {error}
        </p>
      )}

      <div className="project__toolbar" role="toolbar" aria-label="Binder actions">
        <ToolbarButton
          label="New folder"
          short="Folder"
          onClick={() =>
            void run(async (db) => {
              await createFolder(db, projectId, parentForNew, "New folder");
              afterCreate(parentForNew);
            })
          }
        />
        <ToolbarButton
          label="New document"
          short="Document"
          onClick={() =>
            void run(async (db) => {
              await createDocument(db, projectId, parentForNew, "Untitled");
              afterCreate(parentForNew);
            })
          }
        />
        <ToolbarButton
          label="Rename"
          disabled={selected === null}
          onClick={() => setRenaming(true)}
        />
        <ToolbarButton
          label="Move to trash"
          short="Trash"
          disabled={selected === null}
          onClick={() =>
            void run(async (db) => {
              if (selected) await trashItem(db, projectId, selected.id);
              setSelectedId(null);
            })
          }
        />
        <ToolbarButton
          label="Move to top level"
          short="To top"
          disabled={selected === null || selected.parentId === null}
          onClick={() =>
            void run(async (db) => {
              if (selected) await moveItem(db, projectId, selected.id, null, null);
            })
          }
        />
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

      <div className="project__panes">
        <div className="project__binder">
          <BinderTree
            label="Binder"
            nodes={nodes}
            selectedId={selectedId}
            onSelect={setSelectedId}
            expandedIds={expandedIds}
            onToggle={toggle}
            emptyMessage="This binder is empty. Start with a folder or a document."
          />
        </div>

        {selected?.type === "document" ? (
          // Keyed on the id so switching documents remounts rather than reusing an
          // editor still holding the previous one's history and unsaved changes.
          <DocumentEditor key={selected.id} projectId={projectId} documentId={selected.id} />
        ) : (
          <p className="project__hint">
            {selected === null
              ? "Select a document to write."
              : "Folders hold documents. Select one to write."}
          </p>
        )}
      </div>

      <h2 className="project__trash-heading">Trash</h2>
      {binder !== null && binder.trash.length === 0 ? (
        <p className="page__note">Nothing in the trash.</p>
      ) : (
        <>
          <ul className="project__trash">
            {(binder?.trash ?? []).map((node) => (
              <li key={node.id}>
                <span>{node.title}</span>
                <button className="button"
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
            className="button button--danger"
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
      <button className="button" type="submit">Save</button>
      <button className="button" type="button" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}
