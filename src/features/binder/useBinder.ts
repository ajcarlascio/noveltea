import { useCallback, useEffect, useRef, useState } from "react";
import { useDatabase } from "@/app/db/DatabaseContext";
import { loadBinder, type Binder } from "@/data/binder";
import type { DatabaseClient } from "@/db/client";

export interface UseBinder {
  binder: Binder | null;
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
  const [title, setTitle] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Which project the hook is currently for. A load started before the reader opened
  // another one must not land on it — the guard used to live in the mount effect,
  // which is why there were two loading paths and only one of them read the title.
  const active = useRef(projectId);
  active.current = projectId;

  const reload = useCallback(async () => {
    try {
      const [next, rows] = await Promise.all([
        loadBinder(db, projectId),
        db.query<{ title: string }>("SELECT title FROM project WHERE id = ?", [projectId]),
      ]);
      if (active.current !== projectId) return;
      setBinder(next);
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
      try {
        await action(db);
        setError(null);
      } catch (cause) {
        // A refused move — a cycle, a document as a parent — is an ordinary answer,
        // not a crash. It is shown, and the tree is reloaded so what is on screen
        // still matches the database.
        setError(message(cause));
      }
      await reload();
    },
    [db, reload],
  );

  return { binder, title, error, db, run, reload };
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
