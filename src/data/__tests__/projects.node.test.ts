// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { listDeletedProjects, listProjects } from "@/data/projects";
import { isoNow, openTestDatabase, type TestDatabase } from "@/test/sqlite";

/**
 * Runs the real SQL against the real migrated schema. A stubbed database would
 * only prove the stub agrees with itself; the bug this catches is a column name
 * that no longer exists, which type checking cannot see because SQL is a string.
 */

let db: TestDatabase | null = null;

afterEach(() => {
  db?.close();
  db = null;
});

function insertProject(
  target: TestDatabase,
  id: string,
  title: string,
  deletedAt: string | null = null,
): void {
  target.run(
    "INSERT INTO project (id, title, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?)",
    [id, title, isoNow(), isoNow(), deletedAt],
  );
}

describe("listProjects", () => {
  it("returns nothing for an empty replica", async () => {
    db = openTestDatabase();
    await expect(listProjects(db)).resolves.toEqual([]);
  });

  it("maps the row onto the shape the app uses", async () => {
    db = openTestDatabase();
    insertProject(db, "p1", "The Lighthouse");
    const [project] = await listProjects(db);
    expect(project).toEqual({
      id: "p1",
      title: "The Lighthouse",
      createdAt: isoNow(),
      updatedAt: isoNow(),
    });
  });

  it("orders by title without regard to case", async () => {
    db = openTestDatabase();
    // Chosen so the two collations genuinely disagree: SQLite's default BINARY
    // sorts every capital before every lowercase, giving Beta, alpha, gamma —
    // which reads as random to an author. Titles like "Apple/banana/zebra" would
    // sort identically either way and would prove nothing.
    insertProject(db, "p1", "gamma");
    insertProject(db, "p2", "Beta");
    insertProject(db, "p3", "alpha");
    expect((await listProjects(db)).map((p) => p.title)).toEqual(["alpha", "Beta", "gamma"]);
  });

  it("breaks ties on id so the order is stable across reads", async () => {
    db = openTestDatabase();
    insertProject(db, "p2", "Untitled");
    insertProject(db, "p1", "Untitled");
    expect((await listProjects(db)).map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("hides deleted projects", async () => {
    db = openTestDatabase();
    insertProject(db, "p1", "Kept");
    insertProject(db, "p2", "Discarded", isoNow());
    expect((await listProjects(db)).map((p) => p.id)).toEqual(["p1"]);
  });

  it("returns a title containing SQL punctuation unchanged", async () => {
    db = openTestDatabase();
    const awkward = `Robert'); DROP TABLE project;-- "quoted" %wild_card%`;
    insertProject(db, "p1", awkward);
    const [project] = await listProjects(db);
    expect(project?.title).toBe(awkward);
    // And the table is still there, which is the point of binding parameters.
    expect(await listProjects(db)).toHaveLength(1);
  });
});

describe("listDeletedProjects", () => {
  it("returns only the deleted ones", async () => {
    db = openTestDatabase();
    insertProject(db, "p1", "Kept");
    insertProject(db, "p2", "Discarded", isoNow());
    expect((await listDeletedProjects(db)).map((p) => p.id)).toEqual(["p2"]);
  });

  it("does not delete anything locally — the rows are still there", async () => {
    // A deleted project stays restorable until the server purges it. Removing the
    // row here would make "restore" impossible offline.
    db = openTestDatabase();
    insertProject(db, "p2", "Discarded", isoNow());
    await listProjects(db);
    expect(db.adapter.query("SELECT id FROM project")).toHaveLength(1);
  });
});
