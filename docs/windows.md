# Windows setup

Windows support is available from Papilot 0.9.1. Download the Windows x64 installer (`Papilot-VERSION-win-x64.exe`) or portable app (`Papilot-VERSION-win-x64-portable.exe`) from [GitHub Releases](https://github.com/PapilotAI/papilot/releases/latest). The installer lets you choose an installation folder and adds Start menu and desktop shortcuts; the portable app runs without installation. Both include Node.js and npm; install Codex yourself. Windows installers are unsigned. The desktop workflow builds and tests Windows x64 alongside macOS and Linux.

## Choose an environment

The Windows desktop app recommends **WSL** on first launch. The setup screen detects installed distributions and checks Node.js/npm, Git and LaTeX in the selected environment. Missing tools get links to their official installation guides; **Check again** refreshes the results after installation. An existing environment selection is preserved. You can change it in **Settings → General → Environment**, or the **Environment** app menu.

- **Windows** uses the Windows installations of Git, TeX and agents, and stores app data under `%APPDATA%\Papilot`.
- **WSL** keeps the same Windows window but runs Papilot's backend, Git, TeX and agents inside the selected Linux distribution. Agent sign-ins stay in that distribution. App data is under `~/.local/share/papilot-desktop/data`, separate from Windows and from other distributions.

If WSL is missing, the setup screen offers a copyable `wsl --install -d Ubuntu` command and Microsoft's installation guide. Run it in an administrator PowerShell, restart if requested, then open Ubuntu to finish its first setup. Inside that distribution, install Linux Node.js LTS (22.22+), npm, Git and TeX Live. Windows tools do not count as Linux dependencies. Choose the distribution and click **Prepare WSL**. This installs Papilot's Linux dependencies in its own user directory, without using Windows `node_modules`. Install Codex inside the distribution too (`npm install -g @openai/codex`); a Windows Codex does not count. The first setup needs access to your npm registry from WSL; subsequent launches use the prepared copy. Failed or canceled setup can be retried, with details available in an expandable log.

The Windows runtime already includes Node.js and npm. Version Management is disabled when Git is missing in the selected backend environment, with a link to installation instructions. Normal workspace refreshes detect Git after installation and enable the entry; restoring a saved page cannot bypass the check. The example PDF can be read without Git or TeX, including after a restart. Installing Git initializes version management for the same example project while preserving its source edits and notes. An edited source is never marked as matching the bundled PDF; compiling edits requires Git and TeX. WSL preparation requires Linux Node.js and npm. Tool detection checks the TeX commands (`latexmk`, `synctex` and a LaTeX engine); a paper may need additional TeX packages. Agent sign-in is checked separately inside the workspace.

The folder picker starts in `\\wsl.localhost\DISTRIBUTION\home`. Prefer keeping WSL papers in the Linux filesystem. Windows drive folders are translated using that distribution's `wslpath`; folders in another distribution are rejected. Switching keeps each environment's paper list and tasks, and requires running tasks to finish or stop first. It does not move papers or copy agent credentials between environments.

WSL localhost forwarding must be enabled so the Windows window can reach the Linux backend. WSL uses its own proxy configuration. Use a packaged Windows app, including an unpacked `desktop:build -- --dir` build, for this mode; a development checkout needs the generated `.desktop/wsl` payload first.

## Build and run

Install an official Node.js distribution (22.22 or newer) and Git for Windows, then open a new PowerShell window. Install TeX Live for Windows to compile papers; `latexmk`, `pdflatex`/`xelatex`/`lualatex` and `synctex` need to be available. TeX Live includes the Perl runtime needed by latexmk. A MiKTeX installation must also provide latexmk and its required Perl runtime. The desktop example PDF can be read without TeX.

```powershell
node --version
git --version
npm.cmd ci
npm.cmd run desktop
```

Use `npm.cmd` if PowerShell's execution policy prevents npm's `.ps1` launcher from running. No execution-policy change is needed. Build in a folder owned by your user, rather than inside `Program Files`.

```powershell
npm.cmd run desktop:build
# Or build just the unpacked app:
npm.cmd run desktop:build -- --dir
```

The installer is `release/desktop/Papilot-VERSION-win-x64.exe`; the portable executable is `release/desktop/Papilot-VERSION-win-x64-portable.exe`, and the unpacked executable is `release/desktop/win-unpacked/Papilot.exe`. Build on Windows with a Node runtime matching the target CPU. Native release CI currently targets x64. The installer bundles Node and npm; Git, TeX, Codex and other agent CLIs are host tools. Unsigned development installers do not have a trusted publisher signature.

For the browser/server version from this checkout:

```powershell
npm.cmd run setup:review
npm.cmd run build
node bin/papilot.mjs doctor
node bin/papilot.mjs --data "$env:USERPROFILE\Papilot data"
```

Desktop data is under `%APPDATA%\Papilot`; CLI data defaults to `%USERPROFILE%\.papilot`. Use the desktop folder picker for local drive paths and UNC shares. Chinese characters and spaces in paths are supported. Paths in a paper's `.git/papilot/settings.json` are relative to the repository; either separator is accepted and stored paths use `/`. Do not put an absolute drive path in its `main` field.

Papilot discovers the usual npm, Git for Windows, TeX Live and MiKTeX locations in addition to PATH. Restart Papilot after installing host tools. Commands installed by npm are launched through their Node entry points so multiline prompts and shell characters remain literal arguments. Stopping a build terminates its process tree. Windows runs background builds without the Unix-only pause/resume optimization.

Dependency links for downloaded app updates use Windows directory junctions and need no Developer Mode. Repositories containing actual symbolic links still require Windows symlink permissions when the engine exports those links (enable Developer Mode or use a repository without symbolic links).

## Codex approvals

Codex defaults to **Workspace access**, using the `workspace-write` sandbox and `on-request` approval policy. Selecting **Full access** in the agent settings explicitly disables the sandbox and uses `never`, subject to managed settings. Independently of that choice, Papilot reads the effective `approvals_reviewer` setting for the task directory before each turn and passes it to new threads, resumed threads and already loaded conversations. User, project and selected-profile reviewer settings remain authoritative; inheriting a reviewer does not change the selected permission mode or automatically accept requests. On Codex versions without the configuration API, the existing reviewer defaults are retained.

To use automatic review, configure `approvals_reviewer = "auto_review"` in the appropriate Codex environment. Windows and WSL have separate Codex configuration and sign-in state. Automatic review can still deny an action; it does not remove the filesystem sandbox. If a Windows sandbox cannot enter an otherwise writable worktree, inspect its ancestor directory traversal permissions and the Codex sandbox setup logs rather than disabling the sandbox.

## A new machine on a restricted network

The machine does not need a proxy just to receive files from another computer on the same LAN. Download official Node, Git and TeX installers on a machine with working access, then transfer them over the LAN. `node_modules` contains OS-specific binaries: do not copy a Mac's installed dependency tree to Windows. Run `npm.cmd ci` on Windows, or prepare a package with Windows-native dependencies.

For source builds, npm packages, Electron binaries and electron-builder's installer tools are separate downloads. Setting an npm registry alone does not redirect all of them. If needed, configure your own reachable proxy in the PowerShell session before installing dependencies:

```powershell
$env:HTTP_PROXY = 'http://YOUR_PROXY_HOST:PORT'
$env:HTTPS_PROXY = $env:HTTP_PROXY
$env:NO_PROXY = 'localhost,127.0.0.1,::1'
npm.cmd ci
```

The proxy must listen on a LAN interface if it runs on another computer. Agent sign-in and API calls also need access to that provider, independently of installing Papilot. A desktop launch uses the Windows system HTTP proxy when explicit proxy variables are absent.

## Verification

```powershell
npm.cmd run typecheck
node --import tsx --test tests/windows.test.ts tests/wsl.test.ts
$env:PAPILOT_DESKTOP_EXECUTABLE = "$PWD\release\desktop\win-unpacked\Papilot.exe"
npm.cmd run test:desktop
node scripts/check-desktop-environments.mjs
```

The focused tests check Unicode/spaces, drive and UNC path rejection where a relative path is required, npm `.cmd` launchers with multiline arguments, SyncTeX source lookup, dependency junctions, descendant process cleanup and a real SQLite backend startup/shutdown. The desktop smoke test checks the window, demo PDF, imports, persistence and app updates. On Windows it also uses `WM_NCHITTEST` to verify that all three window buttons receive client clicks in normal, maximized and compact layouts, including Version Management. Browser-simulated clicks alone bypass native drag regions and cannot catch buttons that Windows treats as title-bar drag handles (issue #152). Run the desktop smoke test in an interactive Windows desktop session; a background SSH session alone is not a substitute for GUI verification.

Initial validation used the 0.9.0 source base (`64afda0`) with these Windows changes on a native Chinese Windows 11 Home x64 machine (build 26200), using Node 24.22.2, Git 2.56.0 and TeX Live 2026 on 2026-11-06:

- All 10 Windows-focused tests and TypeScript checks passed.
- Real PDF compilation, revision rebuilds and cached PDF reuse passed in a directory containing Chinese characters, spaces and `&`, including SyncTeX source lookup after each build. Legacy GBK SyncTeX paths are handled without changing the compiler's encoding on disk.
- The packaged desktop smoke passed in an interactive desktop session, both from the unpacked build and after installing the NSIS installer: demo PDF, native folder opening, window controls, notifications, persistence, dependency junctions, downloaded app updates and rollback. Installed-app checks also passed for top-right Windows window controls, the 900px-wide layout and the Version Management workspace from 0.9.0.
- The first-launch environment chooser and switching from Settings passed with separate app data for each environment.
- WSL 2 with Ubuntu 24.04, Linux Node 24.22.2, Git 2.43.0 and TeX Live 2026 passed the Windows GUI integration: preparation, opening and compiling papers in both the Linux filesystem and a Windows drive, PDF display, backend shutdown and switching back to native Windows. Folder names included Chinese characters, spaces and `&`. Real Linux compilation, revision rebuilds, cached PDF reuse and SyncTeX source lookup also passed.
- The WSL bridge also passed downloaded update activation, Linux dependency links, restart persistence and fallback after an updated backend failed to start.

The integration based on PR #72 (`4896713`), including the changes from main (`5ae19cb`), also built the NSIS installer, portable executable and update layer on Windows. Its packaged app passed native launch, environment selection, WSL compilation, update activation and rollback checks.

After independent WSL device sign-in, the integrated app completed two real Codex editing turns in an isolated Linux paper with Chinese characters, spaces and `&` in its path. Restarting the Windows app resumed the same task and thread. Both rounds produced readable PDFs with the expected text, and the original manuscript stayed unchanged. Both turns inherited `auto_review` with `on-request` and the workspace-write sandbox; there were no manual approval requests. A separate harmless elevated print command also passed automatic review. These live checks used a real Codex, not a mock agent.

Agent authentication and provider API calls require the user's account and a working connection to the provider; these are separate from the offline launch and compilation checks. ARM64 and UNC network-share compilation have not been validated on hardware.
