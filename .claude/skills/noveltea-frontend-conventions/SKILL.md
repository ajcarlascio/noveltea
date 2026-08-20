---
name: noveltea-frontend-conventions
description: How to write code in the NovelTea client — state ownership, where sync state lives versus UI state, offline and error handling, testing approach, and the traps specific to an offline-first ProseMirror editor. Use when adding or reviewing any feature in this repository, especially anything touching the editor, the local database, or sync.
---

# NovelTea client conventions

Read `CLAUDE.md` first for the invariants; this file is how to honour them in ordinary
code. Where a rule below looks fussy, it is because the failure mode is silent — an
offline-first editor mostly fails by losing a little bit of an author's work much later.

## State ownership

There are exactly three kinds of state, and confusing them is the most common way this
codebase will rot.

**1. Durable, synced state — lives in SQLite, owned by `@noveltea/client-db`'s schema.**
Projects, binder items, documents, snapshots, labels, statuses, collections, compile presets,
comments. The UI reads it through `src/data/`; the UI writes it through commands in
`src/data/` that perform the local transaction *and* `enqueueChange()` in the same step. If
a write happens without a queue entry, the change exists on one device forever and nobody
finds out.

**2. Durable, local-only state — `local_config`.** Per-device preferences and bookkeeping:
last opened project and document, expanded binder folders, wifi-only sync, editor
typography, window size. This table is client-only and never syncs, which is correct — a
phone and a desktop should not fight over sidebar width. It is **not** a credential store;
tokens go to platform secure storage.

**3. Ephemeral UI state — in memory.** Selection, hover, drag-in-progress, dialog open,
scroll offsets, editor focus. A small store (Zustand or equivalent, MIT) is fine here. It is
a cache and a view; it is never the source of truth, and it is never the thing that decides
what gets saved.

**The rule: SQLite is the source of truth. The in-memory store is a projection of it.** When
data changes, it changes in the database first and the UI follows. Do not build a store that
holds the binder tree and writes through to the database "eventually" — that is a second,
lossy replica inside the replica.

Query layer: keep all SQL in `src/data/`. Components call named queries and commands
(`useBinderTree(projectId)`, `renameItem(id, title)`), never SQL and never the database
handle. This is what makes it possible to swap the web worker adapter for the Tauri one, and
what makes the queries testable without a UI.

## Sync state versus UI state

Sync progress is durable state, not view state. `sync_state` (cursor, last synced at, last
attempt, last error) and `pending_change` (the outbound queue) are **tables**, and the UI
observes them exactly the way it observes documents. Do not mirror them into the in-memory
store as a parallel truth, and do not have the sync engine push status events into React.

Concretely:

- "3 changes waiting" is `SELECT count(*) FROM pending_change WHERE project_id = ?`.
- "Last synced 4 minutes ago" is `sync_state.last_synced_at`.
- "Something is wrong with sync" is `sync_state.last_error` being set — displayed as a quiet
  status affordance the author can open, never a dialog.
- **The sync engine is the only writer of `sync_state`.** The UI never writes it; if the UI
  needs to affect sync, it calls `sync()` or sets a preference in `local_config`.

Connectivity itself (online/offline, wifi versus cellular) is ephemeral platform state and
belongs in memory, supplied by `src/platform/`. Never persist it — a stale "offline" flag in
the database outlives the condition.

## Offline and error handling

**Offline is the normal state, not an error state.** The app does not have an "offline mode"
that it enters; it has a sync engine that sometimes succeeds. Design every screen as if the
server does not exist, then add the small number of affordances that need it.

- **Never show a full-screen error, blocking spinner or modal because a request failed.** The
  data is local; the screen renders.
- **Only three failures deserve the author's attention**, because only these three are
  actionable: a conflict copy waiting to be reconciled, credentials that no longer work on a
  server (re-authenticate), and a server URL that no longer resolves (check the address).
  Everything else is `last_error` plus a quiet indicator.
- **Features that genuinely require the server** — compile, pairing a device, restoring a
  snapshot body that has not been fetched, sharing — say so plainly when offline and offer
  the action for later where that is meaningful. They do not present a generic failure.
- **A `501` is a supported answer**, not a bug: the operator's server is Core and does not
  have that commercial module. Detect capability and do not offer what the server cannot do;
  if attempted, the message names the reason.
