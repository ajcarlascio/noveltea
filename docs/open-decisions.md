# Decisions

Moved out of the README, where it did not belong, and then rewritten — because what was
moved was a list of *open questions* that had largely been answered, and moving it
unchanged asserted several things that were not true.

Numbering follows the original list so the review comments that corrected it still line
up.

---

## Decided

### 1. Public and private split

**Everything ships in Core, which is public. A private fork holds what is sold.**

Not a subset of features held back from the public repo's source, and not a private repo
holding only signing configuration: the whole application is public, and the paid build is
a separate private repository forked from it. Images are published **per version and per
release**, separately for each.

That is consistent with A7 in the server repo — no commercial code in the public tree, not
even disabled — and with the export split below.

### 2. Licence

**Elastic License 2.0**, the same as the server.

The earlier text claimed no licence file had been committed "deliberately". That was
already wrong: `license.md` carrying ELv2 has been in this repository since before the
claim was written. It is now `LICENSE.md` so GitHub's detection finds it, and
`package.json` declares `"license": "Elastic-2.0"`.

### 3. ProseMirror node and mark names

**Normalise on the server rather than picking a winner. Written, and in use.**

The defect was real: TipTap's StarterKit emits `bold` and `italic`; the server's
`packages/compile` recognised `strong` and `em`. Wired together as they stood, every bold
and italic in a manuscript would have compiled to unmarked text with a warning.

Rather than forcing one vocabulary on the other, the server normalises ahead of
serialisation. `MARK_ALIASES` in `packages/compile/src/text.ts` maps every spelling to one
canonical name — `bold` to `strong`, `italic` to `em`, and the same for underline and
strike — and `canonicalMark()` is what both serializers switch on, in `html.ts` and
`markdown.ts`. Node names accept both conventions the same way, so `bulletList` and
`bullet_list` are one type. It belongs on the server because that is where the compiler is,
and because a manuscript written by an older client must still compile correctly years
later; a fix that only existed in the editor could never reach one.

This entry said "still needs writing" for longer than it was true — the normalisation is
present in the very commit this repository's submodule pins. It is also guarded now:
`src/features/editor/__tests__/schema.node.test.ts` reads that alias map out of the
submodule at test time and fails if the editor's schema names a mark the compiler cannot
resolve, so the two cannot drift apart quietly again.

### 4. How this repo consumes `@noveltea/client-db`

**Git submodule**, which is what is in place at `vendor/noveltea-server`.

The wider answer is the same as (1): separate repositories, non-core ones private, images
built per version and per release.

### 5. Token storage

**The access token stays on the client, in memory. Nothing else changes.**

This was never open. The exception to "credentials belong in platform secure storage"
rests on three things holding together: the token rotates, it is single-use, and the CSP
keeps it from being read by anything the page did not ship with. Remove any one and it
stops being safe to hold in memory.

This supersedes part of a decision taken on 27 August, which had the desktop shell moving
tokens into the OS keychain. Moving the *network layer* into Rust still stands; moving the
tokens does not.

### 6. Android

**In scope for v1 as code. Lowest priority to ship.**

Tauri v2 reaches Android from the same codebase, which is why it is in scope at all.
**Whether it builds is not yet known**, and this entry used to imply otherwise. Tauri's
mobile support has never been initialised in this repository — `src-tauri/gen/` holds only
schemas, and `gen/android` and `gen/apple` are gitignored — so
`.github/workflows/mobile.yml` runs `tauri <platform> init` and builds what that generates.
It is a **spike, not a gate**: it runs on request, it has not passed yet, and until it has,
nothing here is evidence that the app builds for a phone. The substantive risk it exists to
answer is whether Tauri v2 mobile can carry this app's SQLite and OPFS use at all, or
whether a phone needs a different local store. That question is open.

Publishing is a separate and slower problem: a personal Play Console account must run a
closed test with twelve testers opted in continuously for fourteen days before it can reach
production, and **those testers have not been found**. The clock cannot start until they
are. So the store submission sits at the bottom of the list — but the twelve testers are
worth recruiting now regardless, because that fourteen days is wall-clock time that no
amount of engineering shortens.

---

## Still open

### 7. UI state library

The previous version of this document said a recommendation lived in the contributor
guide. **It does not** — there is no mention of a state library there at all, which a
reviewer correctly noticed when they went looking for it.

So this is genuinely undecided, and is the most reversible item here. The working position
is that SQLite remains the source of truth and any in-memory store is a projection of it,
never a second replica; whether that projection needs a library at all is unanswered, and
nothing built so far has needed one.
