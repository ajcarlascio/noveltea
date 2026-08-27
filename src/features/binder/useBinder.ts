import { useCallback, useEffect, useRef, useState } from "react";
import { useDatabase } from "@/app/db/DatabaseContext";
import { loadBinder, type Binder } from "@/data/binder";
import { EMPTY_TAXONOMY, loadTaxonomy, type Taxonomy } from "@/data/taxonomy";
import { loadCollections, type Collection } from "@/data/collections";
import { loadCompilePresets, type CompilePreset } from "@/data/compile-presets";
import { loadMetadataFields, type MetadataField } from "@/data/metadata";
import type { DatabaseClient } from "@/db/client";

export interface UseBinder {
  binder: Binder | null;
  /**
   * The project's labels and statuses.
   *
   * Read here rather than by a hook of its own: it is the same project, changing on
   * the same writes, and a second subscription would only mean the tree and the terms
   * re-rendering at different moments. Empty until the first read lands, which reads
   * as "no labels yet" — the same thing a new project actually shows.
   */
  taxonomy: Taxonomy;
  /** The project's saved and smart collections, read on the same pass as the tree. */
  collections: Collection[];
  /** The project's compile presets, read on the same pass for the same reason. */
  presets: CompilePreset[];
  /** The project's custom fields. Their values are per item and read where they show. */
  fields: MetadataField[];
  /** The project's own title, for the page heading. Null until it loads. */
  title: string | null;
  error: string | null;
  db: DatabaseClient;
  /** Runs a command, then reloads. Errors are surfaced, never swallowed. */
  run: (action: (db: DatabaseClient) => Promise<unknown>) => Promise<void>;
  reload: () => Promise<void>;
}

export function useBinder(projectId: string): UseBinder {
  const { db } = useDatabase();
  const [binder, setBinder] = useState<Binder | null>(null);
  const [taxonomy, setTaxonomy] = useState<Taxonomy>(EMPTY_TAXONOMY);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [presets, setPresets] = useState<CompilePreset[]>([]);
  const [fields, setFields] = useState<MetadataField[]>([]);
  const [title, setTitle] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Which project the hook is currently for. A load started before the reader opened
  // another one must not land on it — the guard used to live in the mount effect,
  // which is why there were two loading paths and only one of them read the title.
  const active = useRef(projectId);
  active.current = projectId;

  const reload = useCallback(async () => {
    try {
      const [next, terms, saved, exports, custom, rows] = await Promise.all([
        loadBinder(db, projectId),
        loadTaxonomy(db, projectId),
        loadCollections(db, projectId),
        loadCompilePresets(db, projectId),
        loadMetadataFields(db, projectId),
        db.query<{ title: string }>("SELECT title FROM project WHERE id = ?", [projectId]),
      ]);
      if (active.current !== projectId) return;
      setBinder(next);
      setTaxonomy(terms);
      setCollections(saved);
      setPresets(exports);
      setFields(custom);
      setTitle(rows[0]?.title ?? null);
      setError(null);
    } catch (cause) {
      if (active.current !== projectId) return;
      setError(message(cause));
    }
  }, [db, projectId]);

  // Sync applies changes straight to the replica, so the binder has to follow the
  // database and not only its own commands — otherwise what another device wrote
  // does not appear until the page is reloaded.
  useEffect(() => db.subscribeToChanges(() => void reload()), [db, reload]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = useCallback(
    async (action: (client: DatabaseClient) => Promise<unknown>) => {
      // A refused move — a cycle, a document as a parent, a label name already taken —
      // is an ordinary answer, not a crash. It is shown, and the tree is reloaded so
      // what is on screen still matches the database.
      //
      // Reported *after* the reload, not before: `reload` clears the error on a
      // successful read, so setting it first meant every refusal was wiped a
      // microtask later and the author saw nothing at all.
      let failure: string | null = null;
      try {
        await action(db);
      } catch (cause) {
        failure = message(cause);
      }
      await reload();
      if (failure !== null) setError(failure);
    },
    [db, reload],
  );

  return { binder, taxonomy, collections, presets, fields, title, error, db, run, reload };
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
