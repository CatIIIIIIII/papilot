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
}:

let
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

  nativeBuildInputs = [ makeWrapper ];

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
  '';

  postInstall = ''
    npm --prefix engine prune --omit=dev --ignore-scripts
    cp -r engine/node_modules "$out/lib/node_modules/papilot/engine/"

    wrapProgram "$out/bin/papilot" \
      --prefix PATH : ${
        lib.makeBinPath [
          nodejs_24
          git
          which
          tex
        ]
      }
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    export PAPILOT_DATA="$TMPDIR/papilot-install-check"
    test "$("$out/bin/papilot" --version)" = "${(lib.importJSON ../package.json).version}"
    "$out/bin/papilot" doctor --json
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
