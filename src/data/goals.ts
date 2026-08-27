import type { DatabaseClient } from "@/db/client";
import type { Reader } from "@/data/projects";
import { DISCARDED } from "@/data/binder";

/**
 * Word targets, and how far along the author is.
 *
 * The targets live in `project.settings`, which the schema set aside for exactly this.
 * The progress is counted from the replica. Both are local: `project` has no entity type
 * in the change feed — the sync endpoint is scoped by a project id in its path, so it
 * cannot carry a change to the project row — which means a target set here stays on this
 * device until the client learns to PATCH the project directly.
 *
 * Today's tally is per device on purpose, and not only because it is easy. Two machines
 * summing their own progress into one number needs a shared clock and an agreement about
 * where a day starts; a device counting what was written on it is a claim it can make
 * honestly on a train with no network.
 */

export interface Goals {
  /** Words for the finished manuscript. Absent means no target. */
  wordTarget?: number;
  /** Words a day. Absent means no target. */
  dailyTarget?: number;
}

export const NO_GOALS: Goals = {};

/** Whole, positive, and small enough to be a manuscript rather than a typo. */
const MAX_TARGET = 10_000_000;

function target(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_TARGET
    ? value
    : undefined;
}

/**
 * Reads the two targets out of the settings bag.
 *
 * Everything else in there is left alone rather than reported: the column is shared with
 * whatever other settings a build keeps, and this module has no business describing keys
 * it does not own.
 */
export function parseGoals(raw: string | null): Goals {
  if (raw === null) return NO_GOALS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NO_GOALS;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return NO_GOALS;

  const settings = parsed as Record<string, unknown>;
  const goals: Goals = {};
  const wordTarget = target(settings.wordTarget);
  if (wordTarget !== undefined) goals.wordTarget = wordTarget;
  const dailyTarget = target(settings.dailyTarget);
  if (dailyTarget !== undefined) goals.dailyTarget = dailyTarget;
  return goals;
}

export async function loadGoals(db: Reader, projectId: string): Promise<Goals> {
  const rows = await db.query<{ settings: string }>(
    "SELECT settings FROM project WHERE id = ?",
    [projectId],
  );
  return parseGoals(rows[0]?.settings ?? null);
}

/**
 * The manuscript's word count, from the replica.
 *
 * The same rule the compile pre-flight follows: only documents carry prose, and
 * something in the trash is not in the manuscript. Counted with the recursive walk in
 * [[DISCARDED]] rather than a parent check, or a discarded act would keep counting
 * towards the target — which is the one direction a motivational number must never
 * be wrong in.
 */
export async function loadWordCount(db: Reader, projectId: string): Promise<number> {
  const rows = await db.query<{ words: number }>(
    `${DISCARDED}
     SELECT COALESCE(SUM(d.word_count), 0) AS words
       FROM document d
       JOIN binder_item b ON b.id = d.id
      WHERE b.project_id = ?
        AND b.deleted_at IS NULL
        AND b.id NOT IN (SELECT id FROM discarded)`,
    [projectId, projectId],
  );
  return rows[0]?.words ?? 0;
}

// -- today, per device ---------------------------------------------------------------

/**
 * Where today started.
 *
 * One entry per project: the day it refers to, and the manuscript's word count when that
 * day began. Today's writing is the difference between then and now, which needs no
 * event log and cannot drift out of step with the actual manuscript — delete a chapter
 * and the number goes down, which is the truth.
 */
export interface DayStart {
  /** A local calendar date, `YYYY-MM-DD`. */
  day: string;
  words: number;
}

const DAY_KEY = "noveltea.day";

/**
 * The author's own date, not UTC.
 *
 * Someone writing at one in the morning is still on tonight's session, and telling them
 * their day reset four hours ago because a server somewhere is on another date would be
 * both wrong and demoralising.
 */
export function localDay(at: Date): string {
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const day = String(at.getDate()).padStart(2, "0");
  return `${String(at.getFullYear())}-${month}-${day}`;
}

function readAll(storage: Storage | undefined): Record<string, DayStart> {
  const raw = storage?.getItem(DAY_KEY);
  if (raw == null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, DayStart>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Where today started for this project, beginning a new day when the date has turned.
 *
 * Also resets when the stored baseline is *above* the current count. That is not
 * defensive tidying: it happens when an author empties the trash, and without it every
 * number for the rest of the day is negative and the strip reads as punishment for
 * tidying up.
 */
export function startOfDay(
  storage: Storage | undefined,
  projectId: string,
  words: number,
  at: Date,
): DayStart {
  const day = localDay(at);
  const all = readAll(storage);
  const stored = all[projectId];

  if (stored !== undefined && stored.day === day && stored.words <= words) return stored;

  const fresh: DayStart = { day, words };
  try {
    storage?.setItem(DAY_KEY, JSON.stringify({ ...all, [projectId]: fresh }));
  } catch {
    // Private browsing, or storage full. Today's tally is a nicety; losing it must not
    // stop the author writing.
  }
  return fresh;
}

// -- commands ----------------------------------------------------------------------

/** Null clears a target. Undefined leaves it as it is. */
export const saveGoals = (
  db: DatabaseClient,
  projectId: string,
  patch: { wordTarget?: number | null; dailyTarget?: number | null },
) => db.command("saveProjectSettings", { projectId, patch });
