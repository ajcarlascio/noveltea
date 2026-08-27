import { useEffect, useRef, useState } from "react";
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
import {
  ArrowToTopIcon,
  CorkboardIcon,
  DocumentPlusIcon,
  FolderPlusIcon,
  ImportIcon,
  PanelIcon,
  PencilIcon,
  TrashIcon,
} from "@/features/binder/icons";
import {
  ancestorIds,
  readExpandedIds,
  readLastDocumentId,
  safeStorage,
  writeExpandedIds,
  writeLastDocumentId,
} from "@/features/binder/binderState";
import { Corkboard } from "@/features/corkboard/Corkboard";
import { DocumentEditor } from "@/features/editor/DocumentEditor";
import { IMPORT_EXTENSIONS } from "@/features/import/markdown";
import {
  importDocuments,
  readFileText,
  type ImportSource,
} from "@/features/import/importDocuments";
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
  // Seeded from storage so the tree opens the way the author left it rather than
  // folded shut. The initializer only runs once, so a change of project is handled
  // by the effect below, not by this.
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(
    () => new Set(readExpandedIds(safeStorage(), projectId)),
  );
  const [renaming, setRenaming] = useState(false);
  /**
   * Writing, or looking at the shape of it.
   *
   * Deliberately not remembered between visits. The corkboard is where an author goes
   * to think about structure, and returning to it days later instead of to the page
   * they were writing would be the app deciding what they came back for.
   */
  const [view, setView] = useState<"write" | "corkboard">("write");
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const importInput = useRef<HTMLInputElement>(null);

  // The same route component serves every project, so switching projects re-reads
  // this project's remembered state instead of carrying the previous one's across.
  useEffect(() => {
    setSelectedId(null);
    setView("write");
    setExpandedIds(new Set(readExpandedIds(safeStorage(), projectId)));
  }, [projectId]);

  // Expansion is device-only view state: written whenever it changes, keyed by
  // project, and never synced. Writing in an effect keeps the state updaters pure.
  useEffect(() => {
    writeExpandedIds(safeStorage(), projectId, expandedIds);
  }, [projectId, expandedIds]);

  const nodes = binder?.roots ?? [];
  const selected = flatten(nodes).find((node) => node.id === selectedId) ?? null;
  // A document is a leaf, so new items go beside it rather than inside it.
  const parentForNew = selected === null ? null : selected.type === "folder" ? selected.id : selected.parentId;

  /**
   * Once the binder has loaded, return the author to the document they were last
   * reading, with its folders opened on the way down. A stale id — the document was
   * trashed on another device — selects nothing rather than failing.
   *
   * Once per project, tracked in a ref, and not "whenever nothing is selected". The
   * second reading is what it used to do, and it made clearing the selection
   * impossible: the corkboard's own trail sets it to null to go back to the top of
   * the manuscript, this effect put the last document straight back, and the button
   * did nothing at all. Nothing had asked to deselect before, so nothing had noticed.
   */
  const restoredFor = useRef<string | null>(null);
  useEffect(() => {
    if (binder === null || restoredFor.current === projectId) return;
    restoredFor.current = projectId;
    const lastId = readLastDocumentId(safeStorage(), projectId);
    if (lastId === null) return;
    const last = flatten(binder.roots).find((node) => node.id === lastId);
    if (!last || last.type !== "document") return;
    setSelectedId(lastId);
    setExpandedIds((current) => {
      const next = new Set(current);
      for (const id of ancestorIds(binder.roots, lastId)) next.add(id);
      return next;
    });
  }, [binder, projectId]);

  const select = (id: string) => {
    setSelectedId(id);
    const node = flatten(nodes).find((candidate) => candidate.id === id);
    if (node?.type === "document") writeLastDocumentId(safeStorage(), projectId, id);
  };

  const toggle = (id: string) =>
    setExpandedIds((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const afterCreate = (parentId: string | null) => {
    if (parentId !== null) setExpandedIds((current) => new Set(current).add(parentId));
  };

  /**
   * Which level the corkboard is showing.
   *
   * The level the author is already looking at, not a place of its own: a selected
   * folder means "the scenes in this folder", a selected document means "this scene and
   * the ones beside it", and nothing selected means the top of the manuscript. Choosing
   * anything else would make the two views disagree about where the reader is.
   */
  const boardParentId =
    selected === null ? null : selected.type === "folder" ? selected.id : selected.parentId;

  const boardTrail = [
    { id: null, title: title ?? "Manuscript" },
    ...(boardParentId === null
      ? []
      : [...ancestorIds(nodes, boardParentId), boardParentId].map((id) => ({
          id,
          title: flatten(nodes).find((node) => node.id === id)?.title ?? "Folder",
        }))),
  ];

  const collapsed = settings.binderCollapsed;
  const toggleBinder = () =>
    update((current) => ({ ...current, binderCollapsed: !current.binderCollapsed }));

  /**
   * Brings text and Markdown files in as documents beside the selection.
   *
   * No network anywhere in this path. Reading and parsing are local, and the writes
   * are the same commands the New document button uses, so an import made on a train
   * is queued for sync like any other edit rather than being refused.
   */
  async function onFilesChosen(files: FileList | null) {
    setImportErrors([]);
    if (files === null || files.length === 0) return;

    const sources: ImportSource[] = [];
    const failures: string[] = [];
    for (const file of Array.from(files)) {
      try {
        sources.push({ fileName: file.name, text: await readFileText(file) });
      } catch {
        failures.push(`“${file.name}” could not be read.`);
      }
    }

    await run(async (db) => {
      const outcome = await importDocuments(db, projectId, parentForNew, sources);
      setImportErrors([...failures, ...outcome.errors]);
      // Opening the last import is the confirmation that it worked.
      const last = outcome.created.at(-1);
      if (last !== undefined) select(last);
    });

    // Let the same file be picked again.
    if (importInput.current !== null) importInput.current.value = "";
  }

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
          icon={<PanelIcon />}
          onClick={toggleBinder}
        />
        <ToolbarButton
          label="New folder"
          short="Folder"
          icon={<FolderPlusIcon />}
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
          icon={<DocumentPlusIcon />}
          onClick={() =>
            void run(async (db) => {
              await createDocument(db, projectId, parentForNew, "Untitled");
              afterCreate(parentForNew);
            })
          }
        />
        <ToolbarButton
          label="Import text or Markdown"
          short="Import"
          icon={<ImportIcon />}
          onClick={() => importInput.current?.click()}
        />
        <ToolbarButton
          label={view === "corkboard" ? "Back to writing" : "Corkboard"}
          short={view === "corkboard" ? "Write" : "Cards"}
          icon={<CorkboardIcon />}
          pressed={view === "corkboard"}
          onClick={() => setView((current) => (current === "write" ? "corkboard" : "write"))}
        />
        <ToolbarButton
          label="Rename"
          icon={<PencilIcon />}
          disabled={selected === null}
          onClick={() => setRenaming(true)}
        />
        <ToolbarButton
          label="Move to trash"
          short="Trash"
          icon={<TrashIcon />}
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
          icon={<ArrowToTopIcon />}
          disabled={selected === null || selected.parentId === null}
          onClick={() =>
            void run(async (db) => {
              if (selected) await moveItem(db, projectId, selected.id, null, null);
            })
          }
        />
      </div>

      {/* Outside the toolbar: a file input is not one of the toolbar's controls, and
          counting it as one would put a stray tab stop between the buttons. */}
      <input
        ref={importInput}
        type="file"
        multiple
        accept={IMPORT_EXTENSIONS.map((ext) => `.${ext}`).join(",")}
        className="project__import-input"
        onChange={(event) => void onFilesChosen(event.target.files)}
      />

      {importErrors.length > 0 && (
        <p className="project__error" role="alert">
          {importErrors.join(" ")}
        </p>
      )}

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
            <SearchPanel projectId={projectId} onOpen={select} />
            <div className="project__binder-scroll">
              <BinderTree
                label="Binder"
                nodes={nodes}
                selectedId={selectedId}
                onSelect={select}
                expandedIds={expandedIds}
                onToggle={toggle}
                emptyMessage="This binder is empty. Start with a folder or a document."
              />
            </div>
          </div>
        )}

        {view === "corkboard" ? (
          // Keyed on the level so drilling into a folder starts a fresh board rather
          // than briefly showing the previous folder's cards under the new heading.
          <Corkboard
            key={boardParentId ?? ""}
            projectId={projectId}
            parentId={boardParentId}
            trail={boardTrail}
            onNavigate={(id) => {
              if (id === null) setSelectedId(null);
              else select(id);
            }}
            onOpenDocument={(id) => {
              select(id);
              setView("write");
            }}
          />
        ) : selected?.type === "document" ? (
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
