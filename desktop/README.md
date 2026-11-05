# Papilot Desktop

The desktop app reuses the existing React + TypeScript + Vite interface. Electron owns the window and starts the Fastify server with a bundled, ordinary Node runtime. This keeps `node:sqlite`, agent subprocesses and the review engine compatible without Electron-specific native rebuilds. There is no second UI framework or duplicate frontend.

## Build and run

Use macOS or Linux and an official Node.js distribution, version 22.22 or newer. The build bundles the Node and npm used by the build command. It includes the tested Codex version; Git, LaTeX and other agent CLIs remain host tools.

```sh
npm ci
npm run desktop          # build the UI and open a development window
npm run desktop:build    # build installers for this OS and CPU
```

Artifacts are in `release/desktop/`. macOS produces DMG and ZIP files: Apple Silicon uses `mac-arm64/Papilot.app`; Intel uses `mac/Papilot.app`. Linux produces AppImage and deb files; the unpacked binary is `linux-unpacked/papilot` on x64 or `linux-arm64-unpacked/papilot` on ARM64. Build on each native architecture: the bundled Node, Codex and dependency binaries must match it. `npm run desktop:build -- --dir` builds only the app directory.

Linux release CI builds on Ubuntu 22.04 x64. Other Linux versions and desktop environments need their own compatibility checks. The AppImage is a portable executable; the deb installs Papilot in the application menu and declares Git and desktop library dependencies. Install Git separately when using AppImage, and TeX Live to compile manuscript edits. The included demo PDF can be read without TeX. Windows packaging is not implemented yet; the review engine's POSIX process handling and agent CLI launching need adaptation before a Windows release.

After downloading an AppImage, grant execute permission with `chmod +x Papilot-*.AppImage`. If FUSE is unavailable, run it with `APPIMAGE_EXTRACT_AND_RUN=1` to use temporary extraction instead. The deb can be installed with `sudo apt install ./Papilot-*.deb`.

After changing desktop TypeScript, run `npm run desktop:compile`. After changing web code, run `npm run build`. Restart the development app to pick up those changes.

```sh
npm run test:desktop
PAPILOT_DESKTOP_EXECUTABLE="$PWD/release/desktop/mac-arm64/Papilot.app/Contents/MacOS/Papilot" npm run test:desktop
```

The smoke test opens the real app with temporary data, exercises the local API and update UI, checks origin isolation and SQLite, and verifies both shutdown and persistence across a restart. It does not connect agents or submit prompts. On Linux, run `xvfb-run -a -s '-screen 0 1600x1000x24' bash scripts/check-desktop-linux.sh` in a disposable test machine with Openbox, Xvfb and the Electron system libraries installed. This tests the unpacked app, the actual AppImage with extract-and-run (no FUSE required), and the installed deb. The final step installs the local deb using sudo. Native and CI tests keep the Chromium sandbox enabled; `PAPILOT_DESKTOP_TEST_CONTAINER=1` is a test-only opt-out for disposable Docker containers that cannot create nested user namespaces.

## Runtime

