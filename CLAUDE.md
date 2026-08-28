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
  (`tooling/csp-plugin.ts`). `'wasm-unsafe-eval'` is required by sqlite-wasm; `worker-src`
  covers both workers; `connect-src` is open because the server address is chosen by the
  author. `frame-ancestors` is deliberately omitted — a `<meta>` policy cannot express it,
  and a `<meta>` policy does not reach worker contexts at all. Full coverage needs response
  headers from whoever serves the build.
- **No Node built-ins in app code**, enforced by ESLint. `src/test/**` is exempt; those
  helpers run under Node.

### Search and compile

- **Never pass author input to FTS5.** It raises syntax errors on a stray quote; the
  query is tokenised and rebuilt in `toFtsQuery`. An empty query means no results,
  never all of them.
- **Anything showing database state must subscribe to `subscribeToChanges`.** Search
  results, the binder and the pending count are all snapshots otherwise.
- **Unavailable export formats are shown, not hidden.** Open core: a missing format is
  an upgrade, and hiding it makes the interface lie about the software.
- **The compile download is fetched with the bearer token**, not linked — a plain
  `<a href>` sends no headers and downloads a 401 page. Revoke the blob URL.

### Sync

- **Pull before push.** Pushing into a stale picture resurrects what another device
  deleted.
- **The cursor is `latestId`, and an empty page advances it too.** A resync resumes at
  `latestId`, never at 0 — a purged server answers `resyncRequired` for any cursor
  below its purge point.
- **A resync must not wipe the replica.** There is no endpoint returning a document's
  current body, so local prose is the only copy of anything not changed recently.
- **`version_mismatch` clears the queued change**; retrying breeds conflict copies.
  Only `not_implemented` stays queued.
- **`markAttempted` before the push, never after**, or a lost response resurrects a
  deleted item as a ghost.
- **`DatabaseClient` announces writes, not reads.** `READ_ONLY_COMMANDS` exists because
  a read that announces a change wakes whatever just performed it, and the page spins.

### Accounts

- **Signing in is not a gate.** The replica is local and complete; the app works signed out
  and sign-out never touches the database. Anything that makes writing wait on an account
  contradicts the rule the client is built on.
- **Offline is not signed out.** Only a server *rejecting* the refresh token ends a session.
  A `ServerUnreachable` must leave it exactly as it was.
- **One renewal at a time, and one retry per 401.** Refresh tokens rotate on use; concurrent
  renewals invalidate each other and lock the app out.
- **One message for every rejected credential.** The server refuses to be an enumeration
  oracle; the client must not undo that.
- **The access token is memory-only; the refresh token is persisted.** That exception rests
  on rotation, single use, and the CSP — see the README before loosening any of the three.

### Anything that leaves the device

- **`mayUseNetwork(settings, feature)` is the only gate**, and it checks the switch and the
  consent record independently. Local storage is hand-editable; `parseSettings` also refuses
  to return an enabled-but-unconsented state. Two checks on purpose.
- **Consent is read at call time, never captured at construction**, so withdrawing takes
  effect on the next request rather than the next reload.
- **Local providers are tried first.** A lookup answerable on the device is never a reason
  to tell a third party what someone is writing.
- **Results carry `wasNetworked`** and the interface shows it. An author always knows which
  answers were private.
- **API keys never touch localStorage, IndexedDB or the replica.** Server-held, OS keychain
  under Tauri, or session memory on the web — in that order. See the README.

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

### WebKitGTK has no OPFS, so the desktop shell keeps the database itself

Measured, not assumed: `tooling/webview-probe` runs the built app in webkit2gtk-4.1 —
the engine Tauri uses on Linux — and reads the app's own `data-db-storage`. On
**WebKitGTK 2.52.3** (current, August 2026) `navigator.storage` is absent **entirely**,
so there is no OPFS, so the replica opens in memory and every word is lost on restart.
`isSecureContext` is true and `indexedDB` works, which rules out a secure-context gate.

Do not use Playwright's WebKit to answer this. It is a deliberately minimal build with
no storage APIs at all, and reasoning from it produced the wrong answer twice — once
asserting the conclusion and once doubting it, neither with evidence.

So under Tauri:

- The webview holds the database **in memory**, and the file lives on the host.
- Rust exposes exactly two commands, `db_load` and `db_save`. They know no SQL and no
  schema. Everything that understands the database stays on the other side of that
  boundary, where it is already tested against real SQLite.
