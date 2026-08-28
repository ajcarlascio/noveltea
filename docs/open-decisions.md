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

**Normalise on the server rather than picking a winner.**

The defect is real: TipTap's StarterKit emits `bold` and `italic`; the server's
`packages/compile` recognises `strong` and `em`. Wired together as they stand, every bold
and italic in a manuscript compiles to unmarked text with a warning.

Rather than forcing one vocabulary on the other, the server gains a normalisation step
ahead of compilation that maps the known pairs — `bold` to `strong`, `italic` to `em`, and
the `bulletList` / `bullet_list` spelling that `compile` currently accepts both of. It
belongs on the server because that is where the compiler is, and because a manuscript
written by an older client must still compile correctly years later; a fix that only
exists in the editor cannot reach one.

Still needs writing. It is a server change, tracked there.

### 4. How this repo consumes `@noveltea/client-db`

**Git submodule**, which is what is in place at `vendor/noveltea-server`.

The wider answer is the same as (1): separate repositories, non-core ones private, images
built per version and per release.

### 5. Token storage

**The access token stays on the client, in memory. Nothing else changes.**

This was never open — `CLAUDE.md` already records it, along with the reasoning that the
exception rests on rotation, single use and the CSP together.

This supersedes part of a decision taken on 27 August, which had the desktop shell moving
tokens into the OS keychain. Moving the *network layer* into Rust still stands; moving the
tokens does not.

### 6. Android

**In scope for v1 as code. Lowest priority to ship.**

Tauri v2 reaches Android from the same codebase, so building it is cheap. Publishing is
not: a personal Play Console account must run a closed test with twelve testers opted in
continuously for fourteen days before it can reach production, and **those testers have
not been found**. The clock cannot start until they are, so the store submission sits at
the bottom of the list while the code is kept building.

`.github/workflows/mobile.yml` builds it on request for exactly this reason — to keep the
code honest without pretending the store path is close.

---

## Still open

### 7. UI state library

The previous version of this document said a recommendation lived in `CLAUDE.md`. **It
does not** — there is no mention of a state library there at all, which a reviewer
correctly noticed when they went looking for it.

So this is genuinely undecided, and is the most reversible item here. The working position
is that SQLite remains the source of truth and any in-memory store is a projection of it,
never a second replica; whether that projection needs a library at all is unanswered, and
nothing built so far has needed one.
