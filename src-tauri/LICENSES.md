# Third-party licences in the desktop shell

The project's rule is MIT / Apache-2.0 / BSD (plus OFL-1.1 for fonts). Adopting Tauri
brings five **MPL-2.0** crates transitively, which are outside that list and cannot be
removed without dropping Tauri:

| Crate | Pulled in by |
|---|---|
| `selectors`, `cssparser`, `cssparser-macros`, `dtoa-short` | `dom_query` → `tauri-utils` → `tauri-build` / `tauri` |
| `option-ext` | `dirs-sys` → `dirs` → `tauri` |

MPL-2.0 is **file-level** copyleft, not project-level. Using these crates unmodified in
a larger work — including a proprietary or paid one — carries no obligation to release
the rest of that work. The obligation attaches only to changes made to the MPL files
themselves, and we make none: they are consumed from crates.io as published.

That is a materially different licence from the GPL family, and nothing in the tree is
GPL, LGPL, AGPL, CDDL or EPL — checked with `cargo tree --format '{p} {l}'`.

**Decided (August 2026): MPL-2.0 is accepted for transitive Rust dependencies.** The
allowlist for direct dependencies is unchanged — MIT / Apache-2.0 / BSD, plus OFL-1.1
for fonts. What this permits is weak, file-level copyleft arriving through a dependency
we do not modify, which does not reach the rest of the work and does not affect paid
builds. GPL, LGPL, AGPL, CDDL and EPL remain excluded outright.

To re-check after a dependency bump:

```sh
cd src-tauri
cargo tree --prefix none --format '{p} {l}' | grep -E ' MPL-2\.0$' | sort -u
cargo tree --prefix none --format '{p} {l}' | grep -iE 'GPL|CDDL|EPL'   # must stay empty
```
