// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "@/db/commands";
import { loadGoals, loadWordCount, localDay, parseGoals, startOfDay } from "@/data/goals";
import { openTestDatabase, type TestDatabase } from "@/test/sqlite";

let db: TestDatabase;
let projectId: string;

const reader = {
  query: <T>(sql: string, params?: readonly (string | number | null)[]): Promise<T[]> =>
    Promise.resolve(db.adapter.query<T>(sql, params)),
};

beforeEach(() => {
  db = openTestDatabase();
  projectId = COMMANDS.createProject(db.adapter, { title: "The Long Goodbye" }).id;
});

afterEach(() => db.close());

function document(title: string, words: number, parentId: string | null = null): string {
  const id = COMMANDS.createBinderItem(db.adapter, {
    projectId,
    parentId,
    type: "document",
    title,
  }).id;
  COMMANDS.saveDocument(db.adapter, {
    projectId,
    id,
    content: { type: "doc", content: [] },
    searchText: "x",
    wordCount: words,
  });
  return id;
}

/** A Storage that lives in this test, so the tally is not global state. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  };
}

describe("reading the targets", () => {
  it("reads both out of the settings bag", async () => {
    COMMANDS.saveProjectSettings(db.adapter, {
      projectId,
      patch: { wordTarget: 80_000, dailyTarget: 1_000 },
    });
    expect(await loadGoals(reader, projectId)).toEqual({ wordTarget: 80_000, dailyTarget: 1_000 });
  });

  it("ignores a target that is not a whole positive number", () => {
    // The column is a shared bag another build also writes to, and it is on disk where
    // it can be edited by hand. A target of -1 or 1e300 draws a bar that means nothing.
    expect(parseGoals(JSON.stringify({ wordTarget: -1 }))).toEqual({});
    expect(parseGoals(JSON.stringify({ wordTarget: 1.5 }))).toEqual({});
    expect(parseGoals(JSON.stringify({ wordTarget: "80000" }))).toEqual({});
    expect(parseGoals(JSON.stringify({ wordTarget: 1e300 }))).toEqual({});
  });

  it("reads settings that are not an object as no targets", () => {
    expect(parseGoals("[]")).toEqual({});
    expect(parseGoals("not json")).toEqual({});
    expect(parseGoals(null)).toEqual({});
  });
});

describe("saving a target", () => {
  it("keeps settings this build does not own", () => {
    // The column is shared. Writing the whole object would delete a future build's
    // compile defaults every time an author changed their word target — the opposite of
    // the rule for a collection's query, where an unknown key is dropped.
    db.adapter.run("UPDATE project SET settings = ? WHERE id = ?;", [
      JSON.stringify({ compileDefaults: { format: "docx" } }),
      projectId,
    ]);
    COMMANDS.saveProjectSettings(db.adapter, { projectId, patch: { wordTarget: 80_000 } });

    const row = db.adapter.query<{ settings: string }>(
      "SELECT settings FROM project WHERE id = ?;",
      [projectId],
    )[0];
    expect(JSON.parse(row!.settings)).toEqual({
      compileDefaults: { format: "docx" },
      wordTarget: 80_000,
    });
  });

  it("removes the key when a target is cleared, rather than storing a null", async () => {
    COMMANDS.saveProjectSettings(db.adapter, { projectId, patch: { wordTarget: 80_000 } });
    COMMANDS.saveProjectSettings(db.adapter, { projectId, patch: { wordTarget: null } });

    const row = db.adapter.query<{ settings: string }>(
      "SELECT settings FROM project WHERE id = ?;",
      [projectId],
    )[0];
    expect(JSON.parse(row!.settings)).toEqual({});
    expect(await loadGoals(reader, projectId)).toEqual({});
  });

  it("queues nothing, because a project is not a synced entity", () => {
    // `pending_change` has no `project` entity type — the sync endpoint is scoped by a
    // project id in its path and cannot carry a change to the project row. Pinned so
    // that a build which starts syncing settings has to come and change this test.
    db.adapter.run("DELETE FROM pending_change;");
    COMMANDS.saveProjectSettings(db.adapter, { projectId, patch: { wordTarget: 80_000 } });
    expect(db.adapter.query("SELECT * FROM pending_change;")).toHaveLength(0);
  });
});

describe("counting the manuscript", () => {
  it("adds up every live document", async () => {
    document("One", 1_200);
    document("Two", 800);
    expect(await loadWordCount(reader, projectId)).toBe(2_000);
  });

  it("LEAVES OUT A SCENE INSIDE A TRASHED FOLDER, NOT JUST THE FOLDER", async () => {
    // Discarding an act reparents the folder alone; its scenes still point at it. A
    // one-level check would keep counting them towards the target, which is the one
    // direction a motivational number must never be wrong in.
    const act = COMMANDS.createBinderItem(db.adapter, {
      projectId,
      parentId: null,
      type: "folder",
      title: "Act Three",
    }).id;
    document("Kept", 1_000);
    document("Cut", 5_000, act);
    COMMANDS.trashBinderItem(db.adapter, { projectId, id: act });

    expect(await loadWordCount(reader, projectId)).toBe(1_000);
  });

  it("is zero for a project with nothing written", async () => {
    expect(await loadWordCount(reader, projectId)).toBe(0);
  });
});

describe("where today started", () => {
  const noon = new Date("2026-08-27T12:00:00");

  it("records the count the first time it is asked, and holds it", () => {
    const storage = memoryStorage();
    expect(startOfDay(storage, projectId, 48_000, noon).words).toBe(48_000);
    // Later in the same day, with more written: the baseline does not move, which is
    // what makes the difference "today".
    expect(startOfDay(storage, projectId, 49_240, noon).words).toBe(48_000);
  });

  it("starts again when the date turns", () => {
    const storage = memoryStorage();
    startOfDay(storage, projectId, 48_000, noon);
    const tomorrow = new Date("2026-08-28T09:00:00");
    expect(startOfDay(storage, projectId, 49_240, tomorrow)).toEqual({
      day: "2026-08-28",
      words: 49_240,
    });
  });

  it("starts again when the manuscript has shrunk below the baseline", () => {
    // What happens when an author empties the trash. Without this, every number for the
    // rest of the day is negative and the strip reads as punishment for tidying up.
    const storage = memoryStorage();
    startOfDay(storage, projectId, 48_000, noon);
    expect(startOfDay(storage, projectId, 40_000, noon).words).toBe(40_000);
  });

  it("keeps a separate baseline per project", () => {
    const storage = memoryStorage();
    startOfDay(storage, "a", 1_000, noon);
    startOfDay(storage, "b", 5_000, noon);
    expect(startOfDay(storage, "a", 1_200, noon).words).toBe(1_000);
    expect(startOfDay(storage, "b", 5_200, noon).words).toBe(5_000);
  });

  it("survives storage being unavailable", () => {
    // Private browsing, or storage full. Today's tally is a nicety; losing it must not
    // stop the author writing.
    expect(startOfDay(undefined, projectId, 48_000, noon).words).toBe(48_000);
  });

  it("uses the author's own date, not UTC", () => {
    // Someone writing at one in the morning is still on tonight's session. Telling them
    // the day reset because a server is on another date would be wrong and demoralising.
    expect(localDay(new Date(2026, 7, 27, 1, 0, 0))).toBe("2026-08-27");
    expect(localDay(new Date(2026, 0, 5, 23, 30, 0))).toBe("2026-01-05");
  });
});