- On first launch, an editable copy of the Papilot example paper appears with a prebuilt PDF and source mappings. Reading it does not require TeX. Install LaTeX to compile revisions. Updating the app preserves edits; removing the demo does not recreate it on the next launch.
- Mac traffic lights and Linux window buttons sit in the sidebar's drag area, and the existing content toolbar reaches the top of the window. There is no extra title bar or duplicated brand/title row. Hiding the sidebar reserves space for the window controls. The sandboxed preload exposes window controls, a native directory picker, and path lookup for dropped files; the main process accepts IPC only from its own top-level app page.
- Choose or drop a local paper folder to open it in place. Only its path is sent to the backend, with no upload size or file count limit. Existing configuration and nearby main documents are checked first; compilation starts when you choose **Prepare and compile**. ZIP imports still upload a separate copy.
- Compilation runs as fast as latexmk in the paper's folder: each build continues from the previous one, keeping latexmk's state, and the first build continues from the author's own latexmk output in `<main folder>/build`. **Recompile PDF** starts clean. See [Compilation performance](../docs/performance.md).
- Data: `~/Library/Application Support/Papilot` on macOS, `$XDG_CONFIG_HOME/Papilot` (normally `~/.config/Papilot`) on Linux, separate from the CLI's `~/.papilot`. Add existing paper repositories through the usual UI. `PAPILOT_DESKTOP_DATA` selects another data directory for testing.
- Logs: `~/Library/Logs/Papilot/backend.log`, also available from Help → Show Logs.
- Settings → Notifications enables native system alerts for questions, approvals, reviews, completed tasks and errors while Papilot is in the background. On macOS, **Play a sound** controls the system notification sound; **Send a test notification** tests both. Linux notification sounds are managed by the desktop environment's settings, because Electron's libnotify backend ignores its `silent` option; Papilot does not offer an ineffective sound switch there. Notifications start off, and the macOS sound preference starts on. Click an alert to restore the window and open its task. System notification permissions, sound settings and Do Not Disturb still apply.
- One app instance owns the server. Closing the window on macOS hides it and keeps tasks and notifications running; Quit stops the backend. Closing the Linux window also quits the app and stops its backend. A crashed Electron parent disconnects its backend.
- The backend listens only on `127.0.0.1`, remembers its assigned port to preserve local drafts/preferences, and picks another port if the remembered one is occupied. That exceptional port change starts a new browser origin; database state remains intact.
- The app finds common agent and MacTeX/Homebrew locations even when opened from Finder. It uses existing agent sign-ins. An explicit proxy environment takes precedence; otherwise it passes the system HTTP proxy to backend tools.
- Updates download only Papilot's own code when they can. An installer is a shell (Electron, the bundled Node, Codex and the production dependencies) around Papilot's code, and the shell's fingerprint (`scripts/desktop-layer.mjs`) covers everything except that code: the Node major version, Electron, electron-builder and Codex versions, the production entries of both lockfiles, and the files in `desktop/` and `scripts/desktop.mjs`. Every full desktop build also packs Papilot's code as an update layer, `papilot-app-VERSION.tgz` (about 5 MB, versus about 330 MB for an installer), with a `desktop.json` manifest naming its version, fingerprint, size and SHA-256.
- Settings → Updates has the same **Stable** and **Dev (GitHub main)** channels as the web server. Stable reads `desktop.json` from the latest release (`releases/latest/download/desktop.json`), Dev from the rolling `desktop-dev` prerelease, which a nightly build of main updates. When the newest version's layer has this installer's fingerprint, **Update now** downloads it into `updates/desktop/layers`, verifies its size and hash, checks that it starts, and switches once tasks and PDF builds are idle; the page reconnects by itself. The layer runs on the installer's Node and dependencies through `node_modules` links, renewed at each launch because an AppImage mounts at a new path. Otherwise the update links to that release's installers. Returning to the installer's own version (for example from Dev back to Stable) needs no download.
- Electron owns the switch (`desktop/runtime.ts`): it backs up the database, starts the new code on the same port, and restores the database and the previous version if it does not start. A layer that later fails at launch falls back to the installer's own server with a notice. Installing another app version retires downloaded layers. The development app (`npm run desktop`) always runs its checkout and has no channel.
- Desktop update state lives in `updates/desktop/` (status, channel, active layer, lock and log). Legacy `updates/active.json` records and npm packages in `updates/releases` are ignored and left intact; web/CLI updates keep their own status, lock and stable/dev preference.

## Releases and signing

