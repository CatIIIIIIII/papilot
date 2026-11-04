# Nix

The flake packages Papilot's CLI and browser interface, including the review engine. It provides Node.js 24, Git, `which` and full TeX Live. The first build or development shell may download several gigabytes of dependencies. Agent CLIs and their sign-ins are configured separately, as described in the [agent guide](guide.md#agents).

The flake exposes packages for `x86_64-linux`, `aarch64-linux` and `aarch64-darwin`. The package has been built and smoke-tested on `x86_64-linux`; the ARM outputs have been evaluated but still need native build and runtime validation. The pinned Nixpkgs no longer supports Intel macOS. Electron installers are built separately; see [Papilot Desktop](../desktop/README.md).

## Run or install

Use Nix with the `nix-command` and `flakes` experimental features enabled. From this checkout:

```sh
nix run . -- doctor
nix run . -- demo
```

Open <http://127.0.0.1:7274>. Other CLI arguments work as usual, for example `nix run . -- --port 7276 --data "$HOME/.papilot-nix"`.

To build without starting the server, or install into your Nix profile:

```sh
nix build
./result/bin/papilot --version
nix profile install .
```

The `default` and `papilot` package outputs are the same. The launcher adds its Node.js, Git and TeX Live to the front of `PATH`. Paper repositories and application data remain writable outside the Nix store. Papilot's default data directory is `~/.papilot`.

Papilot's in-app updater can activate npm-installed versions from its data directory. Use Nix to update if you want to keep running the Nix-built version; use a separate `--data` directory when an existing installation has already activated an in-app update.

## Develop

```sh
nix develop
npm ci
npm run setup:review
npm run build
npm run typecheck
npm test
npm start
```

The shell supplies the runtime libraries used by Vite's native npm dependencies on NixOS. It skips Electron and Playwright binary downloads; the commands above exercise the CLI and browser app. Entering the shell does not install npm dependencies or change the checkout.

## Maintain the flake

`flake.lock` pins Nixpkgs. Both npm dependency trees use the versions and integrity hashes in their existing `package-lock.json` files through [`importNpmLock`](https://nixos.org/manual/nixpkgs/unstable/#javascript-buildNpmPackage-importNpmLock); there are no separate npm hashes to update in the Nix expression.

Keep the source and all three lockfiles unchanged to reproduce the build inputs for a given system. Different architectures produce different outputs. To check whether rebuilding the package produces identical output, first build it normally, then rebuild offline against the dependencies already in the Nix store:

```sh
nix build --no-update-lock-file
nix build --no-update-lock-file --offline --rebuild --no-link
```

Nix's [`--rebuild`](https://nix.dev/manual/nix/stable/command-ref/new-cli/nix3-build.html) compares the rebuilt package with its existing store output. This checks the package, not the reproducibility of every dependency. `nix develop` pins the supplied tools, but commands run in your writable checkout and inherited environment. External agents, application data and in-app updates are outside the package's pinned inputs.

To update the Nixpkgs pin and check the flake:

```sh
nix flake update nixpkgs
nix fmt -- flake.nix nix/package.nix
nix flake check
```

`nix flake check` builds the package and checks the installed CLI's version and environment with `papilot doctor`. The build typechecks and bundles both web interfaces. Run the npm checks above when changing application code.

For a custom TeX selection in another Nix configuration, call `nix/package.nix` with a `tex` argument. For example, this provides a basic installation with the required command-line tools; add any further packages your manuscripts need:

```nix
pkgs.callPackage ./nix/package.nix {
  tex = pkgs.texliveBasic.withPackages (ps: [ ps.latexmk ps.synctex ]);
}
```

## Desktop and package management

On Linux the default flake package includes `papilot` and `papilot-desktop`,
plus a Papilot application menu entry. `.#papilot-cli` provides only the CLI
and browser interface; `.#papilot-desktop` provides the Electron launcher.
Darwin's default remains the CLI/browser package.

The desktop uses Nixpkgs Electron 45 and a separate Node 24 runtime. Chromium's
sandbox and renderer isolation stay enabled. User data remains writable in the
normal desktop data directory; application files stay in the Nix store.

Nix installations never install Codex or SDKs at runtime and never activate npm
or desktop update layers. Update through your Nix configuration or
`nix profile upgrade`. Agent CLIs are optional: install only the agents you use
and sign in separately. Explicit `PAPILOT_*_BIN` paths take priority; PATH and
user/system Nix profiles are searched before other known installation folders.
Wrapper executable paths are preserved.

The locked SDK runtime is in `nix/runtime`; it is built independently of the
application and review-engine npm trees. Linux native helpers are patched at
build time. The `checks.x86_64-linux.desktop-vm` check boots a NixOS desktop,
launches Papilot with a minimal PATH, and checks SQLite, PDF/SyncTeX compilation,
read-only store files and writable user data. ARM Linux runtime validation is
still required; evaluation is not a native execution test.

Real agent testing is deliberately opt-in and never runs in normal CI:
`PAPILOT_LIVE_AGENT=codex node --import tsx scripts/check-live-agent.mjs`.
The current harness also supports `claude`, verifies subscription authentication,
and refuses API-key/cloud-provider credentials. Results include protocol model
choices and are saved beside a disposable paper and isolated database.
