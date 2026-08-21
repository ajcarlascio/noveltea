import { useCallback, useEffect, useState } from "react";
import { useDatabase } from "@/app/db/DatabaseContext";
import { loadBinder, type Binder } from "@/data/binder";
import type { DatabaseClient } from "@/db/client";

export interface UseBinder {
  binder: Binder | null;
  error: string | null;
  db: DatabaseClient;
  /** Runs a command, then reloads. Errors are surfaced, never swallowed. */
  run: (action: (db: DatabaseClient) => Promise<unknown>) => Promise<void>;
  reload: () => Promise<void>;
}

export function useBinder(projectId: string): UseBinder {
  const { db } = useDatabase();
  const [binder, setBinder] = useState<Binder | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setBinder(await loadBinder(db, projectId));
      setError(null);
    } catch (cause) {
      setError(message(cause));
    }
  }, [db, projectId]);

  useEffect(() => {
    let current = true;
    void loadBinder(db, projectId).then(
      (next) => {
        if (current) {
          setBinder(next);
          setError(null);
        }
      },
      (cause: unknown) => {
        if (current) setError(message(cause));
      },
    );
    // Stops a read for one project landing after the reader has opened another.
    return () => {
      current = false;
    };
  }, [db, projectId]);

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

  return { binder, error, db, run, reload };
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
