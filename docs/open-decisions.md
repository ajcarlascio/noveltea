# Open decisions — for the owner

Moved out of the README: these are choices waiting on the project's owner, not
information a reader needs to run or use NovelTea.

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