- `db_save` writes to a temp file, `sync_all`s it, then renames. A rename within one
  directory is atomic everywhere this ships, so a crash mid-write leaves the previous
  database intact — and a half-written SQLite file is not a database that lost recent
  edits, it is one that will not open. The `sync_all` is the part that is easy to leave
  out and useless to leave out: without it the rename can reach the disk before the
  bytes do.
- `db_save` refuses an empty payload. An empty export means something went wrong
  upstream, and writing it would replace a working database with nothing.
- The command layer is **untouched** by any of this. It stays synchronous, next to an
  in-memory SQLite, exactly as on the web. A native binding (rusqlite) would have meant
  making every command async — Tauri's IPC is async and this WebKitGTK has no
  SharedArrayBuffer, so there is no synchronous bridge available.

Two things that cost an afternoon and will cost it again:

- **`SQLITE_DESERIALIZE_RESIZEABLE` is not optional.** Without it SQLite refuses to grow
  the database past the buffer it was handed, so everything works until the author has
  written enough to need another page. Pinned by
  `src/db/__tests__/restore.node.test.ts`, which runs the real wasm build under Node.
- **The app's own `<meta>` CSP has to name Tauri's IPC.** `connect-src *` does not cover
  custom schemes, so `invoke` is blocked before it leaves the webview and both sides
  fail quietly — the host never hears a request, and the page catches an error it cannot
  tell apart from a missing file. `NOVELTEA_TAURI=1` adds `ipc: http://ipc.localhost`;
  use `npm run dev:tauri` / `npm run build:tauri`, which `tauri.conf.json` already does.

Licences: Tauri brings five MPL-2.0 crates transitively. Accepted, deliberately and
narrowly — weak file-level copyleft arriving through a dependency we do not modify. The
rule for direct dependencies is unchanged, and GPL/LGPL/AGPL/CDDL/EPL stay excluded. See
`src-tauri/LICENSES.md`.

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
- **The submission needs a `presetId` or an `inlineConfig`.** A body carrying neither is
  refused with "a compile needs a preset_id or an inline config", so a plain
  `{format, destination}` never compiles anything. Send `inlineConfig: {}` when no preset
  is chosen.
- **The submit route answers `{"jobId": ...}`.** Every other route on a job answers
  `{"id": ...}`. Read both; reading only `id` here reports "the server did not say which
  job it started" against a real server, and a fixture written from the client will agree
  with the client and never catch it.

## Compile presets

A preset is a saved submission format: a name, an export format, and which binder items go
into it. The table syncs, so a format set up on one machine is on the other.

- **Only the format and the selection are offered**, and that is not laziness. The compile
  worker reads `included_binder_items` off the preset row and nothing else — not
  `separator_rules`, not `title_page`, not `front_matter`, not `include_query`. An
  interface for the others would promise an author a title page that is silently dropped.
- **An empty `included_binder_items` means the whole manuscript**, on both sides: the
  worker filters only when the list is non-empty. It is `[]` and never null, because the
  `compile_preset_has_selection` CHECK — mirrored as a server invariant — needs a selection
  present.
- **The wire types are stricter than the local table.** `included_binder_items` binds to a
  Postgres `uuid[]`, so it goes as a JSON array of id strings and every element is parsed
  with `UUID.fromString`; `separator_rules` binds to jsonb and must be a JSON *object*. A
  string holding `"[]"` or `"{}"` is refused as `invalid_request`, not coerced.
- **The pre-flight follows the selection.** Narrow the finished plan, never the rows going
  into it: the planner needs the whole binder to recognise a trashed item, because trashing
  is a reparent. Recount the words with the compiler's own extraction, or the panel and the
  export disagree.
- **`compile_preset` has no `order_key`** — the only synced table without one. Order by
  name; `created_at` ties at millisecond resolution and then falls back to a random uuid,
  which reshuffles the picker between renders.

## The outliner

The binder as a table — title, summary, label, status, words — for reading the shape of
the whole book rather than rearranging one level of it.

- **One recursive query, ordered by a materialised path.** The path is built with `'/'`,
  which sorts below every character an order key can hold (`0-9A-Za-z`). That is what puts
  a folder immediately before its own children instead of after a sibling whose key
  extends its prefix — `"V"` and `"VV"`, which is exactly what `between()` returns for an
  insert between two adjacent siblings.
