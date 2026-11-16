import { act, render, screen, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseContext } from "@/app/db/DatabaseContext";
import { SettingsProvider } from "@/app/settings/SettingsProvider";
import { DEFAULT_SETTINGS } from "@/app/settings/settings";
import type { DbStatus } from "@/db/client";
import { COMMANDS } from "@/db/commands";
import { openTestDatabase, type TestDatabase } from "@/test/sqlite";
import { DocumentEditor } from "../DocumentEditor";

/**
 * The editor against a replica that sync writes to underneath it.
 *
 * Real SQLite and the real commands, as for the corkboard: what matters is what the
 * editor's next save puts in the queue, and a double would only agree with itself.
 */

const READY: DbStatus = { state: "ready", storage: "memory", appliedVersions: [], schemaVersion: 11 };

let db: TestDatabase;
let projectId: string;
let documentId: string;

beforeEach(() => {
  db = openTestDatabase();
  projectId = COMMANDS.createProject(db.adapter, { title: "The Lighthouse" }).id;
  documentId = COMMANDS.createBinderItem(db.adapter, {
    projectId,
    parentId: null,
    type: "document",
    title: "Chapter One",
  }).id;
  COMMANDS.saveDocument(db.adapter, { projectId, id: documentId, content: doc("one"), searchText: "one", wordCount: 1 });
  // Pretend the create and that first write synced, at version 4.
  db.adapter.run("DELETE FROM pending_change;");
  db.adapter.run("UPDATE document SET version = 4 WHERE id = ?;", [documentId]);
});
afterEach(() => {
  // Reads still in flight would reach a closed database.
  for (const timer of slowTimers) clearTimeout(timer);
  slowTimers.clear();
  db.close();
});
const slowTimers = new Set<ReturnType<typeof setTimeout>>();

const doc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

/** Another device's edit arriving in a pull, as the engine hands it to the replica. */
const pull = (text: string, version: number) =>
  act(async () => {
    await db.client.command("applyPull", {
      projectId,
      changes: [
        {
          id: version,
          entityType: "document",
          entityId: documentId,
          op: "update",
          data: { id: documentId, content: doc(text), word_count: 1, version, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-02-01T00:00:00Z" },
        },
      ],
      latestId: version,
      syncEpoch: 1,
    });
  });

const stored = () =>
  JSON.stringify(
    JSON.parse(
      db.adapter.query<{ content: string }>("SELECT content FROM document WHERE id = ?;", [documentId])[0]!.content,
    ),
  );
const queued = () =>
  db.adapter.query<{ base_version: number | null }>("SELECT base_version FROM pending_change;");

/**
 * A client whose reads take a moment, as the worker round trip does. The in-process
 * database answers before the editor says "clean", which hides what a read made after
 * the editor's own save sees.
 */
const slowReads = (ms: number) =>
  ({
    ...db.client,
    query: (sql: string, params?: never) =>
      new Promise((resolve) => {
        slowTimers.add(setTimeout(() => resolve(db.client.query(sql, params)), ms));
      }),
  }) as unknown as typeof db.client;

async function open(client = db.client) {
  render(
    <DatabaseContext.Provider value={{ db: client, status: READY }}>
      <SettingsProvider initial={DEFAULT_SETTINGS}>
        <DocumentEditor projectId={projectId} documentId={documentId} />
      </SettingsProvider>
    </DatabaseContext.Provider>,
  );
  // Looked up each time: the editor is rebuilt when the document arrives.
  await waitFor(() => expect(editorOf()?.getText()).toBe("one"));
  return editorOf()!;
}

// TipTap leaves the editor on the element it owns.
const editorOf = () =>
  (screen.getByRole("textbox", { name: "Manuscript" }) as unknown as { editor?: Editor }).editor;

const type = (editor: Editor, text: string) =>
  act(() => {
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, text);
  });

