# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## Project status

**Scaffolded through the local replica.** The build, routing, theme system and the offline
SQLite replica exist and are covered by tests; sync, the editor and the binder do not.
Paths, module names and commands below still describe the *intended* layout in the parts
that are not built — check that a thing exists before relying on it, and prefer extending
this file over inventing a parallel convention.

The design of record for the protocol, the data model and everything server-side is
`docs/design/v1-data-model-api.md` and `CLAUDE.md` in the
[`noveltea-server`](https://github.com/ajcarlascio/noveltea-server) repository. When this
file and the server disagree, the server is right and this file is stale — fix it.

## What this is

The client for NovelTea, a self-hosted, offline-first writing app for novelists.
Scrivener-shaped: a binder tree of folders and documents, snapshots, labels and statuses,
custom metadata, saved and smart collections, compile presets and export.

One TypeScript web codebase, shipped three ways: as a browser application, and wrapped by
**Tauri v2** for desktop (Windows/macOS/Linux) and mobile (iOS/Android). The reasoning —
including why this is not React Native — is in `docs/architecture.md`. Do not re-open it
casually; do read it before proposing a native module.

## The invariants

Everything else in this file is detail. These eight are the design; breaking one is a
design regression even when the tests pass.

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
   exported manuscript months later. (See "The editor" — there is already a live mismatch.)

3. **Tokens never go in SQLite.** Access and refresh tokens live in platform secure storage
   (Keychain, Keystore, DPAPI/credential manager, libsecret via Tauri). The local database
   is an unencrypted file on disk that gets copied, backed up and synced by other tools; it
   holds the author's work, not their credentials. `local_config` in `@noveltea/client-db`
   says so in a comment, and it means it.

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

## Architecture

Four layers, and the dependency arrows only ever point downward.

```
  UI (React components, routes, editor views)
        |  reads via queries, writes via commands — never imports the transport
  Domain / data access (typed queries and commands over the local DB)
        |
  Local store (SQLite: @noveltea/client-db schema + migrations)
        ^
        |  the ONLY other writer
  Sync engine (@noveltea/sync — pull/push, cursor, queue, conflicts)
        |
  Server (HTTP, bearer JWT)
```

The important property of that picture: **the UI and the sync engine meet at the database,
not at each other.** The editor saves a document to SQLite and enqueues a pending change;
the sync engine, whenever it next runs, pushes what it finds. Neither knows the other
exists. This is what makes offline-first hold under pressure — there is no code path where
the interface is waiting on the network, because there is no code path from the interface to
the network at all.

Sync progress is state *in the database* (`sync_state`, `pending_change`), so the UI
observes it the same way it observes everything else. It is not a separate in-memory
subscription that has to be kept in step.

### Intended module layout

```
src/
  app/          routing, shell, providers
  ui/           presentational components — no data access
  features/     binder, editor, snapshots, collections, compile, merge, settings
  data/         queries and commands over the local DB; the only place SQL lives
  db/           connection, worker bootstrap, migration run on startup
  sync/         thin adapter wiring @noveltea/sync to this shell's storage and transport
  platform/     the shims that differ per shell (secure storage, fs, network state)
src-tauri/      the Tauri v2 shell, once it exists
```

`platform/` is the only place allowed to branch on which shell it is running in. Everything
above it takes a capability, not a platform name. A `if (isTauri)` in a feature module is a
missing abstraction in `platform/`.

## The editor

**TipTap core (MIT) on top of ProseMirror.** TipTap is a large reduction in code over raw
ProseMirror for the things this app needs constantly — schema declaration, commands,
keymaps, input rules, React integration — and it does not hide ProseMirror: the `EditorView`,
transactions, plugins, decorations and node views are all still reachable, and NovelTea will
reach for them (comment anchors, merge-view decorations).

Rules:

- **`@tiptap-pro/*` is forbidden.** It is a gated paid registry and it disqualifies the
  build for a self-hoster. Some extensions you will want (drag handles, unique node ids,
  table of contents) have lived behind that scope. When one is needed, write it against the
  ProseMirror API — they are plugins, not magic — and keep it in this repo.
- **The editor does not talk to the backend.** It reads and writes document JSON. Saving is
  a debounced local transaction plus `enqueueChange()`; that is the whole integration.
  Anything that looks like fetching from within an extension is a mistake.
- **Node and mark names are contract, not preference.** Renaming a node is a data migration
  affecting every stored document and the server's exporter, not a refactor.

**The live mismatch, which must be settled before any manuscript exists.** The server's
`packages/compile` recognises the marks `strong` and `em` (the `prosemirror-schema-basic`
names). TipTap's StarterKit emits `bold` and `italic`. Wired together untouched, bold and
italic would arrive at the compiler as *unknown marks*: the compiler's rule is to keep the
text and drop the formatting with a warning, so manuscripts would export as plain prose and
nothing would fail loudly. `compile` also currently accepts both `bulletList` and
`bullet_list`, which is proof that no canonical set has been pinned. Fix this by extracting
a shared schema package in the server repo that both sides derive from, and by adding a test
that asserts the editor's generated schema matches the compiler's accepted set. Do not fix
it by quietly renaming things on one side.

Also from the compiler, and worth knowing before adding an editor feature: **only text is
exported.** Images and embeds warn and contribute nothing, and **synopses and notes are
never exported under any option** — they are the author's scaffolding, not the book. If you
add a node type the compiler has never met, add its handling there in the same change.

## The local store

`@noveltea/client-db` (from the server repo) owns the schema, the migrations and the pending
queue. Read its README before touching anything near it. Three things that cause silent data
loss:

- **`PRAGMA foreign_keys` is per connection, and SQLite defaults it off.** Any connection
  that forgets it silently disables every `ON DELETE CASCADE`. Call `applyConnectionPragmas`
  on every connection you open.
- **`pending_change` holds at most one row per entity** and is a state machine, not a log.
  Always go through `enqueueChange()`; a raw INSERT breaks the coalescing rules and the
  `base_version` guarantee.
- **`markAttempted()` runs before the push, never after.** If a push is applied and the
  response is lost, an entry that was never marked can be dropped locally while the server
  keeps the row — a deleted item that comes back on the next pull as a ghost.

Full-text search is FTS5 with an external-content table and triggers. The triggers are
mandatory: an external-content FTS5 table does not maintain itself. Search is local, which
is why an offline author can still find their scene.

**Where the database runs.** On the web, OPFS synchronous access handles are only available
inside a Web Worker, so SQLite lives in a worker and the UI talks to it over
`postMessage`. That means local reads are *asynchronous* even though they never touch the
network — do not mistake that async boundary for a reason to reintroduce loading states on
the read path; it is sub-millisecond and should be treated as synchronous by the UI's design
even where the types are promises. Under Tauri, the same interface is served by a native
SQLite binding. The adapter shape (`exec`, `query`) is deliberately tiny so both fit.

### How it is wired here

```
src/db/open.ts        opens SQLite over OPFS
src/db/adapter.ts     sqlite-wasm -> the SqliteAdapter client-db migrates through
src/db/dispatch.ts    the worker's behaviour, worker globals factored out so it is testable
src/db/worker.ts      the worker itself: wiring, nothing more
src/db/client.ts      main-thread request/response, one promise per request
src/data/*            the only place SQL lives
```

- **Never hand-write DDL.** The schema is `@noveltea/client-db`, pinned as a git submodule
  at `vendor/noveltea-server` and consumed as an npm workspace. Its generated migration
  bundle is gitignored upstream and regenerated by `npm install` through that package's own
  `prepare` script. A schema change belongs in the server repo, then a submodule bump here.
- **`@sqlite.org/sqlite-wasm`, not `wa-sqlite`.** wa-sqlite's npm package declares no licence
  (`license: None`, no repository field), which fails this repo's MIT/Apache-2.0/BSD rule.
- **The SAH Pool OPFS VFS, not the plain one.** The plain VFS needs `SharedArrayBuffer`,
  hence COOP/COEP headers, which a self-hoster behind an arbitrary reverse proxy may not
  have set. Getting it wrong takes persistence away from the author silently.
- **A request must always settle.** Requests arriving before the database opens are queued;
  if opening fails the queue is drained *as failures*. A dropped request leaves a promise
  pending forever, which an author reads as "still saving". Same reason `DatabaseClient`
  rejects every in-flight request when the worker dies or is closed.
- **An in-memory fallback is reported in the interface**, never only to the console.
  `StorageWarning` exists for that one condition.
- **Errors are flattened across the worker boundary** (`toErrorPayload`). Structured clone
  keeps `message` and `name` and drops everything else, so what survives is stated
  explicitly rather than left to chance — retry decisions depend on which error it was.
- **`data-db-*` attributes on `<html>` are load-bearing**, not debug leftovers. They are how
  the end-to-end tests tell a persisted database from a fresh one without the app exposing a
  test-only handle that would also exist in production.

**Unit tests cannot see OPFS.** They run the real migrations and the real SQL against real
SQLite via `node:sqlite`, which catches a wrong column name but would pass just as happily
against an in-memory fallback. `npm run test:e2e` covers exactly that gap: it asserts the
second visit applies **zero** migrations, which is only true if the database file survived.


### Cross-platform and security rules the tests enforce

One bundle runs in a browser tab, a desktop window and a phone webview. These are checked by
`e2e/`, not by review:

- **44px minimum hit area under a coarse pointer**, and **nothing wider than the screen**.
  The overflow check walks every box and every scroll pane — `documentElement.scrollWidth`
  cannot grow here, because the app's scroll container is the main pane.
- **`100dvh` not `100vh`**, safe-area insets with `viewport-fit=cover`, `accent-color` from
  the palette, `rem` body text, `overscroll-behavior`, and a skip link first in tab order.
- **The CSP is generated at build time** with computed inline-script hashes
  (`build/csp-plugin.ts`). `'wasm-unsafe-eval'` is required by sqlite-wasm; `worker-src`
  covers both workers; `connect-src` is open because the server address is chosen by the
  author. `frame-ancestors` is deliberately omitted — a `<meta>` policy cannot express it,
  and a `<meta>` policy does not reach worker contexts at all. Full coverage needs response
  headers from whoever serves the build.
- **No Node built-ins in app code**, enforced by ESLint. `src/test/**` is exempt; those
  helpers run under Node.

### The editor

- **The schema is a contract with `packages/compile`.** A node or mark it has not met is
  flattened to plain text on export. `schema.node.test.ts` reads compile's source from the
  submodule and fails on drift. Adding an extension means checking compile first.
- **`role="textbox"` + `aria-multiline` are required**: `contenteditable` alone computes as
  `generic`, so nothing announces the manuscript as editable.
- **Autosave must flush on pause, on leaving the document, and on `visibilitychange` /
  `pagehide`.** A reload or a backgrounded tab does not unmount React. A failed save keeps
  its payload.
- **Link protocols are an allowlist** matching the server's, and it is tested through a real
  editor rather than by reading configuration.

### The binder in this client

- **Writes go through `DatabaseClient.command`**, never assembled from `run` calls here. A
  binder edit changes a row *and* queues a `pending_change`, and they must commit together;
  `enqueueChange` is synchronous, so the work happens in the worker. Re-implementing its
  merge rules against the async client would be a second copy of them.
- **`src/data/order.ts` is a port of the server's `FractionalIndex`** and must stay
  digit-identical. Conformance vectors in `src/data/__fixtures__/` are generated from the
  Java by `tooling/generate-order-vectors.sh`; drift fails nowhere else and reorders a book
  differently on each device.
- **Re-trashing must not overwrite `trashed_from_parent_id`**, and **restoring a live item
  is a no-op** — both are real defects the server hit, and the client repeats the rules
  because it applies them offline with no server to catch it.
- **Every reparent runs the recursive descendant check.** On the client a cycle is an
  immediately lost subtree, with nothing upstream to refuse it.
- **`FractionalIndex` grows appended keys linearly** (~1 character per 5 appends; 2000
  appends give a 400-character key of `zzzz…`). The published algorithm's length-prefixed
  integer part would keep them at O(log N). Correct but costly, and cheapest to fix on the
  server before real binders exist. The current numbers are pinned in `order.node.test.ts`.
- **Icons are inline SVG, not emoji.** Emoji come from whatever font the platform ships:
  different on every OS, inconsistently sized, and an empty box where the font is missing.

## The sync engine

**A library, not a service.** It runs inside the client process. A sync *service* sitting
between client and server would put a network hop back on the read path, which is exactly
the thing offline-first exists to remove.

**It belongs in the server repo**, as `@noveltea/sync` alongside `@noveltea/client-db`,
because it is coupled to the wire protocol and to the local schema — both of which the
server owns. A third repository would recreate the cross-repo drift problem that put
`client-db` in the server repo in the first place. It must have **no UI dependencies at
all**: no React, no DOM, no bundler assumptions. The same engine runs under the browser
shell, the Tauri shells, and headless in tests.

Until it exists there, do not build a rival implementation here. Write the adapter surface
(`src/sync/`) against the interface it will have.

### What it must handle

The server's actual behaviour, which the engine has to respect exactly:

- **Pull is paginated by a cursor.** `GET /api/v1/projects/{id}/sync?since=<id>&limit=&epoch=`
  returns `{ changes, latestId, hasMore, resyncRequired, syncEpoch }`. `latestId` is the
  highest id *actually served*, never the table maximum — advance the cursor to that and no
  further, or unserved rows are skipped permanently. Loop while `hasMore`. Pages are bounded
  by rows **and** by bytes (4MB), which is what makes a page predictable on mobile data.
- **`resyncRequired` means the cursor is unusable.** It fires when the cursor has fallen
  behind a retention purge, or when `syncEpoch` changed (an operator restored a backup — the
  server has moved *backwards* under a client whose cursor is past the restored maximum).
  The response is not "retry": discard the cursor, rebuild local state from `GET /binder`
  plus the documents, and resume at the `latestId` the server returned. **Resuming at 0 puts
  the client straight back into a resync, forever.** A resync must not discard the outbound
  queue — those are the author's unsent edits.
- **Push is optimistic-concurrency, per change.**
  `POST .../sync` with `{ since, changes: [{ entityType, entityId, op, baseVersion, data }] }`
  answers `{ applied: [{ entityId, entityType, version }], conflicts: [...], latestId }`.
  Both lists matter: applied entries carry the new server version, which becomes the entity's
  next `baseVersion`. Clear queue entries only for ids that actually appear in `applied`.
- **Conflicts are per change, with a reason**: `version_mismatch`, `duplicate_create`,
  `entity_missing`, `invalid_request`, `not_implemented`. A `version_mismatch` on a document
  carries `conflictCopyId` — the server has already created a sibling binder item holding
  the author's rejected text. The author has lost nothing; they have gained a second item and
  need to be told. `not_implemented` means the server does not yet accept that entity type
  (today only `binder_item` and `document` are writable): **do not retry it in a loop.** Park
  the entry and surface it, or the queue spins forever.
- **Conflict copies are linked by foreign key**, `conflict_of_id` with
  `conflict_base_version` — never by title. Titles are author-editable and ambiguous the
  moment two copies exist.
- **Trigger: 15 minutes of *stable* connectivity.** A connectivity monitor starts the timer
  on regaining a connection and only fires if it holds for the whole window, resetting on
  every drop. Manual "sync now" always overrides. The owner also wants a **wifi-only**
  setting, plus a clear warning before syncing over mobile data — first sync of a novel is
  measured in megabytes.
- **Snapshots sync as metadata only.** The feed carries a snapshot row without its `content`;
  fetch the body from `GET /snapshots/{id}` when the author actually opens it. Automatic
  snapshots do not sync at all — they are local, and the UI must not imply otherwise.
- **The client supplies `document.search_text` on push.** The server cannot parse ProseMirror
  by design, so server-side search depends on the client extracting plain text and sending
  it. Use the same extraction the compiler uses, not a second walker.

### Failure handling

Sync failing is normal, not exceptional — it is the expected state of an offline-first app
most of the time. A failed sync writes `sync_state.last_error` and backs off. It never
raises a dialog, never blocks the editor, and never drops queue entries. The only failures
that deserve the author's attention are the ones they can act on: a conflict copy to
reconcile, an expired session on a server they must re-authenticate to, and a server URL
that no longer resolves.

## Auth

Bearer JWT, issued per device. `POST /auth/register|login` for the first device;
`POST /auth/pairing-codes` on a trusted device mints a short code that `POST /auth/pair`
redeems to onboard another. `POST /auth/refresh` rotates — **refresh tokens rotate on every
use**, so two clients sharing one refresh token will fight and lose; only the sync engine
refreshes, and it serialises.

- **401 means refresh, then retry once.** 403 means the caller is authenticated and still
  not allowed. 404 may well mean "exists but not yours" — do not render it as "deleted".
- **Every auth failure returns the same message** by design; do not try to interpret it into
  "no such user" versus "wrong password" in the UI. That would rebuild the enumeration
  oracle the server refuses to be.
- **Credential endpoints are rate limited** (login, register, refresh, pair); sync is not.
  Do not auto-retry a failed login.
- **Confirming a password reset signs every device out.** The client must handle "my tokens
  stopped working and that is correct" without losing unsynced local edits.

## Platform shells

One codebase, four webviews, and they are not the same browser. `contenteditable` is the
single most divergent area of the web platform, and this app is a `contenteditable` app.

- **macOS/iOS: WKWebView.** IME composition, autocorrect, and selection behaviour differ
  most here. Test on a real device before believing the simulator.
- **Windows: WebView2** (Chromium). Closest to the dev browser, therefore the one that hides
  bugs.
- **Linux: WebKitGTK.** The weakest and most variable across distributions.
- **Android: System WebView**, version varies by device and update state.

Consequences: keep editor behaviour on ProseMirror's abstractions rather than raw DOM
selection wherever possible, and never assume a keyboard event shape.

### Device detection versus webview divergence

These are two separate problems and only one of them has a library answer.

**Device and platform detection is solved.** `@tauri-apps/plugin-os` covers platform, arch
and version; community plugins such as `tauri-plugin-device-info` expose more (model, screen
metrics, battery). Either is fine for deciding *layout*: a phone gets a different binder
presentation from a desktop, and reading the device is a legitimate way to choose.

**Webview divergence is not solved by detecting the device.** Knowing you are on iOS does not
make WKWebView handle IME composition, autocorrect or selection the way WebView2 does. The
only remedy is to stay on ProseMirror's abstractions and to test the editor on real devices.
Do not reach for a device check to paper over an editor bug — that produces per-platform
branches in the most delicate code in the app, and they rot.

Rule of thumb: **device info decides what the interface looks like; it never decides how
the document behaves.** Layout branches on device are fine. Editing, sync and compile
behaviour must be identical everywhere, because the document is the same document.

Prefer CSS and container queries for anything that is really about size rather than
platform — a narrow desktop window and a tablet want the same layout, and a device check
would give them different ones.

## Open core, and what this client must tolerate

NovelTea's server is open core: some export formats, sharing, and cloud destinations live in
a private module the operator may not have installed. Core answers `501` with an upgrade
pointer for those.

**A 501 is a normal answer, not an error.** The client discovers what its server supports
and renders accordingly — an export format that is not available should not be offered, and
if it is attempted anyway the message is "this server does not provide that", never a stack
trace or a generic failure. Never hard-code the assumption that sharing exists; the
single-owner path is the only one Core has.

## Compile

Compile is asynchronous and server-side: `POST /projects/{id}/compile` returns a job id,
`GET /compile-jobs/{id}` reports status, then `/download` streams the artifact.

- **Warn before submitting, not after.** The compiler can report what a selection will
  actually produce before rendering anything — folders contribute a title at most, empty
  documents contribute nothing, trashed items are excluded, and synopses and notes are never
  exported. Show that plan up front; an author should learn that half their selection is
  folders before waiting on a long manuscript.
- **Polling is fine** — compile is the one workflow where waiting is legitimate, because the
  author explicitly asked for a long-running job. It is still not a reason to block the rest
  of the UI.
- Compile requires the server. Offline, the button explains that rather than failing.

## Binder semantics

- **Trash is a move, not a delete.** Trashing reparents to the project's trash node and
  records where the item came from; the item keeps syncing and stays restorable.
  `deleted_at` is the tombstone written when trash is emptied.
- **`order_index` is a lexicographic string, not a number.** Use the `fractional-indexing`
  algorithm (MIT) to generate keys for drags. Floats exhaust IEEE precision after ~50
  consecutive inserts between the same two siblings, and then reorders silently stop working.
- **The server prevents cycles**, but the client should refuse to drop an item into its own
  descendant in the drag layer too — a rejection after the drop looks like a broken UI.

## Commands

The schema lives in a submodule, so clone with `--recurse-submodules`, or run
`git submodule update --init --recursive` in an existing checkout. `npm run dev`, `build`
and `test` check for it first and say so rather than failing as a workspace resolution error.

```bash
npm install
npm run dev                # Vite dev server (browser client)
npm run build              # typecheck, then production bundle
npm test                   # unit tests (vitest)
npm test -- src/db         # one directory
npm run test:e2e           # Playwright, production build, real browser — the only OPFS coverage
npm run typecheck
npm run lint               # zero warnings tolerated
npm run licenses           # dependency licence audit — MIT/Apache-2.0/BSD only
```

Not wired up yet; prefer these names over inventing new ones:

```bash
npm run tauri dev          # desktop shell
npm run tauri ios dev      # macOS host only
npm run tauri android dev
```

Server side, in a `noveltea-server` checkout: `docker compose up -d` then
`./gradlew :api:bootRun`. Remember to list this client's dev origin in
`noveltea.cors.allowed-origins`.

## Testing

**A failing test is a claim about the code. Investigate the claim before you touch the test.**

This is the rule that matters most here, and it is easy to break under time pressure. When a
test goes red, the first question is "what is the code doing wrong?", not "how do I get this
green?". Loosening an assertion, widening an expected range, or deleting a case to restore a
green run destroys the only evidence you had. Change a test only once you can say precisely
why the old expectation was wrong — and then say so in the commit message.

**A test that cannot fail is worse than no test**, because it buys confidence it is not
paying for. The server repo learned this twice, expensively: a test named "trashed items are
excluded" built its fixture with a tombstone instead of a trashed item, so it passed against
genuinely broken behaviour that shipped discarded chapters into manuscripts; and an
authorization sweep silently skipped every route whose parameters it could not fill, while
its own comment claimed a forgotten check would fail it immediately.

So, before trusting any test you write:

- **Break the code on purpose and confirm the test goes red.** Delete the guard, invert the
  condition, return the wrong value. If it still passes, it is testing nothing. Do this while
  writing it, not later.
- **Check the fixture exercises the case in the name.** The trash bug above was entirely a
  fixture that did not match its own title.
- **Assert on the outcome, not on the implementation's own report.** Read the local database
  back rather than trusting what the function returned. A bug that corrupts writing and
  reading symmetrically survives any test that only asks the code what it did.
- **Never assert something that cannot be false** — no `expect(x).toBeDefined()` on a value
  the type system guarantees, no ranges wide enough to admit the bug.

**Guard deliberately, and test the guard.** Two kinds of failure need it: the ordinary ones
(offline, an expired token, a server that is down, malformed input) and the ones specific to
this app (a resync arriving mid-edit, a conflict copy for a document that is open, an
orphaned comment, a queue entry whose `baseVersion` was overwritten, a compile the user
navigated away from). Every one of those is a case an author will hit; each deserves a test
that fails without the guard.

Detail lives in `.claude/skills/noveltea-frontend-conventions/SKILL.md`. The shape:

- **Sync tests run against a real SQLite database and a faked server**, never against mocked
  local queries. The interesting bugs are in the interaction between the queue, the cursor
  and the server's answers — mocking the database mocks away the subject.
- **Every server behaviour listed above deserves a test that can fail**: a resync that
  resumes at `latestId`, a `version_mismatch` that produces a visible conflict copy, a
  coalesced queue entry that keeps its original `baseVersion`, a `not_implemented` that does
  not spin.
- **Offline is a test mode, not a scenario.** The default fixture has no server at all. If a
  feature's tests need one to render, the feature has broken invariant 1.

## Open questions

1. Where `@noveltea/client-db` comes from at install time — git dependency, submodule,
   private registry, or one workspace. Unresolved; see README.
2. Token storage in the browser, which has no OS keystore. May require a server change
   (`httpOnly` refresh cookie). See README.
3. The canonical node/mark name set and where the shared schema package lives.
4. Whether the merge view can be built before the server exposes a merge endpoint pair; the
   server's `MergeService` returns both documents and their provenance, and computes no diff
   — the diff is this client's job, and no library has been chosen.
5. Android in v1 or not.
6. Repository visibility and licence.
