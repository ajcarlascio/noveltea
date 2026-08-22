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
import { CompilePanel } from "@/features/compile/CompilePanel";
import { ConflictsPanel } from "@/features/conflicts/ConflictsPanel";
import { SearchPanel } from "@/features/search/SearchPanel";
import { SyncStatus } from "@/features/sync/SyncStatus";
import { useBinder } from "@/features/binder/useBinder";
import { useSettings } from "@/app/settings/SettingsContext";
import { StorageWarning } from "@/ui/StorageWarning";
import { ToolbarButton } from "@/ui/ToolbarButton";
import "./Project.css";

export function Project() {
  const { projectId = "" } = useParams();
  const { binder, title, error, run } = useBinder(projectId);
  const { settings, update } = useSettings();
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

  const collapsed = settings.binderCollapsed;
  const toggleBinder = () =>
    update((current) => ({ ...current, binderCollapsed: !current.binderCollapsed }));

  return (
    <section className="page page--full">
      {/* The project's name, not the word "Binder": a heading is a landmark a screen
          reader lands on, and it may as well say which book this is. */}
      <h1 className="project__title">{title ?? "Project"}</h1>
      <StorageWarning />
      <SyncStatus projectId={projectId} />
      <ConflictsPanel projectId={projectId} />

      {error !== null && (
        <p className="project__error" role="alert">
          {error}
        </p>
      )}

      <div className="project__toolbar" role="toolbar" aria-label="Binder actions">
        <ToolbarButton
          label={collapsed ? "Show binder" : "Hide binder"}
          short={collapsed ? "Binder" : "Hide"}
          onClick={toggleBinder}
        />
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

      <div className={`project__panes${collapsed ? " project__panes--collapsed" : ""}`}>
        {!collapsed && (
          <div className="project__binder">
            <SearchPanel projectId={projectId} onOpen={setSelectedId} />
            <div className="project__binder-scroll">
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
          </div>
        )}

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

      {/* Folded away by default. Compiling and the trash are occasional; the
          manuscript is not, and they were taking permanent height from it. */}
      <details className="project__footer">
        <summary>Compile and trash</summary>
        <CompilePanel projectId={projectId} />

        <h2 className="project__trash-heading">Trash</h2>
        {binder !== null && binder.trash.length === 0 ? (
          <p>Nothing in the trash.</p>
        ) : (
          <>
            <ul className="project__trash">
              {(binder?.trash ?? []).map((node) => (
                <li key={node.id}>
                  <span>{node.title}</span>
                  <button
                    type="button"
                    className="button"
                    onClick={() => void run((db) => restoreItem(db, projectId, node.id))}
                  >
                    Restore
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="button project__danger"
              onClick={() => void run((db) => emptyTrash(db, projectId))}
            >
              Empty trash
            </button>
          </>
        )}
      </details>
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
