# Releasing

A release is three things: installers people can download, a `latest.json` the shipped
updater can read, and a version number that matches all of them.

## Once, before the first release

Two repository secrets. Without them `.github/workflows/release.yml` stops before it
builds anything, which is deliberate — an unsigned release installs perfectly and then
carries an updater that will reject every manifest this repository ever publishes.

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY < /path/to/noveltea-updater.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD      # paste the passphrase
```

The public half is already in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`
and is compiled into every build. **Replacing the key pair orphans every copy of NovelTea
already installed** — they verify against the key they shipped with, so a new key means
they will refuse every future update and their owners have to reinstall by hand. Losing
the private key has the same effect. Keep it somewhere you will still have it in five
years.

If a key is ever lost: bump the major version, ship the new public key in it, and tell
people to download once more. There is no way to sign for a binary that trusts a key you
no longer hold.

## Every release

1. **Bump the version in three places, together.**

   - `package.json`
   - `src-tauri/Cargo.toml`
   - `src-tauri/tauri.conf.json`

   The workflow's first job fails the build if these disagree with the tag, because the
   failure it prevents is invisible: `tauri-action` names every artifact after
   `tauri.conf.json` and writes that version into `latest.json`, so tagging `v0.2.0`
   against a config still reading `0.1.0` produces a release full of files called 0.1.0
   and a manifest offering 0.1.0 to machines already running it. Nothing errors. The
   updater simply never fires again, and you find out when somebody asks why they are
   still on the old version.

2. **Tag and push.**

   ```bash
   git tag -a v0.2.0 -m "NovelTea 0.2.0"
   git push origin v0.2.0
   ```

3. **Wait for the three platforms.** macOS builds a universal binary; Linux and Windows
   build native. Roughly twenty minutes.

4. **Read the draft release, then publish it.** The workflow leaves it a draft on purpose.
   The updater asks for `releases/latest/download/latest.json`, and a draft is not
   "latest", so nothing is offered to anybody until you press Publish. That is the gate:
   once it is published, every desktop copy will offer this version the next time it
   starts.

5. **Check `latest.json` is actually attached** to the release, alongside the installers.
   It is the only file that matters to an existing installation.

## What the updater does

The desktop app checks once, on startup, and never again while it runs — an app left open
overnight should not spend the night asking GitHub about a number that changes a few times
a year. A newer version appears as a line in the header with **Install and restart** and
**Not now**. A failed check says nothing at all: being offline is this app's normal state,
and an author who cannot reach GitHub has lost nothing.

The signature is verified on the Rust side against the compiled-in public key before
anything is installed. Nothing in the webview decides whether an update is genuine.

## Container images

Separate and automatic: `.github/workflows/publish.yml` pushes
`ghcr.io/ajcarlascio/noveltea-web` on every push to `main` and on every `v*` tag. The
image tag has no `v` — the release is `v0.2.0`, the image is `0.2.0`.
