# NovelTea client — architecture and the decisions behind it

This document records three structural questions, the reasoning on each, and a clearly
marked recommendation. It is written so that a reader who disagrees can find the actual
argument and overrule it, rather than discovering a decision by reading source code.

Everything here assumes the constraint that is not up for discussion: **NovelTea is
offline-first, and the interface never awaits the network in order to render.** Each
decision below is downstream of that.

---

## 1. Can React Native cover web, desktop, iOS and Android?

The question as asked: use React Native for every platform, with
`react-native-device-info` driving per-device layouts, and get four targets from one
codebase.

The answer is that React Native is a good tool that is wrong *for this particular
application*, and the reason is narrow and specific: **the editor**.

### Why the editor decides this

NovelTea's document model is ProseMirror JSON, and ProseMirror is a DOM library. It works
by managing a `contenteditable` element, mapping browser selection and input events onto a
document model, and rendering that model back into DOM nodes. React Native has no DOM. It
does not have a slow DOM or a partial DOM; it renders to native view hierarchies, and
`contenteditable` has no counterpart there.

That leaves exactly two ways to run React Native for this app, and both are bad here:

**(a) Host the editor in a WebView.** `react-native-webview` can load a page that runs real
ProseMirror. But then the most important screen in the product — the one an author looks at
for six hours a day — is a web page inside a native shell, communicating with the app over
an asynchronous string-passing bridge. Selection state, cursor position, undo history, find
and replace, comment anchors, and the merge view all live on the far side of that bridge and
must be marshalled back and forth. You have shipped a web application inside a shell anyway,
and paid for a worse boundary than the one Tauri gives you for free.

**(b) Build a native rich-text editor.** iOS and Android both have capable text systems, and
a native editor would feel excellent. But NovelTea's document schema is a *contract*: the
server's `packages/compile` reads the same ProseMirror JSON to produce txt, md and html, and
every other export format derives from that HTML serializer. A native editor means a second
document model, plus a bidirectional mapping between it and ProseMirror JSON, and that
mapping is now the place where an author's formatting quietly fails to survive a round trip.
Two definitions of the document that must never drift is precisely the failure mode the rest
of this project is organised to avoid — it is why `@noveltea/client-db` lives in the server
repository rather than here.

There is also a smaller point worth stating: `react-native-device-info` answers "what device
is this", but layout questions are almost always "how much room do I have" — which is a
CSS/container-query question, and is answered correctly on a tablet in split-screen where a
device-model check is not.

### The alternative that reaches the same platforms

One web codebase, shipped as a browser application and wrapped by **Tauri v2**, which
targets desktop (Windows, macOS, Linux) *and* iOS and Android from the same source. The
editor is real ProseMirror on every target, because every target is a webview. Tauri uses the
system webview rather than bundling a browser engine, so shells are small — single-digit
megabytes rather than the hundred-plus Electron carries — and the native side is Rust with a
capability-scoped permission model.

### Trade-offs

| | React Native (WebView editor) | React Native (native editor) | Web + Tauri v2 **(recommended)** |
|---|---|---|---|
| Browser | via `react-native-web` — a third rendering path | via `react-native-web`, but the editor cannot follow | native target; it *is* the web app |
| Windows / macOS | `react-native-windows` / `-macos`, separately maintained | same | first-class |
| Linux desktop | no supported path | no supported path | supported |
| iOS / Android | first-class | first-class | supported; system webview |
| Editor fidelity | real ProseMirror, behind an async bridge | a second editor and a second model | real ProseMirror, in-process |
| Document model definitions | one | **two** | one |
| Codebases to keep in step | app + embedded web editor | app + native editor + web app | one |
| Native feel on mobile | excellent outside the editor | excellent | webview feel; good, not native |
| Per-device layout | `react-native-device-info` | same | CSS/container queries + `@tauri-apps/plugin-os` |
| Fits the existing plan | no — `@noveltea/client-db` targets wa-sqlite/OPFS, `tauri-plugin-sql`, GRDB | no | yes |
| Binary size | moderate | moderate | small (system webview) |

### Recommendation

**Web codebase + Tauri v2.** One source, real ProseMirror everywhere, native shells with OS
keychain access and filesystem export, and no second document model.

### What would justify overruling this

The argument above is about the *editor*. If the mobile apps were scoped as companions —
read the manuscript, capture notes, review comments, check word counts, with serious drafting
staying on desktop and web — then the balance changes, and a native mobile app with a
restricted editing surface becomes defensible. That path stays open precisely because the
sync engine is specified with no UI dependencies (see §3): a future native client can reuse
the protocol logic rather than reimplementing it.