The Desktop workflow builds the app on native macOS ARM64, macOS x64 and Ubuntu x64 runners and launches it; it never publishes. A full build also makes every installer, launches the packaged app on all three platforms (on Linux also from the AppImage and the installed deb), and saves the installers and screenshots as Actions artifacts for seven days. Its quick form builds only the unpacked app (`npm run desktop:build -- --dir`) on macOS ARM64 and Ubuntu and launches it, skipping the installers that take most of a full build. CI decides with `scripts/desktop-scope.sh`: pull requests and pushes to main that can change the app get the quick form, and a pull request that changes the installer itself (its shell fingerprint) or how installers are made and tested gets a full build. Run workflow builds any branch, fully unless quick is checked. The version-tag release workflow first runs CI and a full build, then publishes npm, creates the GitHub release and attaches the tested `Papilot-VERSION-mac-ARCH.dmg/.zip`, `Papilot-VERSION-linux-x86_64.AppImage` and `Papilot-VERSION-linux-amd64.deb`. Rerunning a failed release job replaces its assets. No separate Electron version is maintained.

Each full build also runs `node scripts/desktop.mjs layer`. Every packaged smoke test builds a layer of its own, installs it from a local stand-in for GitHub, restarts on it and checks the fallback (on Linux once, with the AppImage, whose path changes at every launch; quick checks do this on macOS only). Stable releases attach `desktop.json` after the installers and `papilot-app-VERSION.tgz`, so a manifest that apps can read names only uploaded files. The Desktop Dev workflow runs a full build of main nightly at 19:00 UTC when main has new commits, or when it is run manually on main. Dev builds carry `PAPILOT_DESKTOP_REVISION`, so the bundled server and layer report `VERSION-dev.COMMIT`, and after every platform passes, `scripts/publish-desktop-dev.mjs` updates the `desktop-dev` prerelease: the layer and manifest every time, the six installers only when the fingerprint changed, and the tag moves to the commit. Assets the previous manifest names stay until the next build, so an app that just read it can still download them. Installed apps read the manifest and layer format: keep `desktop.json` and the layer layout compatible, or raise `LAYER_FORMAT` so older apps ask for an installer.

`desktopShell: 2` in package.json is a compatibility fence for older desktop installers that used npm updates. Their shell level is 1, so they direct users to a new desktop installer instead of activating this npm package. Keep this fence in future web releases. Current desktop apps do not use shell levels or npm overlays; only installing a desktop release changes their running version.

Local builds and CI without signing credentials use ad hoc signatures. These builds can be tested locally, but distributing them does not provide Developer ID/Gatekeeper trust. For signed, notarized release builds, configure these repository secrets:

- `MAC_CSC_LINK`: Developer ID Application certificate as an electron-builder-compatible base64 P12 or download URL.
- `MAC_CSC_KEY_PASSWORD`: certificate password.
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`: notarization credentials.

For a local signed build, electron-builder accepts `CSC_LINK` and `CSC_KEY_PASSWORD`, or an explicit `CSC_NAME` for a certificate already in the keychain. Otherwise the build deliberately uses ad hoc signing. See [electron-builder's macOS signing guide](https://www.electron.build/v26/docs/features/code-signing/code-signing-mac/).

The approved app icon uses the blue-and-white Papilot pen nib on a rounded tile with a white-to-light-blue background gradient. `desktop/assets/icon.svg` is its editable source; `icon.png` is the 1024×1024 export and `icon.iconset/` contains the 16–1024 px variants. The macOS builder uses `desktop/assets/icon.icns` directly. Run `node scripts/render-icon.mjs` on macOS with Google Chrome and the review Playwright dependency installed to regenerate these exports and `desktop/assets/icon-preview.png`. Release builds use the checked-in assets.

`desktop/assets/icon-composer/` contains unmasked background and foreground SVG layers for a future Icon Composer integration. These are source assets, not a compiled `.icon` project; the current Electron build uses the ICNS above.

The DMG uses `desktop/assets/dmg-background.svg`, rendered at 1× and 2× for Retina displays. Run `node scripts/render-dmg.mjs` with `rsvg-convert` installed to regenerate both PNGs. The fonts come from the existing web assets. To update the bundled example PDF after editing its sources, run `node scripts/build-demo-preview.mjs` with TeX Live/MacTeX installed. Release CI uses the checked-in previews and backgrounds.
