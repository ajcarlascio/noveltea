import { createContext, useContext } from "react";
import type { DatabaseClient, DbStatus } from "@/db/client";

export interface DatabaseContextValue {
  db: DatabaseClient;
  status: DbStatus;
}

export const DatabaseContext = createContext<DatabaseContextValue | null>(null);

export function useDatabase(): DatabaseContextValue {
  const value = useContext(DatabaseContext);
  if (value === null) {
    throw new Error("useDatabase must be used within <DatabaseProvider>");
  }
  return value;
}