- **HTTP status meanings that are easy to get wrong here**: `401` — refresh once, then
  re-authenticate; `403` — authenticated and genuinely not permitted; `404` — may mean "not
  yours", so never render it as "this was deleted"; `409` — stale version on a direct REST
  write, take the sync path; `413` — the request exceeded the server's 32MB ceiling, which for
  a single enormous document is a real case and needs a real message.
- **Auth failure messages are deliberately identical** on the server so login is not an
  account-enumeration oracle. Do not try to interpret them for the user, and do not
  auto-retry credential endpoints — they are the only rate-limited routes.
- **Never log tokens**, and never let one reach `sync_state.last_error`, which is stored in
  plain text in a file users copy around.

## Editor traps

These are specific to this app and each one has cost somebody a manuscript somewhere.

**Flush before you disappear.** Autosave is debounced, so there is always a window where the
newest keystrokes are only in editor state. Flush on blur, on route change, on unmount, on
`visibilitychange`/`beforeunload` in the browser, and on the Tauri lifecycle events for
backgrounding and window close. A debounce with no flush loses the last few seconds of every
writing session, which is exactly the part the author remembers writing.

**A pull can land on the document the author has open.** The sync engine writes to the
`document` row while somebody may be typing in it. Rules:

- If a `pending_change` exists for that document, **do not touch the editor's content.** The
  local version is unsent work; let the next push produce a conflict copy if the server has
  moved on. Silently swapping in the remote version destroys unsynced writing with no trace.
- If there is no pending change and the editor is not dirty, adopting the incoming version is
  safe — but do it visibly (a brief "updated from another device") rather than having
  paragraphs change under the cursor.
- Never reload the editor from the database on every query invalidation. **The open document
  is owned by the editor** for as long as it is open.

**`baseVersion` comes from the last successful sync, never from a local counter.** Repeat
edits coalesce into one queue entry, and the coalescing preserves the original
`base_version`. Never recompute it, never bump it locally, and never write `pending_change`
with raw SQL — `enqueueChange()` exists to enforce this.

**Ids are client-generated for offline creates.** An author creating a chapter on a plane
cannot ask the server for an id, so generate a UUID locally and use it as the entity id in
the `create` push (the server reports `duplicate_create` if it ever collides). Never expose
SQLite's `AUTOINCREMENT` rowids as entity ids — they are local queue ordering and nothing
else.

**Order keys are strings.** Reordering the binder generates a new key with the
`fractional-indexing` algorithm (MIT). Do not compute midpoints of numbers: floats run out of
precision after roughly fifty consecutive inserts between the same two siblings, and then
drags silently stop working.

**Comment anchors are quoted text plus offsets, and the text wins.** ProseMirror positions
shift with every edit. An anchor whose quoted words are gone is reported *orphaned* — never
silently relocated. Moving an editor's note onto the wrong sentence is worse than admitting it
lost its place.

**Large documents are a supported case.** Some authors keep an entire novel in one document;
200,000 words is several megabytes of ProseMirror JSON. Do not do full-document work on every
keystroke — word counts, outline extraction and search indexing are debounced, incremental, or
run off the main thread. Do not re-render the whole document tree on every transaction.

**Word counts must agree with the exporter.** Use the same text extraction the server's
`@noveltea/compile` uses rather than a second walker, or the editor's count and the compiled
manuscript's count will differ and the author will be right to complain.

**Clocks are not authoritative.** Tree conflicts are last-write-wins by *server* timestamp.
Never resolve anything by comparing local `Date.now()` values across devices. Timestamps
stored locally are ISO-8601 UTC text, which sorts correctly as text; keep them that way.

**Trash is a move.** "Delete" reparents to the trash node; the item keeps syncing and stays
restorable. Only "empty trash" tombstones. Do not build a UI that implies deletion is
immediate or that trashed items have left the device.

## Database handling

- **Run migrations once, at startup, before any query.** `runMigrations()` from
  `@noveltea/client-db`, on the single writer connection.
- **`applyConnectionPragmas()` on every connection you open.** `PRAGMA foreign_keys` is
  per-connection and defaults *off*; a connection that forgets it disables every cascade in
  the schema, and nothing complains.
- **One writer.** On the web, SQLite lives in a Web Worker (OPFS synchronous access handles
  exist only there) and every caller goes through it. Do not open a second writer "just for
  sync".
- **Local reads are async because of the worker boundary, not because of the network.** Treat
  them as effectively instant in the UI's design — no skeletons, no spinners, no "loading
  your chapter".