- **The trash needs no exclusion clause.** The walk starts at the top-level items and
  descends; a trashed item's parent is the trash node, which is not among them. Prefer
  this shape over filtering wherever the query can be written as a walk.
- **A folder shows the words beneath it**, not its own zero. Computed in one linear pass
  over the depth-ordered rows, guarded on `type === "document"` so the pass is safe to
  apply twice.
- **A sorted outline is flat, and says so.** Sorting a tree by word count has no meaning,
  so a sort drops the indentation and the caption states that this is no longer the shape
  of the book. Sorting by label or status orders by the *name*, never the id.
- **Clicking a heading cycles ascending, descending, manuscript order.** Without the third
  state there is no way back to the order the author arranged the book in.

## Word targets

`project.settings` is the column the schema set aside for "compile defaults, word count
targets". The two targets live there; today's tally is worked out on the device.

- **Nothing about a project syncs.** `pending_change` has no `project` entity type — the
  sync endpoint is scoped by a project id in its path, so it cannot carry a change to the
  project row. A target is therefore per replica until the client learns to `PATCH
  /projects/{id}` directly, which is the same gap project creation has. Say so in the
  interface rather than letting an author find out on their second machine.
- **Merge into `settings`, never replace it.** The column is a shared bag: writing the
  whole object deletes whatever this build does not know about. This is the *opposite* of
  the rule for a collection's `query`, where an unknown key is dropped — there, keeping it
  would claim a condition this build cannot apply; here, dropping it destroys another
  client's configuration.
- **Clearing a target removes the key.** "No target" is the absence of one, so every
  reader agrees without a special case for zero or null.
- **Today is a baseline, not an event log.** Store the word count as the day began and
  subtract; the difference then cannot drift out of step with the manuscript, and deleting
  a chapter takes the number down, which is the truth. Reset the baseline when the count
  falls below it, or emptying the trash makes every number for the rest of the day
  negative.
- **Use the author's local date**, never UTC. Someone writing at one in the morning is
  still on tonight's session.
- **Count with the recursive trash walk** ([[DISCARDED]] in `data/binder.ts`), not a
  `parent_id` check. Trashing reparents one item, so a discarded folder's scenes still
  point at the folder — and a motivational number must never be wrong upwards.

## Custom metadata

Author-defined fields per project, and one value per binder item per field. This is what
a character sheet is made of, and having it in the schema is why the app does not need a
second system for character sheets and location notes.

- **The two tables behave differently, and the schema says why.**
  `custom_metadata_field` has `deleted_at`, so removing one is a tombstone.
  `custom_metadata_value` has none on either side, so clearing one is a hard `DELETE` and
  the delete in the change feed is the whole story.
- **`custom_metadata_value` has no `project_id`.** The server scopes it through its binder
  item, and both `binder_item_id` and `field_id` are `parentRefs` required on create and
  checked against the project. Omitting either is an `invalid_request`, not a default.
- **`value` is jsonb.** Send the parsed value, not the text it is stored in — the column
  holds `"Grey"` including its quotes, and pushing that raw makes the quotes part of the
  answer. `JSON_ANY`, so a scalar is fine; SQLite's `json_valid` accepts scalars too.
- **`options` belong to a select and nothing else.** Both the CHECK
  `custom_metadata_field_options_for_select` and the server invariant mirroring it refuse
  them elsewhere, so omit the key rather than sending a JSON null — `hasNonNull` reads a
  null as present and fails the whole push.
- **Validate a value against its field's kind before writing it.** Nothing downstream
  will notice that a "number" field is holding the word "soon"; the interface will simply
  render something it did not expect, on another device, months later.
- **A field's kind cannot change.** Every value stored was checked against the old one and
  there is no honest conversion. A new field is how an author changes their mind.
- **Deleting a field leaves its values.** They are unreachable the moment the field is
  gone, the cascade is on a hard delete which a tombstone is not, and clearing them would
  push one queue entry per item that ever filled the field in.
- **Read values per item, not per project.** A cast of forty with a dozen fields is five
  hundred rows, and only one item's worth is ever on screen.

## Binder semantics

- **Trash is a move, not a delete.** Trashing reparents to the project's trash node and
  records where the item came from; the item keeps syncing and stays restorable.
  `deleted_at` is the tombstone written when trash is emptied.
