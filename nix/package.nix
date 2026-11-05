{
  lib,
  stdenv,
  buildNpmPackage,
  importNpmLock,
  nodejs_24,
  makeWrapper,
  git,
  which,
  texliveFull,
  tex ? texliveFull,
  autoPatchelfHook,
  openssl,
  zlib,
}:

let
  agentDeps = importNpmLock { npmRoot = ./runtime; };
  engineDeps = importNpmLock { npmRoot = ../engine; };
in
buildNpmPackage {
  pname = "papilot";
  version = (lib.importJSON ../package.json).version;
  nodejs = nodejs_24;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../bin
      ../src
      ../scripts
      ../skills
      ../desktop
      ../tests
      ../public
      ../examples
      ../vendor
      ../engine/src
      ../engine/scripts
      ../engine/examples
      ../engine/tests
      ../engine/package.json
      ../engine/package-lock.json
      ../engine/tsconfig.json
      ../engine/vite.config.ts
      ../engine/LICENSE
      ../package.json
      ../package-lock.json
      ../tsconfig.json
      ../vite.config.ts
      ../index.html
      ../LICENSE
      ../README.md
    ];
  };

  npmDeps = importNpmLock { npmRoot = ../.; };
  npmConfigHook = importNpmLock.npmConfigHook;
  npmRebuildFlags = [ "--ignore-scripts" ];
  # prepack would reinstall the engine and rebuild both frontends.
  npmPackFlags = [ "--ignore-scripts" ];
  npmPruneFlags = [ "--ignore-scripts" ];

  nativeBuildInputs = [ makeWrapper ] ++ lib.optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ];
  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [ stdenv.cc.cc.lib openssl zlib ];

  env = {
    ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
  }
  // lib.optionalAttrs stdenv.hostPlatform.isLinux {
    LD_LIBRARY_PATH = lib.makeLibraryPath [ stdenv.cc.cc.lib ];
  };

  preBuild = ''
    # The review engine has its own lockfile and must be present for the app's
    # typecheck and license collection, as well as at runtime.
    (
      npmDeps=${engineDeps}
      npmRoot=engine
      npmConfigHook
    )
    npm --prefix engine run build
    mkdir -p nix-agent-runtime
    cp ${./runtime/package.json} nix-agent-runtime/package.json
    cp ${./runtime/package-lock.json} nix-agent-runtime/package-lock.json
    (
      npmDeps=${agentDeps}
      npmRoot=nix-agent-runtime
      npmConfigHook
    )
    npm run desktop:compile
  '';

  postInstall = ''
    npm --prefix engine prune --omit=dev --ignore-scripts
    cp -r engine/node_modules "$out/lib/node_modules/papilot/engine/"
    cp -r nix-agent-runtime "$out/lib/node_modules/papilot/"
    # npm retains both optional Linux libc variants. Nixpkgs uses glibc;
    # the SDK selects the glibc helper and the musl copy must not be patched
    # with a glibc interpreter or shipped as an unusable alternate runtime.
    ${lib.optionalString stdenv.hostPlatform.isLinux ''
      rm -rf "$out/lib/node_modules/papilot/nix-agent-runtime/node_modules/@anthropic-ai/"*-musl
    ''}
    mkdir -p "$out/lib/node_modules/papilot/.desktop"
    cp -r .desktop/app "$out/lib/node_modules/papilot/.desktop/"
    cp -r desktop "$out/lib/node_modules/papilot/desktop"
    cat > "$out/lib/node_modules/papilot/.desktop/app/package.json" <<'EOF'
    {"name":"papilot-desktop","type":"module","main":"main.js"}
    EOF

    wrapProgram "$out/bin/papilot" \
      --set PAPILOT_INSTALL_METHOD nix \
      --prefix PATH : ${
        lib.makeBinPath [
          nodejs_24
          git
          which
          tex
        ]
      }
  '';

  passthru.runtimePath = lib.makeBinPath [ nodejs_24 git which tex ];

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    export PAPILOT_DATA="$TMPDIR/papilot-install-check"
    export PAPILOT_PORT=1
    # Exercise cold TeX binaries without doctor's short interactive timeout.
    # On Darwin the first execution can involve slow signature verification.
    ${tex}/bin/latexmk -v
    ${tex}/bin/synctex --version
    ${tex}/bin/pdflatex --version
    test "$("$out/bin/papilot" --version)" = "${(lib.importJSON ../package.json).version}"
    "$out/bin/papilot" doctor --json
    ${lib.optionalString stdenv.hostPlatform.isLinux ''
      "$out/lib/node_modules/papilot/nix-agent-runtime/node_modules/@anthropic-ai/claude-agent-sdk-linux-${if stdenv.hostPlatform.isAarch64 then "arm64" else "x64"}/claude" --version
    ''}
    runHook postInstallCheck
  '';

  meta = {
    description = "Local workspace for writing and revising LaTeX papers with AI agents";
    homepage = "https://papilot.ai";
    license = lib.licenses.mit;
    mainProgram = "papilot";
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
      "aarch64-darwin"
    ];
  };
}