It is also worth saying plainly: a webview editor on mobile will feel like a webview.
Keyboard handling, text selection handles and autocorrect are the places authors will notice.
If "feels native on iPhone" outranks "one document model", that is a legitimate priority and
this decision should be revisited before, not after, the mobile shells are built.

---

## 2. TipTap or raw ProseMirror?

### Recommendation: TipTap core (MIT), on top of ProseMirror

ProseMirror is the right foundation and is not in question — it is the only mature editor
whose document model is a real schema-validated tree, which is what makes reliable export and
conflict handling possible at all. The question is whether to use it directly.

Raw ProseMirror means writing, by hand, the schema declaration, the command set, keymaps,
input rules, the React integration, and the plumbing for every extension. It is all
well-documented work and it is all work. TipTap packages exactly that layer, is MIT, and —
crucially — **does not hide ProseMirror**: the `EditorView`, transactions, plugins,
decorations, and node views remain directly accessible. NovelTea will need them (comment
anchors that survive edits, decorations for the merge view), and TipTap does not stand in the
way.

The cost is a dependency whose vendor sells a paid tier. That is managed by a hard rule:
**nothing from the `@tiptap-pro/` scope, ever.** It is a gated registry; a self-hoster
building this client must be able to `npm install` it. Extensions that have historically
lived behind that scope — drag handles, unique node ids, table of contents — are ProseMirror
plugins underneath, and we write them here when we need them.

### The constraint that matters more than the choice

**Wherever the schema is defined, it must be defined once, and versioned.**

`document.content` is ProseMirror JSON. The editor writes it; the server stores it as opaque
`jsonb`; the server's `packages/compile` reads it and serialises it to txt, md and html, with
every other export format deriving from that HTML. The set of node and mark names is
therefore a contract between two codebases, not a preference inside one.

This is not theoretical. As things stand today:

- `packages/compile` recognises the marks `strong`, `em`, `code`, `link`, `underline`,
  `strike` — the `prosemirror-schema-basic` names.
- TipTap's StarterKit emits `bold` and `italic`.
- `packages/compile` accepts *both* `bulletList` and `bullet_list`, `codeBlock` and
  `code_block`, and so on — which is proof that no canonical set has been agreed.

Connected as they stand, every bold and italic run in a manuscript would reach the compiler
as an unknown mark. The compiler's rule is to keep the words and drop the formatting with a
warning — so the export would succeed, look plausible, and be wrong. Nothing would crash.

The fix is structural, not a rename:

1. Extract the schema into a package in the **server repo** — the same reasoning that put
   `@noveltea/client-db` there — exporting the node and mark definitions and a version.
2. Have `@noveltea/compile` derive its accepted set from that package instead of hand-written
   `Set`s.
3. Have the client's TipTap extensions derive from or be validated against it, with a test
   asserting the editor's generated schema matches.
4. Drop the dual naming once one convention wins. Either is fine; ambiguity is not.

Until that exists, adding a node type to the editor means adding its handling in `compile`
in the same change.

### One more boundary

**The editor does not talk to the backend.** It reads and writes document JSON against the
local store. Saving is a debounced local transaction plus a queue entry. The sync engine
does the rest, later, elsewhere. An extension that fetches is a design error, not an
optimisation.

---

## 3. Where does the sync engine live?

The question as asked: should the sync engine be a third repository — "middleware" — and
does that ruin offline-first?

Two different questions are tangled there, and they have different answers.

### As a running service: no. It would destroy offline-first.

If "middleware" means a process sitting between the client and the server, then every read
the client makes crosses a network boundary to reach it, and the application's defining
property is gone. The author on a plane now has a UI that cannot reach its data. Even
running locally, a separate process is one more thing to install, start, crash, and version
against the app that depends on it.

There is nothing in NovelTea's protocol that needs a mediator. The server is the authority,
the client holds a full replica, and reconciliation is a bounded conversation between the
two.

### As a library: yes, and it should be its own package.

The engine is a well-defined, testable, UI-free unit: cursor management, paginated pull,
queue draining, push, conflict classification, epoch handling, retry and backoff. Isolating
it is straightforwardly good — it is the part of the client most worth testing in isolation
and least worth reimplementing per shell.

### Which repository

| Option | Consequence |
|---|---|
| **Server repo, as `@noveltea/sync` alongside `@noveltea/client-db` (recommended)** | Protocol, local schema and reconciliation logic version together. A protocol change lands in one commit with the code that consumes it. |
| A third repository | Two cross-repo relationships instead of one, both requiring lockstep releases. This is the exact problem that put `client-db` in the server repo; repeating it deliberately would be strange. |
| This repository | The engine depends on the wire protocol and on `client-db`'s tables. Owning it here means the server can change the protocol and break a client repo that has no way to notice at build time. It also makes reuse by any future native client harder. |
| Duplicated per shell | Four subtly different implementations of the one piece of logic where subtle differences lose an author's work. |

