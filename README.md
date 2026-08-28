# NovelTea

A writing tool for novels. Every word lives in a database on your own machine and stays
readable with no network and no account. Syncing to a server is optional, and the server
is one you run.

This repository is the client — browser and desktop. The API, the schema and the compile
worker are in [`noveltea-server`](https://github.com/ajcarlascio/noveltea-server), pinned
here as a submodule because the client's SQLite schema lives there.

**Status:** v0.1.0. The core loop is complete and tested — write, organise, find, sync,
compile.

---

## Run it yourself

### The whole stack, with Docker

Postgres, the API, the compile worker and this client. The compose file and its
`.env.example` live in the **server** repository under `deploy/`.

```bash
git clone https://github.com/ajcarlascio/noveltea-server.git
cd noveltea-server/deploy
cp .env.example .env        # set the secrets it names
docker compose up -d
```

Published images, built for amd64 and arm64:

```
ghcr.io/ajcarlascio/noveltea-web:0.1.0
ghcr.io/ajcarlascio/noveltea-api:0.1.0
ghcr.io/ajcarlascio/noveltea-worker:0.1.0
```

Note the tag has no `v` — the release tag is `v0.1.0` but the image tag is `0.1.0`.

**Signing in the first time.** A fresh server creates `admin@localhost` / `admin` and
refuses to let that password stand: anything under twelve characters marks the account
`must_change_password`, and the API answers `403` to everything except the route that
fixes it. You land on **Choose your password** instead of the projects list.

**Making more accounts.** Self-registration is off by default — on your own instance, an
account comes from you. An administrator gets an **Accounts** item in the header to create
them; a new account's password is shown once and must be changed on first use. That screen
is also the only recovery path on an instance with no mail server, which most are.

### Building the client image yourself

```bash
git clone --recurse-submodules https://github.com/ajcarlascio/noveltea.git
cd noveltea
docker build -t noveltea-web .
```

The client is a static bundle behind nginx, which also proxies `/api` to the API
container so both answer on one origin. That is what lets the server's CORS allow-list
stay empty — and an empty allow-list means no other origin can drive your client. Serve
them from two hostnames and you have to tell the server about this one.

Three things `deploy/nginx.conf` does that matter:

- Sends `frame-ancestors 'none'` as a **header**. The build-time policy arrives in a
  `<meta>` element, where browsers ignore that directive.
- Sends no `Cross-Origin-Embedder-Policy`. The replica uses sqlite-wasm's SAH Pool VFS
  precisely so it needs no `SharedArrayBuffer`, so `require-corp` would cost every
  cross-origin resource later and buy nothing.
- Forwards `X-Forwarded-For`. The API's rate limiter reads its first entry; without it
  every caller arrives as the proxy and one person guessing a password throttles everyone.

If you serve the built bundle yourself instead, send the Content-Security-Policy as a
**response header** as well as the one the build puts in a `<meta>` element, and add
`X-Frame-Options: DENY`. A `<meta>` policy cannot express `frame-ancestors` and does not
reach worker contexts at all, so the database worker is ungoverned without a header.

### From source

Node 22.6 or newer, matching the server's packages.

```bash
git clone --recurse-submodules https://github.com/ajcarlascio/noveltea.git
cd noveltea
npm install
npm run dev                 # http://localhost:5173
```

Already cloned without the submodule: `git submodule update --init --recursive`.

Point the client at `http://localhost:8080` and run the API with `docker compose up -d`
plus `./gradlew :api:bootRun` in the server repo.

> **The dev CORS trap.** The API sets CORS off unless configured. A browser client on
> `http://localhost:5173` must appear in the server's `noveltea.cors.allowed-origins`, or
> every request fails in a way that looks exactly like an auth bug. The desktop shell is
> not subject to this.

### The desktop app

```bash
npm run tauri dev           # run it
npm run tauri build         # deb, rpm and AppImage
```

The shell is deliberately thin — no SQL, no schema knowledge. Everything that
understands the database stays on the other side of the IPC boundary, where it is
already tested against real SQLite.

- **The database is a real file**, not webview storage. WebKitGTK, the engine Tauri uses
  on Linux, exposes no `navigator.storage` at all. The webview holds the database in
  memory and hands the whole thing over after every write; the shell writes it to a
  temporary file, flushes, renames it over the target and flushes the directory, so a
  crash mid-write leaves the previous database rather than a half-written one.
- **A save that is not a SQLite file is refused.** Those bytes are the manuscript, and
  the app deliberately does not interrupt an author to report a failed save — so nothing
  downstream would notice a truncated export replacing the only copy.
- **Only one instance runs.** Two windows would be two in-memory databases writing one
  file, and the later flush would silently discard the other's work.
- **The updater ships from the first build**, because anyone who installs a build without
  it can never auto-update. The public key is in `tauri.conf.json`; the private key is
  not in this repository.

---

## Using NovelTea

### Organising a book

The **binder** on the left is the manuscript's shape: folders and documents, dragged into
order, with a trash that is a move rather than a delete — a trashed chapter keeps syncing
and comes back intact.

Three views of the same thing, because the question changes:

- **Write** — one document, full width.
- **Corkboard** — index cards for one level, showing each scene's summary. For
  rearranging six scenes.
- **Outline** — every folder and document at once as a sortable table: summary, label,
  status, word count, with a folder showing the words beneath it. For checking pace
  across forty scenes.

### Marking things up

- **Labels and statuses** — a coloured label ("Bob's POV") and a status ("First draft")
  on any item, shown in the binder row and on the cards.
- **Collections** — either a list you fill by hand, or a saved search that fills itself
  ("every scene Marlowe appears in") and keeps up as you write. Both are answered from
  the local database, so they work with no network.
- **Custom fields** — questions you define once and every item can answer: "Age", "Eyes",
  "First appears". Text, number, date, yes-or-no, or a list of choices. This is what a
  character sheet is made of.

### Writing

The editor does smart quotes, dashes and ellipses as you type, and nothing else clever.
Typography — reading font, size and measure — is per device and never syncs, because a
phone and a desktop should not argue about line length.

- **Word lookup** — an offline thesaurus. It ships with the app and sends nothing
  anywhere. A stronger online lookup exists behind an explicit, per-feature consent.
- **Word targets** — a line under the title showing what you wrote today and how much of
  the book exists, against targets you set. Today is measured from a baseline taken when
  the day began, so deleting a chapter takes the number down.
- **Snapshots** — every save keeps history you can read and restore. Manual snapshots
  sync; automatic ones stay on the device that made them.
- **Comments** — anchored to the quoted words, not to a position, so an edit elsewhere
  cannot move them. A comment whose words are gone is reported orphaned rather than
  silently relocated.

### Finding things

Full-text search over titles, summaries, body text and notes, answered from the local
index. Quoted `"exact phrases"` and `-excluded` terms both work. The trash is excluded
unless you ask for it.

### Getting a manuscript out

**Compile** turns the binder into one document. It is the only feature that needs a
server: the export pipeline runs there.

Before anything is sent, a pre-flight says what the export will actually contain —
folders hold no prose, empty documents contribute nothing, trashed items are excluded,
and summaries and notes are never exported.

**Presets** save a submission format: a name, a format, and which parts of the binder are
in it. Pick it once and export from it for months.

This edition compiles to plain text, Markdown and HTML. The HTML export is standard
manuscript format — double-spaced, one-inch margins, page numbers in the footer — so
printing it or saving it as PDF gives you what an agent asks for. DOCX, RTF, EPUB and PDF
are shown and disabled rather than hidden; they belong to a paid edition, and the server
answers `501` for them rather than pretending they do not exist.

### Syncing

There is no central service, so **the server address is the first thing you are asked
for**. Addresses you have used are offered in a dropdown.

Signing in is about syncing, not access: the manuscripts are in the local database and
are yours whether or not a server is reachable. Sync is automatic, or on demand, and can
be held until you are off mobile data.

When two devices edit the same document apart, **prose is never merged.** The losing
version becomes a copy beside the original for you to reconcile. Only the tree — where
things sit and what they are called — resolves automatically.

---

## How it works

**The constraint that shapes everything:** the app must work with no server. Not
"degrade gracefully" — work. Every feature above except compile is answered from a SQLite
database on the device, and the network is a thing that sometimes improves matters.

That database is the source of truth, not a cache. The UI reads and writes it directly;
sync is a separate engine that reconciles it with a server later. On the web it is
sqlite-wasm over OPFS in a worker; on the desktop it is a file the Rust shell keeps.
Outgoing changes queue in a table, so closing the laptop mid-sentence loses nothing.

React, TypeScript, Vite, TipTap over ProseMirror, Tauri v2 for the shells. Colour lives
in exactly one place, `src/styles/tokens.css`; a value that is not a `var(--token)` cannot
follow the theme.

`docs/architecture.md` has the reasoning behind the three structural choices — why not
React Native, why TipTap, where the sync engine lives.

---

## Development

`docs/contributing.md` is the contributor guide: the eight invariants, the traps, and how
the tests are expected to be written. Read it before changing anything in `src/data/`,
`src/sync/` or `src-tauri/`.

```bash
npm test                    # unit tests (vitest)
npm run typecheck           # tsc over src and the Node-side config
npm run lint                # eslint, zero warnings tolerated
npm run build               # typecheck, then production bundle
npm run test:e2e            # Playwright, against the production build
npm run licenses            # dependency licence audit
```

**Dependency licences: MIT, Apache-2.0 or BSD only.** No copyleft, and nothing needing
payment to a vendor — this is distributed to people who must be able to run what they were
given. `npm run licenses` fails the moment a disallowed licence appears. Anything under the
`@tiptap-pro/` scope is a gated commercial registry and must never appear in
`package.json`, even transitively. The desktop shell's Rust dependencies are audited
separately; see `src-tauri/LICENSES.md`.

**Testing on real devices.** `npm run dev -- --host` serves on the LAN. The phone layout
has its own Playwright project with a 44px hit-target sweep, but a real thumb on a real
screen still finds things the sweep does not.

---

## Licence

[Elastic License 2.0](LICENSE.md). You may run it, modify it, and sell what you write with
it. You may not offer it to third parties as a hosted service, or remove its licence-key
functionality.
