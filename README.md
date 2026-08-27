# NovelTea — client

The client application for **NovelTea**, a self-hosted, offline-first writing app for
long-form fiction: a binder tree of folders and documents, snapshots, labels and statuses,
saved and smart collections, and compile/export to manuscript formats.

The server is a separate repository — [`noveltea-server`](https://github.com/ajcarlascio/noveltea-server)
— and it owns the API, the wire protocol, the Postgres schema **and** the client's SQLite
schema. This repository owns the interface and nothing else.

## Status

**Feature-complete for the core loop: write, find, sync, compile.** Scaffold, themes,
the local replica, the binder, the editor, accounts, sync, offline search and export
are all in place and covered by tests. Everything below that is not the build, the router, the theme
tokens, the database layer or the binder is still a decision rather than an observation.

Start with `CLAUDE.md` for the rules, and `docs/architecture.md` for the reasoning behind
the three structural choices (why not React Native, why TipTap, where the sync engine
lives).

### Themes

Colour lives in exactly one place: `src/styles/tokens.css`. No component hard-codes a
colour; if a value is not a `var(--token)`, it cannot follow the theme and it will not be
accepted.

Light mode is **paper** — a warm off-white page against slightly darker grey chrome, so the
text column reads as a sheet on a desk rather than a lit panel. Dark mode is a soft
near-black, never `#000`.

There are three theme states, not two. An explicit choice stamps `data-theme` on `<html>`;
the default "system" stamps nothing and lets `prefers-color-scheme` decide. That is why the
dark palette is declared twice — once inside the media query (guarded by
`:not([data-theme="light"])` so an explicit light choice still wins on a dark OS) and once
under `[data-theme="dark"]`. A test asserts the two blocks stay identical, and that every
colour-valued light token has a dark counterpart; a token defined in only one theme renders
as an unresolved custom property for half the readers and is invisible in review.

## The constraint that shapes everything

NovelTea is offline-first, and that is not a feature — it is the design.

**The UI never awaits an HTTP call in order to render.** Every screen reads the local
SQLite replica, which is a complete copy of the author's projects. A background sync engine
reconciles that replica with the server on its own schedule. A novelist on a plane, in a
cabin, or on a train through a tunnel has the entire application, including full-text
search and compile planning.

The consequences are concrete and they constrain ordinary-looking code:

- **There are no loading spinners on the read path.** If a screen is waiting on a request
  before it can show a chapter, that screen is wrong, regardless of how fast the request
  usually is.
- **A write is a local transaction plus a queue entry.** Saving a document commits to
  SQLite and enqueues a pending change; the push happens later and may fail. The author is
  never told "saving…" and never blocked by a network error.
- **Sync is ambient status, not a modal.** "Last synced 4 minutes ago", "3 changes waiting",
  "conflict needs your attention" — displayed, never blocking.
- **The server URL is chosen by the user**, because self-hosted means there is no default
  instance to fall back to. Every sign-in screen on every platform has a server field or
  dropdown, and the app can hold several accounts on several servers.

If you are about to write `await fetch(...)` anywhere a component can see it, stop and read
`CLAUDE.md`.

## Stack, and why

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript | Shared vocabulary with the server's Node packages, which the client consumes directly. |
| UI | React + Vite | The editor decides this: ProseMirror is a DOM library, so the client is a web client. React is the ecosystem TipTap and the team already know. |
| Editor | **TipTap core** (MIT) over ProseMirror | Far less code than raw ProseMirror, with the ProseMirror API still reachable underneath. `@tiptap-pro/*` is a paid registry and is **forbidden**. |
| Local store | SQLite via `@noveltea/client-db` | The schema and migrations come from the server repo so they cannot drift from the protocol. `@sqlite.org/sqlite-wasm` (Apache-2.0) over the OPFS SAH Pool VFS on the web, a native SQLite build under Tauri. wa-sqlite was the original pick and was dropped — see "The local replica". |
| Sync | `@noveltea/sync` (to be created, in the server repo) | Coupled to the wire protocol and the schema the server owns. A library, never a service. |
| Desktop + mobile | **Tauri v2** | One web codebase wrapped for Windows, macOS, Linux, iOS and Android. Real ProseMirror in every shell. |

**Not React Native.** RN was considered seriously and rejected for this specific app,
because RN has no DOM and ProseMirror is a `contenteditable` library. The full argument,
including the trade-off table and the case for overruling it, is in
`docs/architecture.md`.

## How this repo relates to `noveltea-server`

The server does not merely serve this client — it *defines* it. Three things cross the
boundary, and all three point in the same direction:

- **`@noveltea/client-db`** — the local SQLite schema and its migration runner. It lives in
  the server repo because its migrations must move in lockstep with the server's; a client
  release that ships a schema the server has not seen is a corrupted replica. This repo
  pins the server repo as a submodule at `vendor/noveltea-server` and consumes the package
  as an npm workspace; it **never** hand-writes DDL.
- **The document schema** — documents are ProseMirror JSON, and the server's
  `packages/compile` serialises that same JSON to txt/md/html. The set of node and mark
  names is therefore a *contract*, not an editor detail. It must be defined once, in one
  place, and versioned. See the open decisions below: today it is defined twice.
- **The wire protocol** — `GET|POST /api/v1/projects/{id}/sync`, plus the REST routes for
  the online cases. The server owns the shapes; this client does not negotiate them.

The rule that follows: **when a change would require editing both repositories, the
definition belongs in the server repo and this one consumes it.**

## Running it

This repo pins the server repository as a **git submodule** at `vendor/noveltea-server`,
because that is where the client's SQLite schema lives. Clone accordingly:

```bash
git clone --recurse-submodules https://github.com/ajcarlascio/noveltea.git
# already cloned without it:
git submodule update --init --recursive
```

```bash
npm install              # Node >= 22.6, matching the server's packages
npm run dev              # Vite dev server — the browser client
npm test                 # unit tests (vitest)
npm run test:watch
npm run typecheck        # tsc over src and over the Node-side config
npm run lint             # eslint, zero warnings tolerated
npm run licenses         # dependency licence audit
npm run build            # typecheck, then production bundle
npm run test:e2e         # Playwright, against the production build in a real browser
```

Not wired up yet, and documented here so the commit that adds them does not invent a
different name:

```bash
npm run tauri dev        # desktop shell around the same code
npm run tauri ios dev    # iOS simulator (macOS host only)
npm run tauri android dev
```

A local server is `docker compose up -d` plus `./gradlew :api:bootRun` in `noveltea-server`.
The dev client should default its server field to `http://localhost:8080` and nothing else
— never a hard-coded hosted URL, which does not exist.

Note that the API sets **CORS off unless configured**. A browser client on
`http://localhost:5173` must be listed in the server's `noveltea.cors.allowed-origins`, or
every request fails in a way that looks like an auth bug. The Tauri shells are not subject
to this.

## The local replica

Every screen reads SQLite, never the network. The database is opened once, in a **web
worker**, and reached through a typed request client.

```
src/db/open.ts        opens SQLite over OPFS
src/db/adapter.ts     sqlite-wasm -> the SqliteAdapter that @noveltea/client-db migrates through
src/db/dispatch.ts    the worker's behaviour, with the worker globals factored out so it is testable
src/db/worker.ts      the worker itself: wiring, nothing more
src/db/client.ts      main-thread request/response, one promise per request
src/data/*            the only place SQL lives
```

**The schema is not written here.** It comes from `@noveltea/client-db` in the server repo,
consumed as an npm workspace pointing into the submodule, so there is one source of truth
and no publishing step between a schema change and this client seeing it. The generated
migration bundle is gitignored upstream; `npm install` regenerates it through that package's
own `prepare` script.

A few decisions worth not relitigating:

- **`@sqlite.org/sqlite-wasm`, not `wa-sqlite`.** The architecture document named wa-sqlite,
  but its npm package declares no licence at all (`license: None`, no repository field), and
  the rule in this repo is MIT/Apache-2.0/BSD. `@sqlite.org/sqlite-wasm` is Apache-2.0,
  official, and ships the VFS we need.
- **The SAH Pool OPFS VFS, not the plain one.** The plain VFS needs `SharedArrayBuffer`,
  which needs COOP/COEP response headers, which a self-hoster behind an arbitrary reverse
  proxy cannot be assumed to have set. Getting that wrong would silently take persistence
  away from the author. SAH Pool needs no cross-origin isolation and is faster.
- **An in-memory fallback is reported, never hidden.** If OPFS is unavailable the app still
  runs, but `StorageWarning` says so in the interface. An in-memory replica loses every word
  on reload, and that is not something an author may discover for themselves.
- **Requests made before the database opens are queued, not rejected**, and if opening fails
  the queue is drained *as failures*. A dropped request leaves a promise pending forever,
  which in an offline-first client is indistinguishable from a lost write.
- **The replica's state is mirrored onto `<html>`** as `data-db-status`, `data-db-storage`,
  `data-db-applied` and `data-db-schema`. It helps an operator support an author, and it is
  how the end-to-end tests tell a persisted database from a fresh one without the app
  exposing a test handle that would also exist in production.

### Storage across engines

Not every engine can persist, and the app has to be correct in both cases.

| Engine | `navigator.storage` | Result |
|---|---|---|
| Chromium | yes | OPFS, persists across reloads |
| Playwright's WebKit | **absent entirely** | in-memory, warning shown, still usable |
| Safari 17+ | yes | expected to persist; not verifiable with this harness |
| WebKitGTK (Linux Tauri) | historically absent | see below |

The WebKit result is a property of the build Playwright ships, **not** of Safari — Safari has had OPFS since 17. But it is a fair proxy for **WebKitGTK**, which Linux Tauri embeds, and that is a real concern: a Linux desktop build on wasm + OPFS could fall back to memory and lose an author's work on every restart.

The answer there is not to fix OPFS. It is that **the Tauri shells should use a native SQLite binding rather than wasm**, which is what `SqliteAdapter` — three methods, no wasm assumptions — exists to allow. Until that shell is built, the memory fallback and its warning are what stand between an author and silent loss, and `e2e/replica.spec.ts` tests that path explicitly rather than skipping the engine.

### What the tests prove, and what they cannot

Unit tests run the real migrations and the real SQL against real SQLite through
`node:sqlite`, so a wrong column name fails immediately — but they cannot see OPFS. The
Playwright suite covers exactly that gap: it loads the production build in Chromium and
asserts the second visit applies **zero** migrations, which is only true if the database
file survived. Deleting the OPFS path turns that red, along with the assertion that storage
is not `memory`.

## The binder

The tree of folders and documents, read from the local replica and edited entirely
offline. `src/features/binder/` renders it; `src/db/commands.ts` changes it.

### Writes are named commands, not SQL from the page

A binder edit changes a row **and** queues a `pending_change`, and those two have to
commit together — an edit that landed without its queue entry never reaches the server and
nothing reports it. `enqueueChange` is synchronous by design, and the database client is
async over a worker, so the operation is *named* on this side and executed on the other,
inside one transaction (`DatabaseClient.command`).

The alternative was re-implementing the queue's merge rules against an async client, which
is a second copy of them, which is how they drift. As a side effect the commands are plain
synchronous functions over `SqliteAdapter`, so they are tested against real SQLite with
nothing stubbed.

### Semantics that are not obvious from the schema

- **Trash is a move, not a delete.** Trashing reparents to the project's trash node and
  records `trashed_from_parent_id`; `deleted_at` is reserved for the tombstone written when
  the trash is emptied. Two consequences that are easy to get backwards, and both have bitten
  the server already:
  - **Re-trashing must not overwrite the remembered origin**, or restoring puts the item
    back where it already is and it can never come out.
  - **Restoring something that is not in the trash is a no-op**, not a move to the root —
    otherwise it silently relocates a document the author is looking at.
  - Restoring to a parent that has since been trashed falls back to the root. Refusing
    would strand the item somewhere unreachable.
- **Cycle prevention is application-level.** No CHECK constraint can express "this item is
  not among its own descendants", so every reparent runs a recursive walk first. Without it
  a mis-ordered move detaches the subtree: the rows survive, but every read starts at a
  root, so the chapters render nowhere. There is no server involved here — on the client
  that is a lost manuscript.
- **Emptying the trash tombstones every item in every trashed subtree**, each with its own
  queue entry. A child left live under a vanished parent renders nowhere and syncs nothing.
  The rows stay: the tombstone is what tells another device the item is gone.
- **A document is a leaf.** The schema permits nesting under one; the semantics do not.

### Ordering keys

`binder_item.order_key` is a lexicographic fractional index, never a float — floats exhaust
IEEE precision after about fifty inserts between the same two siblings. `src/data/order.ts`
is a **digit-for-digit port of the server's `com.noveltea.order.FractionalIndex`**, and the
two must agree exactly: keys made on a phone are compared against keys made on a laptop and
by the server, and an algorithm that differs even in rounding orders the same book
differently on each device.

Nothing about that drift fails on its own, so it is pinned by conformance vectors generated
from the real Java:

```bash
./tooling/generate-order-vectors.sh    # needs a JDK and the submodule
```

105 vectors cover appending, prepending, sixty inserts into the same gap, and the pairs the
algorithm rejects. Changing the rounding or the alphabet turns dozens of them red.

Arithmetic on these strings is always a bug: they are compared, never computed.

**A finding worth acting on, server-side.** The published fractional-indexing algorithm
carries a length-prefixed integer part — `a0`, `a1`, … `az`, `b00` — so appending N items
keeps keys at O(log N): a few characters for thousands. `FractionalIndex` has no such
prefix, so once the leading digit reaches `z` every further append adds a character:

| appends | key length | | inserts into one gap | key length |
|---|---|---|---|---|
| 10 | 2 | | 10 | 2 |
| 50 | 10 | | 50 | 9 |
| 500 | 100 | | 500 | 84 |
| 2000 | 400 (`zzzz…`) | | 2000 | 334 |

Appending is the commonest thing a binder does. Ordering stays correct, so nothing breaks —
it costs storage, index size and comparison time on the hottest path. It is cheapest to
change **before any real binder exists**, because changing it later means migrating every
key in every replica. `order.node.test.ts` pins the current numbers so a server-side fix
turns this port red and forces it to be regenerated rather than diverging silently.

### Creating a project offline — the known gap

`createProject` writes locally and queues **nothing**, because `pending_change` has no
`project` entity type. That is not an oversight in the schema: the sync endpoint is
`POST /projects/{id}/sync`, authorised on a project named in its path, so it cannot carry
the creation of one.

A project created offline therefore does not reach the server yet. Closing it needs a
client-generated project id posted to `POST /projects` from an outbox, idempotent on the id
so a lost response does not create two — the same shape as the rest of the queue, drained on
reconnect. That belongs with the sync phase.

## The corkboard

The binder answers "what is in this book". The corkboard answers **"what happens, and in
what order"** — a different question, asked at a different moment, which is why it is a
second view over the same rows rather than a mode inside the first.

`document.synopsis` has been in both schemas since the first migration and until now had
nowhere to be written. A card's summary is that column: an ordinary local edit that queues
for sync like any other and needs no connection.

**One level at a time.** A wall of every scene in a novel is not something anyone can look
at, so the board shows the children of wherever the author already is — a selected folder
means the scenes inside it, a selected document means that scene and the ones beside it,
nothing selected means the top. Choosing anything else would let the two views disagree
about where the reader is standing.

**Folders get cards too**, and drill in when opened. A folder has no `document` row and so
no summary of its own; its card says how much is behind it instead, which is what you want
to know before deciding whether to look.

**Reordering is drag *and* buttons**, and the buttons are not a fallback. A drag needs a
pointer, a steady hand and a screen wide enough to show both ends of the move; the buttons
work with a keyboard, on a phone, and one card at a time — which is how most reordering
actually happens. Both write the same fractional `order_key` the binder reads, so the two
views are one order and not two.

### The rule that shapes the writes

`pending_change` holds **at most one entry per entity**, and merging a second change
replaces the payload rather than combining it. So a partial document payload is a promise
that no other pane will write this document before the queue drains — and the editor writes
prose while the corkboard writes index cards, so that promise is false. Whichever saved
last would silently drop the other's field from the push.

Every document write therefore queues the **whole row**. That makes coalescing correct by
construction rather than by everyone remembering. The server independently reads a missing
key as "leave it alone", so the two halves cover each other: an older client's autosave
cannot wipe a synopsis, and a new client's card save cannot wipe prose.

A synopsis is saved when the field is left, not on every keystroke — it is prose about
prose, rewritten several times per card, and every save is a queue entry the next sync has
to carry. Snapshots are deliberately not taken: they exist to protect a manuscript from a
bad revision pass, and capturing one every time somebody tidies a card would fill the
history with nothing.

## Labels and statuses

Two per-project vocabularies an author invents for their own book: a **label** says what a
scene *is* — "Bob's POV", "the B-plot", "London" — and a **status** says how far along it
is — "Outline", "First draft", "Done". Both live in one `taxonomy` table, told apart by
`kind`, with `binder_item.label_id` and `status_id` pointing into it. They are shown in the
binder and on the index cards, and set from two selects under the toolbar.

**A colour belongs to a label and not to a status.** A label is a thing you scan a whole
outline for, so a dot beside the title is the fastest way to find it; a status is a word you
read. The commands store null for a status's colour rather than trusting the caller, so
there is never a value on screen that nothing draws.

**The dot is never the only signal.** Colour alone reaches neither a screen reader nor a
reader who cannot tell two hues apart, so the name is always beside it. A row of twelve
coloured names is also simply unreadable, which is the practical half of the same rule.

**Deleting a term takes it off everything wearing it**, in the same transaction, with a
queue entry per item — so the other devices learn those items are unlabelled rather than
pointing at a row they can never resolve. A tombstone does not fire the schema's
`ON DELETE SET NULL`; only a hard delete would, and nothing here hard-deletes. Because that
gesture changes items elsewhere in the binder, the button asks twice.

**These sync like everything else.** `SyncService.applyOne` falls through to
`applyDataEntity` for any type `SyncEntitySpec` declares, and taxonomy is one of them, so a
term pushes and pulls on the ordinary path. (The server's `CLAUDE.md` still says only
`binder_item` and `document` are writable — stale prose; the switch in `SyncService` is the
authority.) The spec requires `name` and `order_key` on create, which is what the commands
here send.

## Custom fields

The questions an author decides to ask of their binder — "Age", "Eyes", "First appears" —
and every folder and document can answer them. Fields are defined once per project and
their answers are per item; both sync, so a character sheet built on a desktop is the same
character sheet on a phone.

- **The kind is chosen once.** Text, number, date, yes-or-no, or a list of choices. It
  cannot be changed afterwards: every answer already stored was checked against it, and
  there is no honest conversion from "yes" to a number. A new field is how you change
  your mind.
- **A yes-or-no is a three-way control, not a checkbox.** A checkbox cannot tell "no" from
  "not asked yet", and for a field added to a whole cast at once that is the difference
  that matters.
- **Native inputs throughout.** A date field is `<input type="date">`, so it opens the
  platform's own picker and produces a calendar date rather than an instant — "first
  appears" is a day, and a timezone-bearing timestamp reads as a different day abroad.
- **Nothing is shown until a field exists.** Most projects never want a character sheet
  and should not pay for one in manuscript height; the details row appears with the first
  field and goes with the last.
- **Clearing an answer removes it** rather than storing an empty one. The row has no
  tombstone on either side, so a delete is what the change feed carries anyway.
- **Deleting a field leaves its answers on disk.** They are invisible — nothing lists an
  answer to a question no one can name — and if the field comes back from another device,
  so do they. The alternative is one queue entry per item that ever filled it in.

## Collections

A **list** is a set of scenes an author gathered by hand. A **search** is a set of conditions
saved under a name — "every scene Marlowe appears in" — and it has no members of its own:
it is answered against the local replica every time it is drawn. So it is never stale, never
needs refreshing, and works on a train. What syncs is the query; the answering is local.

**The kind is chosen once and cannot be changed.** Turning a search into a list throws away
the query that was the collection; turning a list into a search makes its hand-picked members
stop being what it holds. Making a second collection is the honest way to change your mind.

**The saved query is deliberately four conditions and no expression builder** — words, label,
status, kind — combined with AND. It is stored as opaque jsonb and travels between clients,
so the only thing keeping two of them agreeing about what a saved search means is that the
shape stays small enough to implement twice. A condition this build does not recognise is
dropped rather than saved back unchanged, because a collection must not claim a condition
nothing is applying.

**A search whose words tokenise to nothing finds nothing** — the same rule search follows.
The alternative is that one typo silently turns a collection into the whole manuscript.

Both kinds exclude the trash. A trashed item keeps its place on a list and comes back when
it is restored, because the row was never touched.

## Reviewing the interface

```bash
npm run screenshots
```

Writes `screenshots/` — every route, three device sizes, both themes. Gitignored; regenerate
rather than commit. It is not a test and asserts nothing; it exists so a change to the
interface can be looked at instead of described.

## The editor

TipTap (MIT) over ProseMirror, in `src/features/editor/`. `@tiptap-pro/*` is a gated
commercial registry and must never appear here, even transitively.

- **The schema is a contract, not a preference.** `packages/compile` on the server
  serialises this same JSON to txt, md and html and recognises a fixed set of node and mark
  names. Anything else is dropped to plain text with a warning — the words survive, the
  formatting does not. `schema.node.test.ts` reads compile's own source out of the submodule
  and fails if the two drift.
- **Link hrefs are allowlisted, not escaped.** There is nothing in `javascript:alert(1)` to
  escape. http, https and mailto only, matching the server. Tested through a real editor
  against `data:`, `vbscript:`, `file:`, mixed case, leading whitespace and a tab inside the
  scheme — browsers strip those before resolving, so `java<TAB>script:` executes.
- **`role="textbox"` and `aria-multiline` are set explicitly.** A bare
  `<div contenteditable>` computes as role `generic` in HTML-AAM, so without them a screen
  reader never announces the manuscript as somewhere you can type.
- **`search_text` and `word_count` are computed here** because only the client parses a
  document — the JVM stores `content` as opaque jsonb and never walks it.
- **Words break on whitespace and on en/em dashes**, matching Word and Scrivener, so
  "stopped—then" and "stopped — then" both count as two. Hyphens join: "well-lit" is one.

### Autosave is where a writing app loses work

It loses it silently: nothing fails, the author just finds the last few minutes missing.
Three flushes guard against that, and each has a test.

- **On a pause** (700ms), so a typing session does not rewrite the body on every keystroke.
- **On leaving the document** — switching to another one in the binder, or unmounting.
- **On the page going away**, via `visibilitychange` and `pagehide`. React unmounting is not
  involved in a reload, a closed tab, or a phone backgrounding the browser; the document
  simply stops existing, taking anything still inside the debounce with it. `beforeunload` is
  not used: mobile browsers do not fire it reliably.

A failed save **keeps its payload** and reports the reason, rather than discarding the words
at exactly the moment they most need keeping.

## Sync

One pass is: pull everything waiting, then push everything local. **Pull first,
deliberately** — pushing into a stale picture is how a client resurrects something
another device deleted.

### Rules the tests hold

- **The cursor never moves past `latestId`.** That is the highest id *actually served*,
  not the feed's maximum; advancing past unserved rows skips them permanently.
- **An empty page still advances the cursor.** It moves the feed position like any
  other, and leaving it unwritten means re-asking for the same empty range forever.
- **A resync resumes at `latestId`, never at 0.** A purged server answers
  `resyncRequired` for *any* cursor below its purge point, so restarting at 0 walks
  straight back into the same answer and rebuilds on every page.
- **A resync does not wipe the replica.** See the gap below.
- **`version_mismatch` clears the queued change.** The server kept its version and
  preserved the author's text as a conflict copy; retrying would make another copy on
  every push and copies would breed without bound. Only `not_implemented` stays
  queued, because a later server version may accept it.
- **`markAttempted` runs before the push, never after.** If a push is applied and the
  response is lost, an unmarked entry can be dropped locally while the server keeps
  the row — and the item returns on the next pull as a ghost.
- **A failed sync clears nothing.** The queue holds writing that never left the device.
- **One malformed row does not stall the feed.** Rows that cannot be applied are
  dropped; the page still applies and the cursor still advances.
- **An unknown entity type is skipped, not fatal.** A newer server may send rows this
  client has no table for, and refusing the page would stall sync on a version
  difference.

### The order-key collision

Two devices, both offline, both add a sibling after the same item. `between` is
deterministic, so **both choose the same `order_key`**. Whichever pushes first wins, and
the other device pulls a row whose key its own unpushed row is already holding — a
unique-index violation that would fail the whole page.

The server's ordering is the accepted one, so **the local row moves**, and is re-queued
with its new key so the two devices stop disagreeing about order.

### When sync runs

Regaining a connection starts a **fifteen-minute settle window**; the sync fires only if
the connection holds for all of it, and dropping resets it. A flapping connection — a
train, a tunnel, a phone hunting for signal — would otherwise start a sync on every
flicker and fail halfway each time. Waiting costs an author nothing: their work is
already safe locally. **"Sync now" always overrides**, including while `navigator.onLine`
says offline, because it is often simply wrong and the author may know better.

**The first sync of a project does not wait.** That last justification — waiting costs
nothing, the work is already local — is only true of a replica that already has the work
in it. A device signed in a minute ago holds nothing, so the window would cost an author
their entire book for fifteen minutes, at exactly the moment they are watching for it to
appear. So when there is no cursor for the project, the sync runs as soon as the
connection is up, and every sync after that waits like any other.

It is still not a free pass: the wifi-only setting applies. Being empty is a reason not
to wait, not a reason to pull a whole manuscript over cellular against an explicit
instruction. And "no cursor" means *known* to have no cursor — the scheduler is built
before the project's state has been read, and treating "not read yet" as "never synced"
would make every app open sync every replica immediately, which is the behaviour the
window exists to prevent.

### Rebuilding after a resync

Three steps, in this order:

1. **The tree**, from `GET /binder`.
2. **Every document body**, from `GET /projects/{id}/documents`, paged. That endpoint
   exists only for this: the feed carries content, but only on rows appended since a
   cursor, so a client rebuilding from nothing cannot otherwise recover a document
   nobody has edited recently.
3. **Anything the server did not list is tombstoned** — an item deleted while this
   client was away, whose delete row retention has since purged, would otherwise linger
   forever with nothing left to say it is gone.

Bodies after structure, because a document row references its binder item.

Two things it deliberately does not do:

- **It does not wipe first.** Deleting everything and re-fetching would open a window
  in which the author's binder is empty, and would take unpushed work with it if
  anything failed partway. Upserting reaches the same state without ever holding less
  than both.
- **It does not prune an item with a pending change.** The server cannot have listed
  something it has never seen, so absence says nothing about whether the author still
  wants it — and removing it would delete unsynced writing.

The rows a rebuild applies did not come from the feed, so they are applied with
`advanceCursor: false`. Claiming position zero there would ask the server for another
rebuild on the very next sync.

## Search

Offline, over the local replica, so it works on a plane. It covers **titles, synopses,
body text and notes** — synopses and notes are never exported, but they are exactly what
an author searches to find a scene again, so leaving them out would make them
write-only. Weighted so a title beats a passing mention.

**Author input never reaches FTS5 unparsed.** SQLite is not forgiving the way Postgres's
`websearch_to_tsquery` is: a stray quote or a bare `AND` raises a syntax error, which
would surface mid-sentence as a crash. The input is tokenised and rebuilt instead, and
anything that cannot be understood is dropped rather than escaped and hoped for.

- Bare words must all appear; `"quoted phrases"` must be adjacent; `-word` excludes.
- **Adjacency is only implied when it was asked for.** `light(house)` becomes the two
  words, not the phrase — requiring them to be adjacent would be guessing.
- **An empty search finds nothing, not everything.** So does a search that is only
  exclusions, which FTS5 cannot answer anyway.
- Trashed items are excluded by default and **flagged** when included; tombstoned ones
  never appear.
- Results **follow the database**. Without that they are a snapshot of the moment the
  search was typed, and keeping writing leaves the list describing a manuscript that no
  longer exists.

## Compile

The one thing that genuinely needs a server: the export pipeline runs there, not on the
device. Everything else works without one, so this says what it needs rather than
appearing broken.

- **Unavailable formats are listed and disabled, not hidden.** This is open core — a
  format missing from a Core build is an upgrade, and omitting it would claim the
  software cannot do something it can. A `501` is reported as an edition difference,
  with the note that the author's writing is unaffected.
- **Polling widens as the wait grows** (1s, 2s, 4s, to a ceiling). A short export
  answers on the first ask; a novel should not be asked about every second for two
  minutes.
- **An unrecognised job status counts as still running**, never as done — reporting
  "done" for something that is not would offer a download of nothing.
- **The download is fetched, not linked.** The route needs a bearer token and an
  `<a href>` sends no headers, so a plain link downloads a 401 page named like a
  manuscript. The bytes become a blob URL which is revoked immediately; leaving it alive
  pins the whole manuscript in memory for as long as the tab is open.

### Presets

A preset is a saved submission format — a name, an export format, and which parts of the
binder are in it — so that sending the first three chapters to an agent is a choice made
once rather than rebuilt on every export. Presets are ordinary local rows and they sync, so
one set up on a train is waiting on the other machine.

- **The format and the selection, and nothing else.** `compile_preset` also carries
  `separator_rules`, `title_page`, `front_matter` and `include_query`, and the compile
  worker reads none of them — it loads `included_binder_items` and stops. Offering an
  interface for the rest would promise an author a title page that never appears.
- **Nothing ticked means the whole manuscript.** That is the same reading the compile
  worker uses, which is the only reason the two agree about what a preset contains.
- **The pre-flight counts the preset, not the book.** Choosing one narrows the document
  count, the word count and the warnings to what will actually be exported. The narrowing
  happens after the plan, not before it: the planner needs the whole binder to notice a
  trashed chapter, because trashing is a reparent rather than a delete.
- **The destination is not part of a preset.** There is no column for one, and where a
  finished file goes is a decision about this export rather than about what the manuscript
  is.
- **Making one needs no server.** Only the compile itself does, and it says so.

## Accounts and servers

There is no central service and never will be, so **the server address is the first thing
asked for**, not something buried in settings. Addresses already used are offered in a
dropdown, most recent first, with the email prefilled — people move between two or three in
practice.

### The first account on a new server

A freshly installed server creates one account so there is somebody to sign in as —
`admin@localhost` / `admin` unless the operator set otherwise — and **refuses to let that
password be kept.** Anything shorter than twelve characters marks the account
`must_change_password`, and the API then answers `403 password_change_required` to every
route except the one that fixes it.

On this side that means signing in lands on **Choose your password** rather than on the
projects list, and a banner sits under the header until it is done. What it deliberately
does *not* mean is a locked app: the manuscripts are in the local replica and they are the
author's whether or not a server is satisfied with them, so the binder and the editor stay
open. Blocking them would break the rule this client is built on in order to enforce
something it does not enforce anyway — the API is where that rule holds.

The screen is a plain change-password form, not the emailed reset. **A home instance
usually has no mail server**, and its reset links go to a log file the account holder cannot
read; a first-run flow that depended on SMTP would not work on the machine it exists for.

### Making accounts, when registration is closed

Servers ship with self-registration **off**: on somebody's own instance an account comes
from whoever runs it. `POST /auth/register` answers `403 registration_closed`, and this
client turns that into "ask whoever runs it" rather than a credential error, because it is
neither a wrong password nor a typo in the address.

An account the server said administers it gets an **Accounts** item in the header, opening a
screen that lists the accounts and creates new ones. A created account comes back with a
generated password shown **once** — the server keeps only its hash — and has to choose its
own before it can do anything else, because the person who made it knows the current one.
The same screen can set a password for somebody locked out, which is the only recovery path
on an instance with no SMTP.

`isAdmin` on the session decides whether that item appears and nothing else. It is a hint
about what to show, never a permission: the API re-reads the flag from the database on every
administration call, so editing it in storage produces a screen that answers 404.

### Signing in is about syncing, not access

**The app works signed out.** The replica is complete and local, so an author can write on a
plane, or before they have set up a server at all. Requiring an account first would
contradict the one rule this client is built on: the interface never waits on the network to
render. The header offers "Sign in to sync" rather than standing in the way, and **signing
out leaves the local database untouched** — a routine action must not destroy a novel with
unsynced changes.

### Where the two tokens live

- **The access token is memory only.** It lasts fifteen minutes and is replaced on demand;
  persisting it buys nothing and widens the window a copy is useful in.
- **The refresh token is persisted**, which is a deliberate exception to the rule that
  credentials never touch local storage. The difference from an API key is what a stolen one
  is worth: it **rotates on every use**, so a copy works at most once, and using a stolen one
  **breaks the legitimate device's next refresh** — a signal the author sees. The alternative
  is signing in on every reload, which pushes people towards shorter, reused passwords.
  The mitigation making this defensible is the CSP: scripts run by hash, no `unsafe-inline`,
  no third-party script at all. **If that ever loosens, revisit this.**

### Rules the tests hold

- **Being offline is not being signed out.** A refresh that fails because the server is
  unreachable leaves the session exactly as it was. Only the server *rejecting* the refresh
  token ends one — that is a real answer; a timeout is not.
- **One renewal at a time.** Refresh tokens rotate on use, so two concurrent renewals would
  invalidate each other and the app would lock itself out.
- **A 401 retries exactly once.** More would hammer the server with a token it has already
  refused.
- **One message for every rejected credential.** The server answers identically so that
  login cannot be used to discover which addresses have accounts; this client does not undo
  that by inferring more than it was told.
- **Unreachable is told apart from rejected.** A browser reports DNS failure, refused
  connection and CORS block with the same opaque `TypeError`. The message names the CORS
  case explicitly, because it is the one a self-hoster actually hits and the one that looks
  least like what it is.
- **Plain HTTP is warned about** for a remote host and **not** for localhost — every
  development server is `http://localhost`, and crying wolf there trains people to ignore
  the warning that matters.
- **A stored server list is untrusted input.** Entries that are not normalised origins are
  dropped rather than offered, because the app posts credentials to whatever it is given.

## Running it as a container

The client builds to a static bundle behind nginx, which also **proxies `/api` to the API
container**, so both answer on one origin. That is what lets the server's CORS allow-list
stay empty — and an empty allow-list means no other origin can drive this client. Split them
across two hostnames and the server has to be told about this one.

```bash
docker build -t noveltea-web .          # needs vendor/noveltea-server checked out
```

Published to `ghcr.io/ajcarlascio/noveltea-web` on every push to `main`. The whole stack —
Postgres, API, worker, this — is a `docker compose up` away; the compose file and its
`.env.example` live in the **server** repository under `deploy/`.

Two things `deploy/nginx.conf` does that are worth knowing:

- **It sends `frame-ancestors 'none'` as a header.** The build-time policy arrives in a
  `<meta>` element, and browsers ignore `frame-ancestors` there — see
  [Content Security Policy](#content-security-policy). This is the half that has to come
  from the server, and until there was a server to send it, nothing did.
- **It sends no `Cross-Origin-Embedder-Policy`.** The replica uses sqlite-wasm's SAH Pool
  VFS specifically so it does not need `SharedArrayBuffer`, so `require-corp` would buy
  nothing and cost every cross-origin resource later.

It also forwards `X-Forwarded-For`. The API's rate limiter reads its first entry, and
without it every caller arrives as the proxy's address and the whole world shares one
bucket — one person guessing a password would throttle everybody.

## Word lookup

Two providers behind one interface, so the interface reasons about *availability*
rather than about where an answer came from.

**Offline thesaurus (default, on).** WordNet 3.0, on the device. `tooling/build-thesaurus.mjs`
compiles the 35MB database down to what a synonym lookup actually uses — 110,543 words and
53,842 synsets, each word stored once and referenced by index — giving 3.7MB, 1.3MB over the
wire. It is **not bundled**: most sessions never open a thesaurus, so it is fetched on the
first lookup and held in memory. Generated at build time and gitignored; `npm run thesaurus`
rebuilds it.

> WordNet is distributed under Princeton University's licence, which permits use and
> redistribution without fee provided the notice travels with it. The notice is copied to
> `public/thesaurus/WORDNET-LICENSE.txt` beside the data. `wordnet-db` is a **dev**
> dependency — it is only needed to build the index — so it does not appear in the
> production audit even though the derived data ships.

**Datamuse (off, consented).** Rhymes, near-matches and associations a dictionary cannot
give. This is the only code in NovelTea that sends an author's words to a third party, and
it is written so it cannot do so by accident:

- Consent is checked **immediately before the request**, not at construction, so withdrawing
  takes effect on the next lookup rather than the next reload.
- **Only the single term is sent.** Never the sentence, never the document, never an
  identifier. `credentials: "omit"`, `referrer-policy: no-referrer`, and a test asserts the
  query string contains nothing but the term and a result limit.
- **Local first, always.** A synonym answerable on the device is never a reason to tell a
  third party what someone is writing.
- Every result says which it was — "on this device" or "sent to Datamuse" — so an author
  always knows.

### Consent

Anything that leaves the device is off until asked for, and asking opens a dialog that
states what is sent and to whom before anything is enabled. Three deliberate details:

- **Ticking the box opens the dialog; it does not enable the feature.** Only the explicit
  confirmation does.
- **The declining button holds focus**, so dismissing by reflex leaves the feature off — the
  reversible outcome.
- **Withdrawing forgets the consent.** Turning it on again asks again, because keeping the
  timestamp would let a later toggle re-enable it silently.

`parseSettings` refuses to return a state where a network feature is enabled without consent
recorded, and `mayUseNetwork` checks both independently. Local storage is hand-editable, so
neither one is trusted alone.

### Where API keys live

**Not in local storage, not in IndexedDB, not in the SQLite replica.** All three are
readable by any script that reaches the page, and the replica is written to disk in the
clear and copied into every backup. Three honest options, in the order the app prefers them:

1. **The operator's key, on the server.** NovelTea is self-hosted, so the natural home for a
   shared credential is the instance the author already trusts. The client never sees it.
   This is the recommended arrangement and the only one straightforwardly safe on the web.
2. **The OS keychain, under Tauri** — reached from Rust, so the key never enters the webview,
   which also lets the request be made from Rust and `connect-src` stay tight.
3. **Memory, this session only, on the web.** A browser has no secure storage. A key typed
   into the web client is held in a variable and forgotten when the tab closes, and the
   author is told that plainly rather than being quietly given weaker storage than they
   assumed.

## Typography

The reading font is the author's choice, offered at sign-up and changeable in Settings
afterwards. **Merriweather is the default offer, not a decision made for them** — novelists
care about this the way they care about paper.

It is **bundled, not fetched**: a self-hosted instance may have no internet, and the CSP
allows no font CDN. The variable `wght` axis ships in one file per style (~100KB Latin), and
`unicode-range` means a reader downloads only the subset they render.

Merriweather is **SIL OFL 1.1**, which is not in the MIT/Apache/BSD rule below. It is
allowed by name and on purpose: OFL is the standard open-font licence, its copyleft applies
to derivative *fonts* rather than to software that embeds them, and it permits bundling in a
commercial product. Do not modify the font — OFL reserves the name.

The interface keeps its own font (`--font-ui`); only the manuscript follows the choice.

> **Sign-up is not built yet.** When it is, the font picker belongs in it, alongside the
> theme — with the same four options and the same default.

## Content Security Policy

A policy is injected into `dist/index.html` at build time by `build/csp-plugin.ts`. Build
only — Vite's dev server serves its own inline HMR scripts, so a strict policy in
development blocks the tooling rather than an attacker.

Hashes for inline scripts are **computed, never written by hand**. The theme pre-paint
script has to keep running, and a copied hash goes stale the first time someone edits the
script — silently removing it and bringing back the flash of the wrong theme.

Four things about this policy that are easy to get wrong:

- **`'wasm-unsafe-eval'` is required.** sqlite-wasm compiles WebAssembly. It permits wasm
  compilation and nothing else; it is not `'unsafe-eval'`. Removing it is the most likely
  well-meaning tightening and it takes the database with it.
- **`worker-src 'self' blob:`** covers the database worker and sqlite-wasm's own OPFS proxy
  worker.
- **`connect-src` is deliberately open.** NovelTea is self-hosted: the server is whatever
  address the author types at sign-in, so there is no origin to allow at build time. A Tauri
  build should route requests through Rust instead and tighten this to `'self'` — see
  "Tauri readiness".
- **`frame-ancestors` is absent on purpose.** Browsers ignore it when the policy arrives in
  a `<meta>` element and log a warning saying so. Listing it would look like clickjacking
  protection while providing none.

**What a `<meta>` policy does not cover:** worker contexts. Code inside the database worker
is not governed by it — which is why removing `'wasm-unsafe-eval'` does not visibly break
Chromium today, even though a header-delivered policy would enforce it. Operators serving
the web build should send the policy as an HTTP response header as well, and add
`X-Frame-Options: DENY` (or a header CSP with `frame-ancestors 'none'`) for framing.

## Designing for every shell

The same bundle runs in a browser tab, a desktop window and a phone webview. Rules that
follow, all of them enforced by tests rather than by memory:

- **44px minimum for anything tappable** under a coarse pointer — Apple's HIG floor, which
  Material rounds up from. `e2e/mobile/layout.spec.ts` measures every control and fails on
  anything shorter.
- **Nothing wider than the screen.** That test walks every box and every scrollable pane,
  because measuring `documentElement.scrollWidth` proves nothing here: the app's scroll
  container is the main pane, so overflow happens *inside* it and the document never grows.
- **`100dvh`, not `100vh`.** Mobile browser toolbars change the viewport as you scroll, and
  `100vh` leaves the bottom of the app underneath them.
- **Safe-area insets** on the header and the scrolling pane, with `viewport-fit=cover`.
  Without the meta, iOS letterboxes the app; without the insets, the header sits under the
  notch.
- **`accent-color`** is set from the palette. Native controls are painted by the OS and
  otherwise default to its blue — the one thing on screen ignoring the theme.
- **Body text in `rem`, root at `100%`.** An author who enlarged their browser font did it
  deliberately.
- **`overscroll-behavior`** stops page-level rubber-banding and pull-to-refresh, which
  inside an app webview read as the app coming apart.
- **A skip link** as the first focusable element. Someone who cannot swipe past the nav has
  to be able to tab past it.

## Tauri readiness

`src-tauri/` does not exist yet. What is already lined up for it, and what is not:

- **No Node built-ins in app code**, enforced by an ESLint rule rather than by discipline —
  they do not exist in a webview. `src/test/**` is exempted explicitly, because those
  helpers run under Node.
- **All persistence is behind one interface.** `SqliteAdapter` is three methods, so the
  Tauri shell can serve the same interface from a native SQLite binding without the data
  layer noticing.
- **The CSP already assumes a webview**, and is a build artefact rather than a server
  concern, so it travels with the bundle.
- **Still to decide:** network calls. Tauri's guidance is to make external requests from
  Rust, which would let `connect-src` drop to `'self'` and keep any future tokens out of
  the webview. That is the one place where the web build and the Tauri build will
  legitimately differ, and it belongs behind `src/platform/`.

## Testing on other devices

The device matrix is Playwright projects in `playwright.config.ts` — `desktop` (Desktop
Chrome) and `mobile` (Pixel 7). Adding a device is an entry there; specs under `e2e/mobile/`
run in the mobile project because Playwright only accepts a device's browser type at project
level.

Only Chromium is installed. Worth adding, in this order:

```bash
npx playwright install webkit    # iOS and macOS Tauri both use WebKit; closest proxy we can run
npx playwright install firefox   # optional; no shell ships Gecko, so lowest value
```

**WebKit is the one that matters.** iOS uses WKWebView and Linux Tauri uses WebKitGTK, and
WebKit is where `dvh`, `:has()`, OPFS and CSP behaviour most often differ from Chromium.
Everything in this README about phones is currently verified on a Chromium engine with a
phone viewport and a coarse pointer, which is not the same claim.

Beyond the browser matrix, real shells need real toolchains: the Rust toolchain plus
`libwebkit2gtk` for Linux desktop, Android Studio and the NDK for Android, and a macOS host
with Xcode for iOS — which this machine, being WSL2, cannot provide.

## Dependency licensing

**MIT, Apache-2.0 or BSD only.** No copyleft, and nothing that requires payment to a vendor
— NovelTea is distributed to self-hosters who must be able to run what they were given.

Already verified: `@tiptap/core`, `@tiptap/starter-kit`, `prosemirror-model`, `yjs` — all
MIT. Anything under the `@tiptap-pro/` scope is a gated commercial registry and must never
appear in `package.json`, even transitively, even during a spike.

Check before adding anything:

```bash
npm view <package> license
npm run licenses         # fails the moment a disallowed licence appears
```

`npm run licenses` is the audit above, pinned to the allowed set. It currently reports
**MIT for all eight production dependencies**; the root package itself is excluded because
it is private and carries no licence field.

(`yjs` is licence-clean but is *not* currently wanted — see `docs/architecture.md`; the
server deliberately does not merge prose, and a CRDT alongside version-based optimistic
concurrency would be two conflicting models of the same document.)

## Open decisions — for the owner

These are genuinely undecided. Each names the trade-off rather than pretending an answer.

1. **Public/private split.** The stated wish is that "only the web portion is public". With
   a single Tauri codebase, the web app and the desktop/mobile apps are largely the *same
   source*, so there is no clean seam. Realistic options: (a) everything public, with
   commercial features staying in the server's private repo where the open-core line
   already sits; (b) everything private, publishing only built artifacts; (c) public core
   plus a private repo holding release, signing and store-submission configuration. (c)
   preserves the spirit at the cost of a second repo. (a) is the least work and the most
   consistent with a self-hosted product whose users must be able to build their own
   client. See `docs/architecture.md` for the full comparison.

2. **Licence for this repository.** The server is Elastic License 2.0 open core. This repo
   needs its own answer, and it interacts with (1) — ELv2 permits self-hosting but forbids
   offering the product as a service, which reads oddly on a client application. No
   `LICENSE` file has been committed here deliberately; adding the wrong one is worse than
   adding none.

3. **Canonical ProseMirror node and mark names.** This is a live defect, not a hypothetical.
   The server's `packages/compile` recognises the marks `strong` and `em` (the
   `prosemirror-schema-basic` names), while TipTap's StarterKit emits `bold` and `italic`.
   Wired together as they stand, every bit of bold and italic in a manuscript would compile
   to *unmarked text* with a warning. `compile` also currently accepts both `bulletList`
   and `bullet_list`, which means nothing is pinned. The fix is a shared, versioned schema
   package in the server repo that both the editor and the compiler derive from, plus a
   test asserting the editor's generated schema equals it. Someone has to decide which
   naming wins, and it is cheaper to decide now than after authors have manuscripts.

4. **How this repo consumes `@noveltea/client-db`.** It is `private: true`, unpublished, and
   deliberately has no build step — it is TypeScript run directly by Node's type stripping,
   with `.ts` import specifiers. A bundler will handle that, but the packaging question is
   real: git dependency, git submodule, a private registry (GitHub Packages), or folding
   both repos into one workspace. A registry is the cleanest and the only one that gives
   version pinning; a submodule is the cheapest and the most error-prone.

5. **Token storage in the browser.** Tokens must never be in SQLite. On iOS, Android,
   Windows, macOS and Linux the Tauri shells reach a real OS keystore. The browser has no
   equivalent. The options are: access token in memory only and re-authenticate on reload
   (safest, worst UX); refresh token in an `httpOnly` cookie set by the server (safe against
   XSS, requires server-side work and a same-site story that a self-hoster can configure);
   or IndexedDB (convenient, readable by any XSS). This needs an explicit choice, and it
   may need a server change.

6. **Android.** The server's notes list clients as web, Tauri desktop, and iOS. Tauri v2
   reaches Android from the same codebase for very little extra code, but shipping it is a
   commitment (Play Store account, signing, review). Is Android in scope for v1?

7. **UI state library.** A recommendation is in `CLAUDE.md` (a small store; SQLite remains
   the source of truth). This is the most reversible decision on the list and should not be
   allowed to consume much discussion.