- **`order_index` is a lexicographic string, not a number.** Use the `fractional-indexing`
  algorithm (MIT) to generate keys for drags. Floats exhaust IEEE precision after ~50
  consecutive inserts between the same two siblings, and then reorders silently stop working.
- **The server prevents cycles**, but the client should refuse to drop an item into its own
  descendant in the drag layer too — a rejection after the drop looks like a broken UI.
- **Labels and statuses are one table.** `taxonomy` holds both, told apart by `kind`, and
  `binder_item.label_id` / `status_id` point into it. A colour is meaningful on a label
  and is stored as null on a status — `src/db/taxonomy-commands.ts` enforces that on the
  way in rather than trusting callers.
- **Deleting a term clears it off every item wearing it**, in the same transaction, with a
  queue entry per item. A tombstone does not fire the `ON DELETE SET NULL`, so without
  this the row keeps a foreign key to something no reader on any device can resolve.
- **Taxonomy writes are spec-driven on the server**, not hand-written: `SyncService.applyOne`
  falls through to `applyDataEntity`, which accepts any type `SyncEntitySpec` declares —
  taxonomy, collections, custom metadata, compile presets. The server's own `CLAUDE.md` still
  says only `binder_item` and `document` are writable; that sentence is stale, and the switch
  in `SyncService` is what to read. `not_implemented` now means only "no spec for that type".

## Collections

- **Two kinds, one table, and the kind is permanent.** `collection.is_smart` with
  `collection.query`; a static list keeps its members in `collection_item`. Neither can be
  turned into the other — one discards the query that *was* the collection, the other makes
  hand-picked members stop being what it holds. `updateCollection` refuses both.
- **A smart collection is answered at read time, against the replica.** There is no
  materialised membership, nothing to refresh and nothing to invalidate; a scene joins the
  moment its prose matches. That is also why it works with no server.
- **The saved query is a small, closed shape** (`labelIds`, `statusIds`, `text`, `types`),
  not an expression tree. The server stores it as opaque jsonb and never interprets it, so
  what keeps two clients agreeing about what a saved search *means* is that the shape stays
  simple enough to implement twice. `normaliseQuery` drops keys this build cannot evaluate
  rather than round-tripping them back unchanged.
- **A text condition that tokenises to nothing means no results**, exactly as search does.
  Falling through to "everything" would silently turn one typo into the whole manuscript.
- **`collection_item` has no `deleted_at` on either side**, so removing a member is a hard
  delete and the queue entry is the only thing that tells another device. Deleting a
  *collection* leaves its membership rows alone: they are unreachable once it is tombstoned,
  and a queue entry each would push forty changes to say one thing.
- **The payload is the server's `SyncEntitySpec`, not this table's columns.** `query` must be
  a JSON **object** and `is_smart` a **boolean** — SQLite's 0/1 is refused as
  `invalid_request`, not coerced — and `collection_item` must carry both parent ids on
  create.

## Conflicts and merging

The server never merges prose, and this client is where a conflict actually gets
resolved. `src/features/conflicts` holds the whole of it.

- **The panel is an interruption on purpose.** A conflict means an author's words exist
  in two places and one of them is not in their manuscript. It sits above the fold, not
  behind a disclosure like compile and trash. It renders nothing when signed out —
  conflicts exist only because two devices synced.
- **Both versions are rendered with the editor's own extensions**, so what an author
  compares is what they would get rather than an approximation in a preview.
- **There is no default side and no automatic merge.** The author picks a starting
  point, and the third pane is an ordinary editor seeded from it. Resolve stays
  disabled until they choose. Guessing which version someone wants is precisely what
  the server refuses to do; doing it here would put the guess back.
- **No diff is computed, here or on the server.** Only the editor understands
  ProseMirror JSON, and a diff would be a second implementation of the document model.
  No diff library was evaluated because none is needed.

Three things that are easy to get wrong, each pinned by a test that goes red when the
rule is removed:

- **`baseVersion` is the *document's* version**, which is what `resolve` validates.
  `binder_item` carries its own version for structural edits; sending that one produces
  a `baseVersion` that can never match.
- **A stale rejection leaves the merge on screen.** `409` / `stale_original` means the
  pair moved on, not that anything broke — the server refuses rather than forking
  again, because forking on merge would let copies breed without bound. Closing the
  view would discard a merge the author had just built by hand.
