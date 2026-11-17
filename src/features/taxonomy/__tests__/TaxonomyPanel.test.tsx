import { act, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseContext } from "@/app/db/DatabaseContext";
import type { DbStatus } from "@/db/client";
import { EMPTY_TAXONOMY, loadTaxonomy } from "@/data/taxonomy";
import { COMMANDS } from "@/db/commands";
import { openTestDatabase, type TestDatabase } from "@/test/sqlite";
import { TaxonomyPanel } from "../TaxonomyPanel";

/**
 * A label's name field against a replica another device writes to, over real SQLite.
 * It stands for every field saved on leaving it: they share `useFieldDraft`.
 */
const READY: DbStatus = { state: "ready", storage: "memory", appliedVersions: [], schemaVersion: 11 };

let db: TestDatabase;
let projectId: string;
let labelId: string;

beforeEach(() => {
  db = openTestDatabase();
  projectId = COMMANDS.createProject(db.adapter, { title: "The Lighthouse" }).id;
  labelId = COMMANDS.createTaxonomy(db.adapter, { projectId, kind: "label", name: "POV", color: "#3d6b8e" }).id;
  db.adapter.run("DELETE FROM pending_change;");
});
afterEach(() => db.close());

const renamedElsewhere = (name: string) =>
  act(async () => {
    await db.client.command("updateTaxonomy", { projectId, id: labelId, name, color: "#3d6b8e" });
    db.adapter.run("DELETE FROM pending_change;");
  });
const nameOf = () => db.adapter.query<{ name: string }>("SELECT name FROM taxonomy WHERE id = ?;", [labelId])[0]?.name;
const queued = () => db.adapter.query("SELECT id FROM pending_change;").length;

/** The panel as the project page holds it: terms re-read after every database change. */
function Harness() {
  const [taxonomy, setTaxonomy] = useState(EMPTY_TAXONOMY);
  useEffect(() => {
    const reload = () => void loadTaxonomy(db.client, projectId).then(setTaxonomy);
    reload();
    return db.client.subscribeToChanges(reload);
  }, []);
  return <TaxonomyPanel projectId={projectId} taxonomy={taxonomy} run={async (action) => void (await action(db.client))} />;
}

function renderPanel() {
  render(
    <DatabaseContext.Provider value={{ db: db.client, status: READY }}>
      <Harness />
    </DatabaseContext.Provider>,
  );
}

describe("a name changed on another device while its field is open", () => {
  it("is not renamed back by a field that was only clicked into", async () => {
    renderPanel();
    await userEvent.click(await screen.findByLabelText("Name of POV"));
    await renamedElsewhere("Point of view");
    await userEvent.tab();

    expect(queued()).toBe(0);
    expect(nameOf()).toBe("Point of view");
    await waitFor(() => expect(screen.getByLabelText("Name of Point of view")).toHaveValue("Point of view"));
  });

  it("still takes a name the author typed", async () => {
    renderPanel();
    const field = await screen.findByLabelText("Name of POV");
    await userEvent.clear(field);
    await userEvent.type(field, "Narrator");
    await renamedElsewhere("Point of view");
    await userEvent.tab();

    await waitFor(() => expect(nameOf()).toBe("Narrator"));
  });
});