- **Never write DDL here.** Schema changes land in `@noveltea/client-db` in the server repo.
  If a feature needs a column, that is a cross-repo change and the sequencing matters.

## Testing

### When a test fails, suspect the code

A red test is a claim about the code, and the claim is usually right. Investigate it before
touching the test. Loosening an assertion or deleting a case to get back to green throws away
the evidence — the bug stays, and now nothing will ever catch it.

Change a test only when you can state exactly why the old expectation was wrong, and put that
reason in the commit message. "Adjusted the test" is not a reason.

### Prove each test can fail

While writing it, break the thing it covers — delete the guard, invert the condition, return
the wrong value — and confirm it goes red. A test that survives that is testing nothing, and
you will not find out later.

Watch for the two shapes that fool people:

- **A fixture that does not match the test's name.** The server repo shipped discarded
  chapters into manuscripts behind a test called "trashed items are excluded" whose fixture
  used a tombstone instead of a trashed item.
- **A test that silently narrows itself.** An authorization sweep there skipped every route
  whose parameters it could not fill, and claimed in its own comment to catch exactly the
  thing it was no longer checking. If a test can skip, make skipping fail it.

### Assert on outcomes, not on self-reports

Read the local database back rather than trusting the return value of the function under
test. A defect that corrupts the write path and the read path together satisfies any
assertion that just asks the code what it did.

For anything touching the editor, assert on the resulting document JSON — that is what
syncs and what compiles, and it is what the server and the compiler will see.

### Guards worth writing, and testing

Ordinary: offline, expired token, server unreachable, server 5xx, malformed response,
storage full or unavailable.

Specific to this app, each of which an author will hit:

- a resync arriving while a document is open and dirty
- a conflict copy created for the document currently on screen
- a comment whose anchor text has gone (orphaned, never relocated)
- a queue entry re-queued while in flight — the payload updates, `baseVersion` must not
- a compile the user navigated away from before it finished
- a document larger than the server will accept
- two windows of the same app open on one local database

**Test against a real SQLite database.** `@noveltea/client-db` runs on `node:sqlite` with no
build step, so tests get the real schema, the real constraints and the real triggers. Mocking
the data layer mocks away everything worth testing — coalescing, cascades, FTS triggers,
`STRICT` typing.

**Fake the server, not the database.** Sync tests drive the engine against a scripted HTTP
double that can return exactly the awkward answers: `resyncRequired`, `hasMore` chains,
partial `applied`/`conflicts` splits, `not_implemented`, a bumped `syncEpoch`, a 401 mid-run.
Each of the server behaviours listed in `CLAUDE.md` deserves a test that fails when the
handling is removed.

Cases that must exist before sync is considered done:

- A forced resync resumes at the returned `latestId`, not 0, and does not loop.
- A resync **keeps** the outbound queue.
- The cursor never advances past the `latestId` actually served.
- A coalesced queue entry keeps its original `base_version` after many edits.
- `create` then `delete` collapses only while `attempts = 0`.
- A `version_mismatch` surfaces a conflict copy in the binder rather than being swallowed.
- A `not_implemented` conflict parks the entry instead of retrying forever.
- A pull carrying a document the author has open with pending local edits does not overwrite
  the editor.

**The default fixture has no server.** If a component's test needs one to render, the
component has broken the first invariant — fix the component, not the test.

**Inject the clock.** The sync trigger is a fifteen-minute stability window; nothing should
ever `sleep` in a test.

**Editor tests use a real ProseMirror/TipTap instance** over a fixture document, asserting on
resulting document JSON rather than on DOM structure. The JSON is the contract; the DOM is an
implementation detail that differs between the four webviews this ships in.

**End-to-end tests run offline first.** Launch, write, reorder, search, reopen — all with no
server reachable — then bring a server up and assert the queue drains. That is the product's
actual promise, and it should be the test that runs on every commit.

## Style

- TypeScript strict. No `any` in `src/data/` or `src/sync/`; those are where a wrong type
  becomes wrong data on disk.
- Comment the *why*, not the what, and especially comment anything that looks removable but
  is load-bearing — the pragma call, the flush-on-unmount, the preserved `baseVersion`. Those
  are the lines a future reader will delete while tidying.
- Prefer boring, obvious code in `src/data/` and `src/sync/`. Cleverness belongs in the
  editor, if anywhere.
