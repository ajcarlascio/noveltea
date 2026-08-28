# Contributing

The rules that are not obvious from the code. Read this before changing anything in
`src/data/`, `src/sync/` or `src-tauri/`.

## The invariants

These eight are the design. Breaking one is a design regression even when the tests pass.

1. **The UI never awaits an HTTP call in order to render.** Screens read local SQLite. The
   network is exclusively the sync engine's business, and the sync engine runs in the
   background. A component that imports `fetch`, or an HTTP client, or the sync engine's
   transport, is a bug. If a feature seems to need a live request, it almost certainly needs
   a local read plus a sync trigger.

2. **The document schema is defined once.** Documents are ProseMirror JSON, and the server's
   `packages/compile` serialises that same JSON to txt/md/html. The node and mark names are
   a contract between the editor and the exporter. Define them in one shared, versioned
   place; never in a TipTap extension list that only this repo can see. A schema defined
   twice diverges silently, and the symptom is an author's italics vanishing from their
   exported manuscript months later.

3. **Tokens never go in SQLite.** The local database is an unencrypted file on disk that
   gets copied, backed up and synced by other tools; it holds the author's work, not their
   credentials. The access token stays in memory, and the exception rests on rotation,
   single use and the CSP together — see `docs/open-decisions.md`.

4. **The server URL is always configurable.** There is no hosted NovelTea. Every sign-in
   flow, on every platform, lets the user type or pick a server. Never hard-code one, never
   default to anything but the empty field (or `http://localhost:8080` in dev builds), and
   store the URL per account so one person can hold accounts on several servers.

5. **Never hand-write the local schema.** All DDL comes from `@noveltea/client-db`, whose
   migrations move in lockstep with the server's. If you need a column, the change lands in
   the server repo first. Never "just add a table" locally — a client-side schema fork is
   undetectable until it corrupts a replica.

6. **Never merge prose.** The server resolves document conflicts by creating a *conflict
   copy* — a sibling binder item holding the losing version. The client's job is to present
   the two versions and let the author choose; it is never to combine them. This is a
   permanent decision, not a v1 shortcut.

7. **`baseVersion` is remembered, never computed.** Every write carries the version this
   client last successfully *synced*, not a locally-incremented number. Get this wrong and
   every push looks conflict-free while quietly overwriting the other device's work.
   `@noveltea/client-db`'s `enqueueChange()` protects this; do not bypass it with raw SQL.

8. **The client authorises nothing.** It renders what the server sent and queues what the
   author changed. Hiding a button is a courtesy to the user, never a security control. All
   authorization decisions happen on the server, and a resource the caller may not see comes
   back as a 404, not a 403.

## Traps

Each of these has cost somebody a manuscript somewhere.

- **Flush before you disappear.** Autosave is debounced, so there is always a window where
  the newest keystrokes are only in editor state. Flush on blur, on route change, on
  unmount, on `visibilitychange`/`beforeunload`, and on the Tauri lifecycle events.
- **A pull can land on the document the author has open.** If a `pending_change` exists for
  it, do not touch the editor's content — that is unsent work, and swapping in the remote
  version destroys it with no trace.
- **Queue the whole row.** `pending_change` coalesces by replacing the payload, so a partial
  payload silently discards the fields it left out.
- **Order keys are strings.** Reordering uses fractional indexing. Numeric midpoints run out
  of float precision after about fifty inserts between the same two siblings, and then drags
  stop working with no error.
- **Trash is a move, not a delete.** A trashed item keeps syncing and stays restorable. Only
  "empty trash" tombstones.
- **`PRAGMA foreign_keys` is per-connection and defaults off.** A connection that forgets
  `applyConnectionPragmas()` disables every cascade in the schema, and nothing complains.

## Tests

**When a test fails, suspect the code.** A red test is a claim about the code, and the claim
is usually right. Loosening an assertion to get back to green throws away the evidence.
Change a test only when you can say exactly why the old expectation was wrong, and put that
reason in the commit message.

**Prove each test can fail.** While writing it, break the thing it covers — delete the
guard, invert the condition — and confirm it goes red. Two shapes have fooled this project
already: a fixture that does not match the test's name, and a test that silently skips the
case it claims to cover. If a test can skip, make skipping fail it.

**Assert on outcomes.** Read the local database back rather than trusting the return value
of the function under test; for anything touching the editor, assert on the resulting
document JSON, because that is what syncs and what compiles.

Tests run against a real SQLite database — `@noveltea/client-db` runs on `node:sqlite` with
no build step. Fake the server, never the database.

## Commands

```bash
npm test                    # unit tests (vitest)
npm run typecheck           # tsc over src and the Node-side config
npm run lint                # eslint, zero warnings tolerated
npm run build               # typecheck, then production bundle
npm run test:e2e            # Playwright, against the production build
npm run licenses            # dependency licence audit
```

## Branching

`main` is the released line. Work branches from the current release branch (`0.2`), and
merges back into it; the release branch merges to `main` once it has had full regression
testing. A fix for a released version (`0.1.1`) goes to the release branch first and reaches
`main` the same way, so `main` never gains a commit the release branch has not carried.