describe("a pull that changes the open document", () => {
  it("is shown, without being saved back or kept as an undo step", async () => {
    const editor = await open();

    await pull("two", 5);

    await waitFor(() => expect(editor.getText()).toBe("two"));
    // A programmatic update is not an edit: nothing queued, nothing to push.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(queued()).toHaveLength(0);
    expect(editor.can().undo()).toBe(false);
  });

  it("is not typed over: the next keystroke builds on the new text, based on the new version", async () => {
    const editor = await open();
    await pull("two", 5);
    await waitFor(() => expect(editor.getText()).toBe("two"));

    type(editor, "!");

    await waitFor(() => expect(queued()).toHaveLength(1));
    expect(editor.getText()).toBe("two!");
    expect(queued()[0]?.base_version).toBe(5);
  });

  it("leaves unsaved words alone, and their save is still based on what was seen", async () => {
    const editor = await open();
    type(editor, " mine");

    // Lands before the debounce fires, so the author's text is not yet in the replica.
    await pull("theirs", 5);
    expect(editor.getText()).toBe("one mine");

    // The save goes out against version 4: the server will call it a conflict and keep
    // the words in a copy, instead of this device quietly overwriting version 5.
    await waitFor(() => expect(queued()).toHaveLength(1), { timeout: 3000 });
    expect(queued()[0]?.base_version).toBe(4);
    expect(stored()).toBe(JSON.stringify(doc("one mine")));
  });

  it("leaves a save that went first alone: the pull skips the row, and the push conflicts as before", async () => {
    const editor = await open();
    type(editor, " mine");
    await waitFor(() => expect(queued()).toHaveLength(1), { timeout: 3000 });

    await pull("theirs", 5);

    expect(editor.getText()).toBe("one mine");
    expect(stored()).toBe(JSON.stringify(doc("one mine")));
    expect(queued()[0]?.base_version).toBe(4);
  });

  it("is adopted once a conflict copy has taken the author's text and the server's returns", async () => {
    const editor = await open();
    type(editor, " mine");
    await waitFor(() => expect(queued()).toHaveLength(1), { timeout: 3000 });
    await pull("theirs", 5); // skipped: unpushed writing outranks it

    // The push conflicted; the entry is cleared and the server's version comes back.
    const [taken] = COMMANDS.takePending(db.adapter, { projectId });
    COMMANDS.settlePush(db.adapter, { ids: [taken!.id], sent: [{ id: taken!.id, payload: taken!.payload }] });
    await pull("theirs", 5);

    await waitFor(() => expect(editor.getText()).toBe("theirs"));
    expect(queued()).toHaveLength(0);
  });
});

describe("a push accepted while the author keeps writing", () => {
  it("moves the base with it, so the next save is not a conflict with the author's own text", async () => {
    const editor = await open();
    type(editor, " a");
    await waitFor(() => expect(queued()).toHaveLength(1), { timeout: 3000 });

    // The server accepts it and gives it version 5.
    const [taken] = COMMANDS.takePending(db.adapter, { projectId });
    await act(async () => {
      await db.client.command("settlePush", {
        ids: [taken!.id],
        sent: [{ id: taken!.id, payload: taken!.payload }],
        applied: [{ entityType: "document", entityId: documentId, version: 5 }],
      });
    });
    type(editor, " b");

    await waitFor(() => expect(queued()).toHaveLength(1), { timeout: 3000 });
    expect(queued()[0]?.base_version).toBe(5);
  });
});

describe("the editor's own save, read back by the change handler", () => {
  it("is not an edit to the editor: no setContent, so no transaction and no cursor jump", async () => {
    const editor = await open(slowReads(5));
    const transactions = vi.fn();
    editor.on("transaction", transactions);

    type(editor, " mine");
    await waitFor(() => expect(queued()).toHaveLength(1), { timeout: 3000 });
    await new Promise((resolve) => setTimeout(resolve, 200));

    // The one transaction is the keystroke.
    expect(transactions).toHaveBeenCalledTimes(1);
  });

  it("does not move the base to a version the author never saw", async () => {
    const editor = await open(slowReads(5));
    type(editor, " mine");
    await waitFor(() => expect(queued()).toHaveLength(1), { timeout: 3000 });
    await new Promise((resolve) => setTimeout(resolve, 200));

    // The push conflicted: entry cleared. The author writes on, and another device's
    // version 5 is pulled in before the autosave fires; the editor keeps its text.
    let [taken] = COMMANDS.takePending(db.adapter, { projectId });
    await act(async () => {
      await db.client.command("settlePush", { ids: [taken!.id], sent: [{ id: taken!.id, payload: taken!.payload }] });
    });
    type(editor, " more");
    await pull("theirs", 5);
    await waitFor(() => expect(queued()).toHaveLength(1), { timeout: 3000 });
    expect(queued()[0]?.base_version).toBe(4);
    await new Promise((resolve) => setTimeout(resolve, 200)); // the save's echo is read back

    // Conflicted again, and the follow-up pull has not landed: the next save must still
    // claim version 4, or the server accepts it and version 5's text is gone.
    [taken] = COMMANDS.takePending(db.adapter, { projectId });
    await act(async () => {
      await db.client.command("settlePush", { ids: [taken!.id], sent: [{ id: taken!.id, payload: taken!.payload }] });
    });
    type(editor, " x");
    await waitFor(() => expect(queued()).toHaveLength(1), { timeout: 3000 });
    expect(queued()[0]?.base_version).toBe(4);
  });
});
