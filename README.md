# NovelTea — client

The client application for **NovelTea**, a self-hosted, offline-first writing app for
long-form fiction: a binder tree of folders and documents, snapshots, labels and statuses,
saved and smart collections, and compile/export to manuscript formats.

The server is a separate repository — [`noveltea-server`](https://github.com/ajcarlascio/noveltea-server)
— and it owns the API, the wire protocol, the Postgres schema **and** the client's SQLite
schema. This repository owns the interface and nothing else.

## Status

**Scaffold and theme foundation.** Vite + React + TypeScript build, routing, and the theme
system are in place and covered by tests. There is no local database, no sync, no editor
and no binder yet — the routes are placeholders that prove the shell renders and the themes
switch. Everything below that is not the build, the router or the theme tokens is still a
decision rather than an observation.

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
| Local store | SQLite via `@noveltea/client-db` | The schema and migrations come from the server repo so they cannot drift from the protocol. wa-sqlite over OPFS on the web, a native SQLite build under Tauri. |
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
  consumes it as a dependency and **never** hand-writes DDL.
- **The document schema** — documents are ProseMirror JSON, and the server's
  `packages/compile` serialises that same JSON to txt/md/html. The set of node and mark
  names is therefore a *contract*, not an editor detail. It must be defined once, in one
  place, and versioned. See the open decisions below: today it is defined twice.
- **The wire protocol** — `GET|POST /api/v1/projects/{id}/sync`, plus the REST routes for
  the online cases. The server owns the shapes; this client does not negotiate them.

The rule that follows: **when a change would require editing both repositories, the
definition belongs in the server repo and this one consumes it.**

## Running it

```bash
npm install              # Node >= 22.6, matching the server's packages
npm run dev              # Vite dev server — the browser client
npm test                 # unit tests (vitest)
npm run test:watch
npm run typecheck        # tsc over src and over the Node-side config
npm run lint             # eslint, zero warnings tolerated
npm run licenses         # dependency licence audit
npm run build            # typecheck, then production bundle
```

Not wired up yet, and documented here so the commit that adds them does not invent a
different name:

```bash
npm run test:e2e         # end-to-end, against a seeded local replica
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
