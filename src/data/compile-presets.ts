import type { DatabaseClient } from "@/db/client";
import type { Reader } from "@/data/projects";
import { isExportFormat, type ExportFormat } from "@/db/compile-preset-commands";

/**
 * Compile presets, read from the local replica.
 *
 * A preset is a saved submission format: the export format, and which parts of the
 * binder go into it. Both are stored and both sync, so an author who set up "agent
 * submission — first three chapters, standard manuscript format" on their desktop finds
 * it on their laptop.
 *
 * The selection is a list of ids and not a query. That is the shape the compile worker
 * reads, so a preset means the same thing here and on the server; a query would have to
 * be evaluated twice and would drift the moment the two implementations disagreed.
 */

export type { ExportFormat };

export interface CompilePreset {
  id: string;
  name: string;
  format: ExportFormat;
  /** The binder items to export. Empty means the whole manuscript. */
  includedIds: string[];
}

interface PresetRow {
  id: string;
  name: string;
  format: string;
  included_binder_items: string | null;
}

/**
 * A selection that cannot be parsed reads as the whole manuscript.
 *
 * A CHECK keeps malformed JSON out of the column, so this is really about a value from
 * a version of the app that stored it differently. Exporting everything is the safe
 * wrong answer: the author sees too much in the pre-flight and says so, where the other
 * fallback — an empty selection treated as "nothing" — would be a preset that silently
 * compiles a blank manuscript.
 */
function parseSelection(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export async function loadCompilePresets(
  db: Reader,
  projectId: string,
): Promise<CompilePreset[]> {
  const rows = await db.query<PresetRow>(
    `SELECT id, name, format, included_binder_items FROM compile_preset
      WHERE project_id = ? AND deleted_at IS NULL
      ORDER BY name, id`,
    [projectId],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    // A format this build does not know is shown as Markdown rather than dropping the
    // preset: the name and the selection are still the author's work.
    format: isExportFormat(row.format) ? row.format : "md",
    includedIds: parseSelection(row.included_binder_items),
  }));
}

// -- commands ----------------------------------------------------------------------

export const createCompilePreset = (
  db: DatabaseClient,
  projectId: string,
  name: string,
  format: string,
  includedIds: string[],
) => db.command("createCompilePreset", { projectId, name, format, includedIds });

export const updateCompilePreset = (
  db: DatabaseClient,
  projectId: string,
  id: string,
  changes: { name?: string; format?: string; includedIds?: string[] },
) => db.command("updateCompilePreset", { projectId, id, ...changes });

export const deleteCompilePreset = (db: DatabaseClient, projectId: string, id: string) =>
  db.command("deleteCompilePreset", { projectId, id });