- **Conflict copies are badged in the binder** from `binder_item.conflict_of_id` —
  never by matching the generated title, which is author-editable and ambiguous once
  two copies exist. Tests match the badge by its tooltip for the same reason: the
  generated title contains the word "conflicted", so a text match passes with the badge
  deleted.

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

### A click does not settle the write behind it

This has cost time three times now, so it is written down. Every mutation in this app
is a command to the worker followed by a re-read, and Playwright's `click()` returns
as soon as the click lands — not when the database has changed and the tree has
re-rendered.

**Before a `reload()`, a screenshot, or any assertion about a later state, wait for
something that proves the write finished** — a row count, a status transition, a piece
of text. Without it a fast machine passes and a slow one reports data loss that never
happened, and the first instinct is to go looking in the storage layer.

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

## Licence keys

Verified offline, on the device, in Rust — `src-tauri/src/licence.rs`. The public half is
compiled into the binary; there is no activation server and no call home, because an app
that stops working when a licence server is unreachable is not local-first whatever else
it does.

- **There is no clock in a key.** A key names the highest *major version* it covers and
  does so forever — "Purchase NovelTea 1.0", not a subscription. That removes expiry,
  clock skew, timezones and offline grace periods as a class. The issue date is recorded
  for support and compared to nothing.
- **A key for an older major version is not an error.** It is a real purchase that does
  not reach this build. `Invalid` is for keys that are malformed or unsigned;
  `Status::TooOld` is for keys that are fine. They carry different advice because the
  reader can act on different things.
- **Verify the payload bytes as they arrived**, never re-serialised JSON. Round-tripping
  through a struct first lets two encodings of the same data verify differently — a key
  that works on one build and not the next.
- **An unreadable version reads as major 0**, which every key covers. The failure being
  avoided is locking someone out of software they paid for because a version string was odd.
- **A key that does not verify is never stored**, so the app cannot come back tomorrow
  still holding something it already rejected.
- **The gate is the update, never the manuscript.** A licence that does not cover a build
  must not stand between an author and their own words.
- **The issuing tool is `required-features = ["issuing"]`** so neither `cargo build` nor
  `tauri build` produces it. The private key is not in this repository.
- **Never commit a valid key as a test fixture.** This repository is public; a valid key in
  it is a free licence. `the_embedded_public_key_matches_the_signing_key` takes one from
  `NOVELTEA_TEST_LICENCE` and is a no-op without it. Run it before a release — it is the
  only check that the compiled-in public key matches the key you sign with, and getting
  that wrong refuses every licence ever issued.

## Branching and releases

Since v0.1.0 there is a **release integration branch** — currently `0.2` — cut from `main`.

- **Every branch targets the release branch, not `main`.** Features, fixes, docs: all of it
  merges into `0.2`.
- **A patch on the shipped version** — a `0.1.1` — goes into `0.2` first and then `main`, so
  an urgent fix reaches `main` without waiting for the rest of `0.2` and without `0.2` and
  `main` diverging behind it.
- **`0.2` merges to `main` once**, after full regression testing and a deployment. That
  merge is the release; `main` is what is running.
- Tag `main` after the merge (`v0.2.0`). Note the published image tags drop the leading
  `v`: git `v0.1.0`, image `0.1.0`.

Opening a PR against `main` by habit is the easy mistake — `gh pr create --base 0.2`.

## Pull requests

**Keep the description under 250 words.** A reviewer opens a PR to find out what changed and
what to look at hardest; a page of prose buries both. Go over only when something genuinely
load-bearing cannot be said in less — a protocol change, a migration, a failure mode that is
not obvious from the diff — and then only by as much as that needs.

The commit messages carry the reasoning. The description says what changed, anything the
reviewer would not infer from the diff, and what was run to check it. Everything else the
code and the tests already say.

## Open questions

1. Where `@noveltea/client-db` comes from at install time — git dependency, submodule,
   private registry, or one workspace. Unresolved; see README.
2. Token storage in the browser, which has no OS keystore. May require a server change
   (`httpOnly` refresh cookie). See README.
3. The canonical node/mark name set and where the shared schema package lives.
4. ~~Whether the merge view can be built before the server exposes a merge endpoint
   pair.~~ Settled: it is built against `GET /projects/{id}/conflicts`,
   `GET /conflicts/{copyId}` and `POST /conflicts/{copyId}/resolve`. No diff library
   was chosen because no diff is computed — see *Conflicts and merging*.
5. Android in v1 or not.
6. Repository visibility and licence.