The engine is coupled to two things the server owns — the wire protocol and the local schema
— and to nothing this repository owns. Coupling should decide placement.

### Rules for the package

- **No UI dependencies.** No React, no DOM, no bundler assumptions, no direct filesystem
  access. It takes a storage adapter (the same tiny `exec`/`query` shape `client-db` already
  uses), an HTTP fetcher, a clock, and a token provider. That is what lets the same engine
  run under the browser worker, under Tauri, headless in tests, and — if a native client is
  ever built — there too.
- **It is the only writer of `sync_state`.** The UI reads that table; it never writes it.
- **It never renders and never decides UX.** "There is a conflict copy" is a fact it records;
  what the author is shown about it is this repository's business.
- **It is driven, not autonomous.** The shell decides when it may run — the connectivity
  timer, the wifi-only setting, a manual "sync now", app lifecycle events. The engine
  exposes `pull()`, `push()`, `sync()`; it does not own a scheduler that a shell cannot
  observe.

### What it must implement

Summarised in `CLAUDE.md` under "The sync engine"; the authoritative description is the
server's own `CLAUDE.md`. The parts most easily got wrong: advancing the cursor only to the
`latestId` actually served; resuming a forced resync at the returned `latestId` rather than 0
(resuming at 0 loops forever); preserving the queue across a resync because it holds unsent
work; preserving `baseVersion` when coalescing repeated edits; and not retrying a
`not_implemented` conflict in a loop.

---

## 4. Public/private split

The stated wish is that only the web portion be public. With the architecture recommended
above, that is awkward to honour literally, and it is better to say so than to build a
convincing-looking seam that is not one.

Under Tauri, the web application *is* the desktop and mobile application. `src/` is shared
entirely; what is genuinely platform-specific is a small `src-tauri/` directory (Rust
entry point, capability manifest, icons, bundler config) plus the release pipeline. Splitting
"web" from "desktop/mobile" therefore does not divide the product along the line the question
implies — it divides one application from its packaging.

Three realistic options:

**(a) All public.** Simplest, and the most consistent with a self-hosted product: someone who
runs their own server can build their own client, which is much of the point. Commercial
features already live behind the server's open-core line, and this client only ever *renders*
what a server offers, so there is little of commercial value in this repository to protect.
Store credentials and signing keys stay out regardless — those belong in CI secrets, not in a
private repo.

**(b) All private, publishing built artifacts.** Protects nothing that (a) exposes, and costs
the credibility benefit of an auditable client. For an app that holds an author's unpublished
manuscripts and asks them to trust it with a bearer token, an inspectable client is an asset.

**(c) Public core, private release configuration.** This repository public; a small private
repository holding signing configuration, store metadata, notarisation and release workflows.
Preserves most of (a)'s benefits, keeps the commercial packaging closed, and costs one extra
repository plus a slightly awkward release path.

**Recommendation: (a), or (c) if the packaging genuinely needs to stay closed.** What is not
recommended is trying to split `src/` itself into public and private halves — the split
would run through the middle of features, and every change would have to decide which side it
falls on.

This is the owner's call, and it needs making before there is a commit history to rewrite.

---

## 5. How a change actually flows

Three walkthroughs, because the layering only makes sense in motion.

**An author types a sentence.** TipTap applies a transaction; the editor state updates
synchronously and the screen repaints. A debounce fires: the document JSON and its extracted
plain text are written to the local SQLite `document` row, and `enqueueChange()` records a
pending `update` carrying the `baseVersion` this client last *synced* — not a locally
incremented one. Nothing has touched the network. If the process dies here, the work is on
disk and the queue remembers it is unsent.

**Sync runs.** Fifteen minutes of stable connectivity elapse (or the author hits "sync now").
The engine marks queue entries attempted, pushes them, and applies the response: entries in
`applied` are cleared and their new versions recorded; entries in `conflicts` are handled by
reason. Then it pulls from its cursor, applying pages until `hasMore` is false, advancing the
cursor only as far as the server actually served. The UI, which is reading the same tables,
updates because its data changed — not because it was told a request finished.

**A conflict appears.** Another device edited the same chapter. The push returns
`version_mismatch` with a `conflictCopyId`; the server has already created a sibling binder
item holding this device's rejected text, and it is linked by `conflict_of_id`, never by
title. The next pull brings that item down like any other. The binder shows it, flagged; the
author opens a merge view showing both versions side by side and chooses. Resolving trashes
the copy rather than deleting it, because a bad merge must stay recoverable. At no point was
anything merged automatically, and at no point did the author lose words.
